import { FormEvent, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth'
import { DEFAULT_CONFIG, PaperConfig, SheetKind } from '../utils/omr'
import { SCHOOL_LIMITS, autoPaperSize } from '../utils/sheetTemplates'

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

/** Danh sách đợt chấm phiếu giấy + tạo đợt mới */
export default function TeacherPaperGrading() {
  const { teacher } = useAuth()
  const navigate = useNavigate()
  const [batches, setBatches] = useState<BatchRow[]>([])
  const [classes, setClasses] = useState<ClassLite[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [title, setTitle] = useState('')
  const [classId, setClassId] = useState('')
  const [cfg, setCfg] = useState<PaperConfig>(DEFAULT_CONFIG)
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

  async function create(e: FormEvent) {
    e.preventDefault()
    setError('')
    const ints: (keyof PaperConfig)[] = ['n1', 'n2', 'n3']
    for (const k of ints) {
      const v = cfg[k] as number
      if (!Number.isInteger(v) || v < 0) return setError('Số câu mỗi phần phải là số nguyên không âm.')
    }
    if (cfg.sheet === 'school') {
      const L = SCHOOL_LIMITS
      if (cfg.n1 > L.n1 || cfg.n2 > L.n2 || cfg.n3 > L.n3)
        return setError(`Phiếu của trường có tối đa ${L.n1} câu Phần I, ${L.n2} câu Phần II, ${L.n3} câu Phần III.`)
    } else if (cfg.n1 > 50 || cfg.n2 > 10 || cfg.n3 > 20) return setError('Tối đa 50 câu Phần 1, 10 câu Phần 2, 20 câu Phần 3.')
    if (cfg.n1 + cfg.n2 + cfg.n3 === 0) return setError('Đề phải có ít nhất 1 câu.')
    for (const k of ['p1', 'p2', 'p3'] as (keyof PaperConfig)[]) {
      const v = cfg[k] as number
      if (!Number.isFinite(v) || v < 0) return setError('Điểm mỗi câu phải là số không âm.')
    }
    // Phiếu trường: nhận diện bằng phách; phiếu lớp: bằng họ tên, khổ giấy chọn tự động theo số câu
    const finalCfg: PaperConfig =
      cfg.sheet === 'school'
        ? { ...cfg, identity: 'phach', paper: undefined }
        : { ...cfg, sheet: 'class', identity: 'name', paper: autoPaperSize(cfg) }
    setSaving(true)
    const { data, error: err } = await supabase
      .from('paper_batches')
      .insert({ title: title.trim(), class_id: classId || null, config: finalCfg, teacher_id: teacher!.id })
      .select('id')
      .single()
    setSaving(false)
    if (err) return setError(err.message)
    navigate(`/cham-phieu/${data.id}`)
  }

  async function remove(b: BatchRow) {
    if (!confirm(`Xoá đợt chấm "${b.title}" cùng toàn bộ đáp án và phiếu đã chấm?`)) return
    const { error: err } = await supabase.from('paper_batches').delete().eq('id', b.id)
    if (err) return alert(err.message)
    load()
  }

  const max = cfg.n1 * cfg.p1 + cfg.n2 * cfg.p2 + cfg.n3 * cfg.p3

  return (
    <div className="container">
      <h1>📷 Chấm phiếu trả lời giấy</h1>
      <p style={{ color: 'var(--muted)' }}>
        Chụp ảnh, scan (PDF) hoặc bật camera để chấm phiếu tô ô. Phần I, II đọc ô tô bằng xử lý ảnh (không đoán); mã đề, phách, họ
        tên và đáp số Phần III viết tay do AI đọc 2 lần đối chiếu. Ô nào chưa chắc đều tô vàng để cô quyết.
      </p>

      <div className="card">
        <h2>Tạo đợt chấm mới</h2>
        <form onSubmit={create}>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ flex: 2, minWidth: 220 }}>
              <label>Tên đợt chấm</label>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="VD: Kiểm tra giữa kì I – 12A1" required />
            </div>
            <div style={{ flex: 1, minWidth: 180 }}>
              <label>{cfg.sheet === 'school' ? 'Lớp (không bắt buộc)' : 'Lớp (để máy khớp họ tên)'}</label>
              <select value={classId} onChange={(e) => setClassId(e.target.value)}>
                <option value="">— Không gắn lớp —</option>
                {classes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.class_name}
                  </option>
                ))}
              </select>
              {!classes.length && cfg.sheet === 'class' && (
                <p style={{ fontSize: 12.5, margin: '-8px 0 8px' }}>
                  Chưa có lớp — thêm ở <Link to="/cham-phieu/lop">Lớp &amp; học sinh</Link> để máy tự khớp họ tên.
                </p>
              )}
            </div>
          </div>

          <label>Loại phiếu trả lời</label>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
            {(
              [
                ['class', '📝 Phiếu tô ô do web tạo', 'Bài kiểm tra tại lớp: đúng số câu của đề, có Họ tên – STT – Lớp – Mã đề. In từ trang đợt chấm.'],
                ['school', '🏫 Phiếu của trường (đã cắt phách)', 'Phiếu in sẵn 40 – 6 – 8 câu của trường; nhận diện bài bằng Mã phách + Số phách.'],
              ] as [SheetKind, string, string][]
            ).map(([k, label, desc]) => (
              <label
                key={k}
                style={{
                  flex: 1,
                  minWidth: 240,
                  margin: 0,
                  padding: '10px 12px',
                  borderRadius: 10,
                  cursor: 'pointer',
                  fontWeight: 400,
                  border: `2px solid ${cfg.sheet === k ? 'var(--primary)' : 'var(--border)'}`,
                  background: cfg.sheet === k ? 'var(--primary-light)' : 'transparent',
                }}
              >
                <input
                  type="radio"
                  name="sheet"
                  checked={cfg.sheet === k}
                  onChange={() =>
                    setCfg((c) =>
                      k === 'school'
                        ? { ...c, sheet: k, n1: Math.min(c.n1, SCHOOL_LIMITS.n1), n2: Math.min(c.n2, SCHOOL_LIMITS.n2), n3: Math.min(c.n3, SCHOOL_LIMITS.n3) }
                        : { ...c, sheet: k },
                    )
                  }
                  style={{ width: 'auto', margin: '0 6px 0 0' }}
                />
                <b>{label}</b>
                <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>{desc}</div>
              </label>
            ))}
          </div>
          {cfg.sheet === 'class' && (
            <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 6px' }}>
              Khổ phiếu: {autoPaperSize(cfg) === 'A5' ? 'nửa trang A4 (in 2 phiếu/tờ, cắt đôi)' : 'cả trang A4'} — tự chọn theo số câu.
            </p>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginTop: 4 }}>
            <div>
              <label>Phần 1 – số câu</label>
              <input type="number" min={0} value={cfg.n1} onChange={(e) => num('n1', e.target.value)} />
            </div>
            <div>
              <label>Phần 1 – điểm/câu</label>
              <input type="number" step="0.05" min={0} value={cfg.p1} onChange={(e) => num('p1', e.target.value)} />
            </div>
            <div>
              <label>Phần 2 – số câu</label>
              <input type="number" min={0} value={cfg.n2} onChange={(e) => num('n2', e.target.value)} />
            </div>
            <div>
              <label>Phần 2 – điểm tối đa/câu</label>
              <input type="number" step="0.05" min={0} value={cfg.p2} onChange={(e) => num('p2', e.target.value)} />
            </div>
            <div>
              <label>Phần 3 – số câu</label>
              <input type="number" min={0} value={cfg.n3} onChange={(e) => num('n3', e.target.value)} />
            </div>
            <div>
              <label>Phần 3 – điểm/câu</label>
              <input type="number" step="0.05" min={0} value={cfg.p3} onChange={(e) => num('p3', e.target.value)} />
            </div>
          </div>
          <label>Cách tính điểm Phần 2</label>
          <select value={cfg.tfMethod} onChange={(e) => setCfg((c) => ({ ...c, tfMethod: e.target.value as PaperConfig['tfMethod'] }))}>
            <option value="ministry_partial">Theo Bộ GDĐT: đúng 1 ý = 10%, 2 ý = 25%, 3 ý = 50%, 4 ý = 100% điểm câu</option>
            <option value="equal_split">Chia đều: mỗi ý đúng = 25% điểm câu</option>
          </select>
          <p style={{ margin: '6px 0 12px' }}>
            Tổng điểm tối đa: <b>{Math.round(max * 100) / 100}</b>
            {Math.abs(max - 10) > 1e-9 && <span className="badge warn" style={{ marginLeft: 8 }}>Chưa phải thang 10</span>}
          </p>
          <button className="btn" type="submit" disabled={saving}>
            {saving ? 'Đang tạo…' : 'Tạo đợt chấm'}
          </button>
        </form>
        {error && <p style={{ color: 'var(--danger)', whiteSpace: 'pre-line' }}>{error}</p>}
      </div>

      <div className="card">
        <h2>Các đợt chấm</h2>
        {loading ? (
          <p>Đang tải…</p>
        ) : (
          <table className="list">
            <thead>
              <tr>
                <th>Tên đợt</th>
                <th>Lớp</th>
                <th>Phiếu</th>
                <th>Cấu trúc</th>
                <th>Ngày tạo</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {batches.map((b) => (
                <tr key={b.id}>
                  <td>
                    <Link to={`/cham-phieu/${b.id}`}>{b.title}</Link>
                  </td>
                  <td>{classes.find((c) => c.id === b.class_id)?.class_name || '—'}</td>
                  <td>{b.config.sheet === 'school' ? 'Trường (phách)' : b.config.sheet === 'class' ? 'Tô ô – lớp' : 'Viết tay (cũ)'}</td>
                  <td>
                    {b.config.n1} – {b.config.n2} – {b.config.n3}
                  </td>
                  <td>{new Date(b.created_at).toLocaleDateString('vi-VN')}</td>
                  <td>
                    <Link to={`/cham-phieu/${b.id}`} style={{ marginRight: 12 }}>
                      Mở →
                    </Link>
                    <button className="btn danger" style={{ padding: '3px 10px', fontSize: 12 }} onClick={() => remove(b)}>
                      Xoá
                    </button>
                  </td>
                </tr>
              ))}
              {batches.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ color: 'var(--muted)' }}>
                    Chưa có đợt chấm nào.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
