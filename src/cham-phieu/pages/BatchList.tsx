import { FormEvent, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth'
import { DEFAULT_CONFIG, PaperConfig, SheetKind } from '../utils/omr'
import { GRID35_LIMITS, P3_GRID_MAX, SCHOOL_LIMITS, describeClassPaper, fitsA4, fitsHalfA4 } from '../utils/sheetTemplates'
import { downloadSheetPdf, openPrintSheets, sheetPreviewSvg } from '../utils/printSheets'

interface BatchRow {
  id: string
  title: string
  class_id: string | null
  config: PaperConfig
  created_at: string
}

interface ClassLite {
  id: string
  class_name: string
}

const SHEETS: [SheetKind, string, string, string][] = [
  ['class', '📝', 'Phiếu tô ô do web tạo', 'Bài kiểm tra tại lớp: đúng số câu của đề, có Họ tên – STT – Lớp – Mã đề. Tải / in phiếu ngay bên dưới.'],
  ['school', '🏫', 'Phiếu của trường (đã cắt phách)', 'Phiếu in sẵn 40 – 6 – 8 câu của trường; nhận diện bài bằng Mã phách + Số phách.'],
  ['grid35', '🔤', 'Phiếu 35 câu (chữ A B C D trong ô)', 'Phiếu in sẵn 35 câu, 4 cột, không có ô vuông đen; có Mã đề thi + Mã phách. Chỉ chấm trắc nghiệm.'],
]

const sheetLabel = (c: PaperConfig) =>
  c.sheet === 'school'
    ? c.parts === 'p12'
      ? 'Trường · P1+P2'
      : 'Trường (phách)'
    : c.sheet === 'grid35'
      ? '35 câu (phách)'
      : c.sheet === 'class'
        ? c.paper === 'A5'
          ? 'Web tạo · ½ A4'
          : 'Web tạo · 1 trang A4'
        : 'Viết tay (cũ)'

/** Cấu hình thực sự sẽ lưu khi tạo đợt */
function finalConfig(cfg: PaperConfig): PaperConfig {
  if (cfg.sheet === 'school') {
    const p12 = cfg.parts === 'p12'
    // phiếu trường in sẵn: Phần III vẫn là dòng viết tay (AI đọc) — không dùng lưới tô
    return { ...cfg, identity: 'phach', paper: undefined, bigBubbles: undefined, parts: p12 ? 'p12' : 'all', n3: p12 ? 0 : cfg.n3, p3Mode: undefined }
  }
  if (cfg.sheet === 'grid35') return { ...cfg, identity: 'phach', paper: undefined, bigBubbles: undefined, parts: undefined, p3Mode: undefined }
  // phiếu lớp do web tạo (đợt chấm mới): Phần III luôn là lưới tô ô chuẩn Bộ GD&ĐT
  const c: PaperConfig = { ...cfg, p3Mode: 'bubble' }
  const half = c.paper === 'A5' && fitsHalfA4(c)
  return { ...c, sheet: 'class', identity: 'name', paper: half ? 'A5' : 'A4', bigBubbles: !half, parts: undefined }
}

/** Danh sách đợt chấm phiếu giấy + tạo đợt mới */
export default function TeacherPaperGrading() {
  const { teacher } = useAuth()
  const navigate = useNavigate()
  const [batches, setBatches] = useState<BatchRow[]>([])
  const [classes, setClasses] = useState<ClassLite[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [pdfBusy, setPdfBusy] = useState('')

  const [title, setTitle] = useState('')
  const [classId, setClassId] = useState('')
  const [cfg, setCfg] = useState<PaperConfig>(() => ({
    ...DEFAULT_CONFIG,
    paper: fitsHalfA4(DEFAULT_CONFIG) ? 'A5' : 'A4',
    parts: 'all',
  }))
  const [saving, setSaving] = useState(false)

  async function load() {
    if (!teacher) return
    setLoading(true)
    const [b, c] = await Promise.all([
      supabase.from('paper_batches').select('id, title, class_id, config, created_at').order('created_at', { ascending: false }),
      supabase.from('classes').select('id, class_name').eq('teacher_id', teacher.id).order('class_name'),
    ])
    if (b.error) setError(b.error.message.includes('paper_batches') ? 'Chưa tạo bảng dữ liệu: hãy chạy file supabase/schema_cham_phieu.sql trong Supabase.' : b.error.message)
    setBatches((b.data as BatchRow[]) || [])
    setClasses((c.data as ClassLite[]) || [])
    setLoading(false)
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teacher])

  const num = (k: keyof PaperConfig, v: string) => setCfg((c) => ({ ...c, [k]: Number(v) }))

  const half = fitsHalfA4(cfg)
  // đề dài ra không còn vừa nửa trang -> tự chuyển sang 1 trang (và báo)
  useEffect(() => {
    if (cfg.sheet === 'class' && cfg.paper === 'A5' && !half) setCfg((c) => ({ ...c, paper: 'A4' }))
  }, [half, cfg.sheet, cfg.paper])

  const fin = useMemo(() => finalConfig(cfg), [cfg])
  const p12 = cfg.sheet === 'school' && cfg.parts === 'p12'
  const max = fin.n1 * fin.p1 + fin.n2 * fin.p2 + fin.n3 * fin.p3
  const counts = { n1: fin.n1, n2: fin.n2, n3: fin.n3, p3Mode: fin.p3Mode }
  const p3Grid = cfg.sheet === 'class' && fin.n3 > 0
  const countsOk = [fin.n1, fin.n2, fin.n3].every((v) => Number.isInteger(v) && v >= 0) && fin.n1 <= 50 && fin.n2 <= 10 && fin.n3 <= 20
  const preview = useMemo(
    () => (cfg.sheet === 'class' && countsOk && fin.n1 + fin.n2 + fin.n3 > 0 ? sheetPreviewSvg(fin) : ''),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cfg.sheet, fin.n1, fin.n2, fin.n3, fin.paper, fin.bigBubbles, fin.p3Mode, countsOk],
  )

  function validate(): string {
    for (const k of ['n1', 'n2', 'n3'] as (keyof PaperConfig)[]) {
      const v = cfg[k] as number
      if (!Number.isInteger(v) || v < 0) return 'Số câu mỗi phần phải là số nguyên không âm.'
    }
    if (cfg.sheet === 'school') {
      const L = SCHOOL_LIMITS
      if (fin.n1 > L.n1 || fin.n2 > L.n2 || fin.n3 > L.n3)
        return `Phiếu của trường có tối đa ${L.n1} câu Phần I, ${L.n2} câu Phần II, ${L.n3} câu Phần III.`
    } else if (cfg.sheet === 'grid35') {
      if (cfg.n1 > GRID35_LIMITS.n1 || cfg.n2 || cfg.n3)
        return `Phiếu 35 câu chỉ có phần trắc nghiệm A–D: tối đa ${GRID35_LIMITS.n1} câu Phần 1, Phần 2 và Phần 3 phải bằng 0.`
    } else if (cfg.n1 > 50 || cfg.n2 > 10 || cfg.n3 > 20) return 'Tối đa 50 câu Phần 1, 10 câu Phần 2, 20 câu Phần 3.'
    else if (cfg.n3 > P3_GRID_MAX) return `Phiếu web tạo: Phần III (lưới tô ô) tối đa ${P3_GRID_MAX} câu.`
    else if (!fitsA4(fin)) return 'Đề quá dài, phiếu không vừa 1 trang A4 — hãy giảm số câu.'
    if (fin.n1 + fin.n2 + fin.n3 === 0) return p12 ? 'Phần I và Phần II phải có ít nhất 1 câu.' : 'Đề phải có ít nhất 1 câu.'
    for (const k of ['p1', 'p2', 'p3'] as (keyof PaperConfig)[]) {
      const v = cfg[k] as number
      if (!Number.isFinite(v) || v < 0) return 'Điểm mỗi câu phải là số không âm.'
    }
    return ''
  }

  async function create(e: FormEvent) {
    e.preventDefault()
    setError('')
    const err = validate()
    if (err) return setError(err)
    setSaving(true)
    const { data, error: dbErr } = await supabase
      .from('paper_batches')
      .insert({ title: title.trim(), class_id: classId || null, config: fin, teacher_id: teacher!.id })
      .select('id')
      .single()
    setSaving(false)
    if (dbErr) return setError(dbErr.message)
    navigate(`/cham-phieu/${data.id}`)
  }

  async function pdf(c: PaperConfig, t: string, key: string) {
    setPdfBusy(key)
    try {
      await downloadSheetPdf(c, t || 'Phiếu trả lời')
    } catch (e) {
      alert((e as Error).message)
    } finally {
      setPdfBusy('')
    }
  }

  async function remove(b: BatchRow) {
    if (!confirm(`Xoá đợt chấm "${b.title}" cùng toàn bộ đáp án và phiếu đã chấm?`)) return
    const { error: err } = await supabase.from('paper_batches').delete().eq('id', b.id)
    if (err) return alert(err.message)
    load()
  }

  const pickSheet = (k: SheetKind) =>
    setCfg((c) =>
      k === 'school'
        ? { ...c, sheet: k, n1: Math.min(c.n1, SCHOOL_LIMITS.n1), n2: Math.min(c.n2, SCHOOL_LIMITS.n2), n3: Math.min(c.n3, SCHOOL_LIMITS.n3) }
        : k === 'grid35'
          ? { ...c, sheet: k, n1: GRID35_LIMITS.n1, n2: 0, n3: 0, p1: 0.2 }
          : { ...c, sheet: k, n2: c.sheet === 'grid35' ? DEFAULT_CONFIG.n2 : c.n2, n3: c.sheet === 'grid35' ? DEFAULT_CONFIG.n3 : c.n3 },
    )

  return (
    <div className="container">
      <div className="page-head">
        <div>
          <h1>📷 Chấm phiếu trả lời</h1>
          <p className="sub">
            Chụp ảnh, scan (PDF) hoặc bật camera để chấm phiếu tô ô. Phần I, II đọc ô tô bằng xử lý ảnh (không đoán); mã đề, phách, họ tên
            và đáp số Phần III viết tay do AI đọc 2 lần đối chiếu. Ô nào chưa chắc đều tô vàng để cô quyết.
          </p>
        </div>
      </div>

      <form className="card" onSubmit={create}>
        <div className="card-title">
          <span className="num">+</span>
          <h2>Tạo đợt chấm mới</h2>
        </div>

        {/* BƯỚC 1 */}
        <div className="section">
          <div className="section-title">
            <span className="num">1</span> Thông tin chung
          </div>
          <div className="row">
            <div style={{ flex: 2 }}>
              <label>Tên đợt chấm</label>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="VD: Kiểm tra giữa kì I – 12A1" required />
            </div>
            <div>
              <label>{cfg.sheet === 'class' ? 'Lớp (để máy khớp họ tên)' : 'Lớp (không bắt buộc)'}</label>
              <select value={classId} onChange={(e) => setClassId(e.target.value)}>
                <option value="">— Không gắn lớp —</option>
                {classes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.class_name}
                  </option>
                ))}
              </select>
              {!classes.length && cfg.sheet === 'class' && (
                <p className="small" style={{ margin: '-8px 0 8px' }}>
                  Chưa có lớp — thêm ở <Link to="/cham-phieu/lop">Lớp &amp; học sinh</Link> để máy tự khớp họ tên.
                </p>
              )}
            </div>
          </div>
        </div>

        {/* BƯỚC 2 */}
        <div className="section">
          <div className="section-title">
            <span className="num">2</span> Loại phiếu {cfg.sheet === 'class' ? '& khổ giấy' : cfg.sheet === 'school' ? '& phạm vi chấm' : ''}
          </div>
          <div className="choice-grid">
            {SHEETS.map(([k, ico, label, desc]) => (
              <label key={k} className={`choice ${cfg.sheet === k ? 'on' : ''}`}>
                <input type="radio" name="sheet" checked={cfg.sheet === k} onChange={() => pickSheet(k)} />
                <span className="ico">{ico}</span>
                <span>
                  <span className="t">{label}</span>
                  <span className="d">{desc}</span>
                </span>
                <span className="tick">✓</span>
              </label>
            ))}
          </div>

          {cfg.sheet === 'class' && (
            <div className="print-box">
              <div>
                <label>Khổ phiếu</label>
                <div className="choice-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))' }}>
                  <label className={`choice mini ${cfg.paper === 'A5' ? 'on' : ''} ${half ? '' : 'disabled'}`} title={half ? '' : p3Grid ? 'Phần III lưới tô cần 1 trang A4' : 'Đề quá dài, không vừa nửa trang A4'}>
                    <input type="radio" name="paper" disabled={!half} checked={cfg.paper === 'A5'} onChange={() => setCfg((c) => ({ ...c, paper: 'A5' }))} />
                    <span className="ico">✂️</span>
                    <span>
                      <span className="t">Nửa trang A4</span>
                      <span className="d">{half ? 'In 2 phiếu/tờ A4 rồi cắt đôi — tiết kiệm giấy.' : p3Grid ? 'Chỉ dùng khi đề không có Phần III (lưới tô cần 1 trang A4).' : 'Đề quá dài, không vừa nửa trang.'}</span>
                    </span>
                    <span className="tick">✓</span>
                  </label>
                  <label className={`choice mini ${cfg.paper !== 'A5' ? 'on' : ''}`}>
                    <input type="radio" name="paper" checked={cfg.paper !== 'A5'} onChange={() => setCfg((c) => ({ ...c, paper: 'A4' }))} />
                    <span className="ico">📄</span>
                    <span>
                      <span className="t">1 trang A4</span>
                      <span className="d">1 phiếu/tờ, ô tô lớn, rộng rãi, dễ nhìn.</span>
                    </span>
                    <span className="tick">✓</span>
                  </label>
                </div>
                <p className="small muted" style={{ margin: '0 0 10px' }}>
                  Phiếu sẽ in: <b>{describeClassPaper(counts, fin.paper, fin.bigBubbles)}</b>. Máy quét dùng đúng bố cục này nên phiếu in ra
                  luôn khớp. Có thể tải phiếu ngay bây giờ hoặc ở trang đợt chấm.
                </p>
                {p3Grid && (
                  <p className="p3-note">
                    <b>Phần III – lưới tô ô chuẩn Bộ GD&amp;ĐT:</b> mỗi câu 4 cột, mỗi cột tô một ô (dấu −, dấu phẩy hoặc chữ số 0–9), ghép từ
                    trái sang phải; ô vuông trên cùng chỉ để ghi nháp. Máy đọc cả Phần III bằng xử lý ảnh (không đọc chữ viết tay). Tô 2 ô
                    trong một cột tính sai. Đáp án Phần III phải tô được trên lưới (tối đa 4 ký tự, VD −1,5; 0,25; 2026).
                  </p>
                )}
                <div className="toolbar">
                  <button type="button" className="btn accent" disabled={!preview || pdfBusy === 'new'} onClick={() => pdf(fin, title, 'new')}>
                    <span className="ico">⬇</span> {pdfBusy === 'new' ? 'Đang tạo PDF…' : 'Tải phiếu (PDF)'}
                  </button>
                  <button type="button" className="btn secondary" disabled={!preview} onClick={() => openPrintSheets(fin, title || 'Phiếu trả lời')}>
                    <span className="ico">🖨</span> In phiếu
                  </button>
                </div>
              </div>
              <div className="sheet-preview">
                <p className="small muted" style={{ margin: '0 0 6px', textAlign: 'center' }}>
                  Xem trước {fin.paper === 'A5' ? '(1 trong 2 phiếu trên tờ A4)' : ''}
                </p>
                {preview ? (
                  <div className={`paper ${fin.paper === 'A5' ? '' : 'a4'}`} dangerouslySetInnerHTML={{ __html: preview }} />
                ) : (
                  <p className="small muted" style={{ textAlign: 'center' }}>
                    Nhập số câu hợp lệ để xem trước.
                  </p>
                )}
              </div>
            </div>
          )}

          {cfg.sheet === 'school' && (
            <>
              <label>Phạm vi chấm</label>
              <div className="choice-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
                <label className={`choice mini ${p12 ? 'on' : ''}`}>
                  <input type="radio" name="parts" checked={p12} onChange={() => setCfg((c) => ({ ...c, parts: 'p12' }))} />
                  <span className="ico">Ⅰ Ⅱ</span>
                  <span>
                    <span className="t">Chỉ chấm Phần I và Phần II</span>
                    <span className="d">Bỏ qua hoàn toàn Phần III: không đọc, không báo trống, không tính điểm.</span>
                  </span>
                  <span className="tick">✓</span>
                </label>
                <label className={`choice mini ${!p12 ? 'on' : ''}`}>
                  <input type="radio" name="parts" checked={!p12} onChange={() => setCfg((c) => ({ ...c, parts: 'all', n3: c.n3 || 6 }))} />
                  <span className="ico">Ⅰ Ⅱ Ⅲ</span>
                  <span>
                    <span className="t">Chấm cả 3 phần</span>
                    <span className="d">Phần III (trả lời ngắn) viết tay, AI đọc 2 lần đối chiếu.</span>
                  </span>
                  <span className="tick">✓</span>
                </label>
              </div>
            </>
          )}
        </div>

        {/* BƯỚC 3 */}
        <div className="section">
          <div className="section-title">
            <span className="num">3</span> Cấu trúc đề & thang điểm
          </div>
          <div className="field-grid">
            <div>
              <label>Phần I – số câu</label>
              <input type="number" min={0} value={cfg.n1} onChange={(e) => num('n1', e.target.value)} />
            </div>
            <div>
              <label>Phần I – điểm/câu</label>
              <input type="number" step="0.05" min={0} value={cfg.p1} onChange={(e) => num('p1', e.target.value)} />
            </div>
            <div>
              <label>Phần II – số câu</label>
              <input type="number" min={0} value={cfg.n2} disabled={cfg.sheet === 'grid35'} onChange={(e) => num('n2', e.target.value)} />
            </div>
            <div>
              <label>Phần II – điểm/câu</label>
              <input type="number" step="0.05" min={0} value={cfg.p2} disabled={cfg.sheet === 'grid35'} onChange={(e) => num('p2', e.target.value)} />
            </div>
            {!p12 ? (
              <>
                <div>
                  <label>Phần III – số câu</label>
                  <input type="number" min={0} value={cfg.n3} disabled={cfg.sheet === 'grid35'} onChange={(e) => num('n3', e.target.value)} />
                </div>
                <div>
                  <label>Phần III – điểm/câu</label>
                  <input type="number" step="0.05" min={0} value={cfg.p3} disabled={cfg.sheet === 'grid35'} onChange={(e) => num('p3', e.target.value)} />
                </div>
              </>
            ) : (
              <div style={{ gridColumn: 'span 2', alignSelf: 'center' }}>
                <span className="badge gray">Phần III: không chấm</span>
              </div>
            )}
          </div>
          {cfg.n2 > 0 && cfg.sheet !== 'grid35' && (
            <>
              <label>Cách tính điểm Phần II</label>
              <select value={cfg.tfMethod} onChange={(e) => setCfg((c) => ({ ...c, tfMethod: e.target.value as PaperConfig['tfMethod'] }))}>
                <option value="ministry_partial">Theo Bộ GDĐT: đúng 1 ý = 10%, 2 ý = 25%, 3 ý = 50%, 4 ý = 100% điểm câu</option>
                <option value="equal_split">Chia đều: mỗi ý đúng = 25% điểm câu</option>
              </select>
            </>
          )}
          <div className="toolbar" style={{ justifyContent: 'space-between' }}>
            <span>
              Tổng điểm tối đa: <b style={{ fontSize: 18, color: 'var(--primary-dark)' }}>{Math.round(max * 100) / 100}</b>
              {Math.abs(max - 10) > 1e-9 ? (
                <span className="badge warn" style={{ marginLeft: 8 }}>
                  Chưa phải thang 10
                </span>
              ) : (
                <span className="badge ok" style={{ marginLeft: 8 }}>
                  ✓ Thang 10
                </span>
              )}
            </span>
            <button className="btn lg" type="submit" disabled={saving}>
              {saving ? 'Đang tạo…' : 'Tạo đợt chấm →'}
            </button>
          </div>
        </div>
        {error && <div className="notice err">{error}</div>}
      </form>

      <div className="card">
        <div className="card-title">
          <h2>Các đợt chấm</h2>
          <span className="badge gray">{batches.length}</span>
        </div>
        {loading ? (
          <p>Đang tải…</p>
        ) : (
          <div className="table-wrap">
            <table className="list">
              <thead>
                <tr>
                  <th>Tên đợt</th>
                  <th className="hide-sm">Lớp</th>
                  <th>Phiếu</th>
                  <th className="hide-sm">Cấu trúc</th>
                  <th className="hide-sm">Ngày tạo</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {batches.map((b) => (
                  <tr key={b.id}>
                    <td>
                      <Link to={`/cham-phieu/${b.id}`}>{b.title}</Link>
                    </td>
                    <td className="hide-sm">{classes.find((c) => c.id === b.class_id)?.class_name || '—'}</td>
                    <td>
                      <span className="badge gray">{sheetLabel(b.config)}</span>
                    </td>
                    <td className="hide-sm">
                      {b.config.n1} – {b.config.n2} – {b.config.parts === 'p12' ? '✕' : b.config.n3}
                    </td>
                    <td className="hide-sm">{new Date(b.created_at).toLocaleDateString('vi-VN')}</td>
                    <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                      {b.config.sheet === 'class' && (
                        <button
                          className="btn ghost sm"
                          title="Tải mẫu phiếu (PDF)"
                          disabled={pdfBusy === b.id}
                          onClick={() => pdf(b.config, b.title, b.id)}
                        >
                          {pdfBusy === b.id ? '…' : '⬇ Phiếu'}
                        </button>
                      )}
                      <Link className="btn secondary sm" to={`/cham-phieu/${b.id}`} style={{ margin: '0 6px' }}>
                        Mở →
                      </Link>
                      <button className="btn danger soft sm" onClick={() => remove(b)}>
                        Xoá
                      </button>
                    </td>
                  </tr>
                ))}
                {batches.length === 0 && (
                  <tr>
                    <td colSpan={6} className="muted">
                      Chưa có đợt chấm nào.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
