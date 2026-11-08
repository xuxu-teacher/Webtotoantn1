import { ChangeEvent, Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import * as XLSX from 'xlsx'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth'
import CameraCapture from '../components/CameraCapture'
import PaperAnswerGrid from '../components/PaperAnswerGrid'
import {
  CellId,
  NameMatch,
  PaperAnswers,
  PaperConfig,
  PartScores,
  ReadResult,
  StudentLite,
  TF_KEYS,
  answersToText,
  emptyAnswers,
  filesToImages,
  fitAnswers,
  invalidShortKeys,
  isBubbleSheet,
  KeyTableItem,
  matchStudent,
  missingKeyCells,
  nameSimilarity,
  normMaPhach,
  normSoPhach,
  pdfFileToPages,
  KeyPage,
  readBubbleSheet,
  readKeyTable,
  readSheet,
  scorePaper,
  stripVN,
  tfLabel,
} from '../utils/omr'
import { openPrintSheets } from '../utils/printSheets'
import { SCHOOL_LIMITS, autoPaperSize } from '../utils/sheetTemplates'

// ---------------- KIỂU DỮ LIỆU TRANG ----------------

interface Batch {
  id: string
  title: string
  class_id: string | null
  config: PaperConfig
}

interface KeyRow {
  id: string
  ma_de: string
  answers: PaperAnswers
}

interface SheetRow {
  id: string
  student_id: string | null
  student_name: string
  name_read: string | null
  class_label: string | null
  ma_de: string
  answers: PaperAnswers
  score: number
  part_scores: Omit<PartScores, 'correct'>
  edited_cells: CellId[]
  ai_model: string | null
  created_at: string
  ma_phach?: string | null
  so_phach?: string | null
  stt?: string | null
}

type ItemStatus = 'waiting' | 'reading' | 'review' | 'saved' | 'error'

/** Một phiếu trong hàng đợi chấm (chưa lưu hoặc vừa lưu) */
interface QueueItem {
  uid: string
  label: string
  dataUrl: string
  status: ItemStatus
  error?: string
  read?: ReadResult
  answers?: PaperAnswers
  flags: Record<CellId, string>
  match?: NameMatch
  studentId: string // '' = chưa chọn, '__other' = không có trong danh sách
  studentName: string
  maDe: string
  maPhach: string
  soPhach: string
  savedId?: string
}

/** Phiếu đáp án đang soạn (thêm mới hoặc sửa) */
interface KeyDraft {
  id?: string
  maDe: string
  answers: PaperAnswers
  flags: Record<CellId, string>
  dataUrl?: string
  /** ảnh các trang bảng đáp án (đáp án đọc bằng AI) — để đối chiếu */
  sources?: string[]
  reading: boolean
  error: string
}

/** Mở ảnh (data URL) sang tab mới — trình duyệt chặn mở thẳng "data:", nên đổi sang blob URL */
function openImage(e: { preventDefault: () => void }, dataUrl: string | undefined) {
  e.preventDefault()
  if (!dataUrl) return
  const w = window.open('', '_blank')
  fetch(dataUrl)
    .then((r) => r.blob())
    .then((b) => {
      const url = URL.createObjectURL(b)
      if (w) w.location.href = url
      else window.open(url, '_blank')
    })
    .catch(() => w?.close())
}

let uidSeq = 0
const newUid = () => `${Date.now()}-${++uidSeq}`

/** Sắp xếp theo tên riêng (từ cuối) rồi họ đệm, kiểu sổ điểm Việt Nam */
function vnNameCompare(a: string, b: string) {
  const la = a.trim().split(/\s+/).pop() || ''
  const lb = b.trim().split(/\s+/).pop() || ''
  return la.localeCompare(lb, 'vi') || a.localeCompare(b, 'vi')
}

/** Ô khác nhau giữa AI đọc và kết quả cuối (để ghi nhận giáo viên đã sửa tay) */
function diffCells(a: PaperAnswers, b: PaperAnswers, cfg: PaperConfig): CellId[] {
  const out: CellId[] = []
  for (let i = 0; i < cfg.n1; i++) if ((a.p1[i] || null) !== (b.p1[i] || null)) out.push(`1.${i + 1}`)
  for (let i = 0; i < cfg.n2; i++)
    for (let j = 0; j < 4; j++) if ((a.p2[i]?.[j] ?? null) !== (b.p2[i]?.[j] ?? null)) out.push(`2.${i + 1}${TF_KEYS[j]}`)
  for (let i = 0; i < cfg.n3; i++) if ((a.p3[i] || null) !== (b.p3[i] || null)) out.push(`3.${i + 1}`)
  return out
}

/** Bỏ đánh dấu ở những ô vừa được giáo viên sửa */
function clearChangedFlags(prev: PaperAnswers, next: PaperAnswers, flags: Record<CellId, string>, cfg: PaperConfig) {
  const changed = diffCells(prev, next, cfg)
  if (!changed.length) return flags
  const f = { ...flags }
  for (const id of changed) delete f[id]
  return f
}

// ======================================================================

export default function TeacherPaperGradingDetail() {
  const { batchId } = useParams()
  const { teacher } = useAuth()
  const [batch, setBatch] = useState<Batch | null>(null)
  const [keys, setKeys] = useState<KeyRow[]>([])
  const [sheets, setSheets] = useState<SheetRow[]>([])
  const [roster, setRoster] = useState<StudentLite[]>([])
  const [loadError, setLoadError] = useState('')
  const [tab, setTab] = useState<'key' | 'grade' | 'result'>('key')
  const firstLoad = useRef(true)

  const cfg = batch?.config

  async function loadAll() {
    if (!batchId) return
    const { data: b, error } = await supabase.from('paper_batches').select('id, title, class_id, config').eq('id', batchId).single()
    if (error || !b) return setLoadError(error?.message || 'Không tìm thấy đợt chấm.')
    setBatch(b as Batch)
    const c = (b as Batch).config
    const [k, s, r] = await Promise.all([
      supabase.from('paper_keys').select('id, ma_de, answers').eq('batch_id', batchId).order('ma_de'),
      supabase
        .from('paper_sheets')
        .select('*')
        .eq('batch_id', batchId),
      (b as Batch).class_id
        ? supabase.from('students').select('id, full_name, student_code, stt').eq('class_id', (b as Batch).class_id).order('stt')
        : Promise.resolve({ data: [] as StudentLite[] }),
    ])
    const ks = ((k.data as KeyRow[]) || []).map((x) => ({ ...x, answers: fitAnswers(x.answers, c) }))
    setKeys(ks)
    setSheets(((s.data as SheetRow[]) || []).map((x) => ({ ...x, answers: fitAnswers(x.answers, c), score: Number(x.score) })))
    // giữ đúng thứ tự STT của danh sách lớp (STT trên phiếu dùng để xác nhận học sinh)
    setRoster((r.data as StudentLite[]) || [])
    // Lần mở đầu: đã có đáp án thì vào thẳng tab Chấm phiếu
    if (firstLoad.current && ks.length) setTab('grade')
    firstLoad.current = false
  }

  useEffect(() => {
    loadAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchId])

  if (loadError)
    return (
      <div className="container">
        <p style={{ color: 'var(--danger)' }}>{loadError}</p>
        <Link to="/cham-phieu">← Danh sách đợt chấm</Link>
      </div>
    )
  if (!batch || !cfg || !teacher)
    return (
      <div className="container">
        <p>Đang tải…</p>
      </div>
    )

  /** Chọn nhầm loại phiếu khi tạo đợt: đổi phiếu lớp <-> phiếu trường (đáp án giữ nguyên) */
  async function switchSheet() {
    if (!batch || !cfg) return
    const toSchool = cfg.sheet !== 'school'
    if (toSchool && (cfg.n1 > SCHOOL_LIMITS.n1 || cfg.n2 > SCHOOL_LIMITS.n2 || cfg.n3 > SCHOOL_LIMITS.n3))
      return alert(`Phiếu của trường chỉ có ${SCHOOL_LIMITS.n1} – ${SCHOOL_LIMITS.n2} – ${SCHOOL_LIMITS.n3} câu, đợt chấm này có ${cfg.n1} – ${cfg.n2} – ${cfg.n3} câu.`)
    if (sheets.length) return alert('Đợt chấm đã có phiếu được lưu nên không đổi loại phiếu được. Hãy tạo đợt chấm mới.')
    const next: PaperConfig = toSchool
      ? { ...cfg, sheet: 'school', identity: 'phach', paper: undefined }
      : { ...cfg, sheet: 'class', identity: 'name', paper: autoPaperSize(cfg) }
    const { error } = await supabase.from('paper_batches').update({ config: next }).eq('id', batch.id)
    if (error) return alert(error.message)
    await loadAll()
  }

  const tabBtn = (t: typeof tab, label: string) => (
    <button className={`btn ${tab === t ? '' : 'secondary'}`} onClick={() => setTab(t)}>
      {label}
    </button>
  )

  return (
    <div className="container" style={{ maxWidth: 1200 }}>
      <Link to="/cham-phieu">← Danh sách đợt chấm</Link>
      <h1 style={{ marginBottom: 4 }}>{batch.title}</h1>
      <p style={{ color: 'var(--muted)', marginTop: 0 }}>
        Phần 1: {cfg.n1} câu × {cfg.p1}đ · Phần 2: {cfg.n2} câu × {cfg.p2}đ (
        {cfg.tfMethod === 'ministry_partial' ? 'thang Bộ GDĐT' : 'chia đều'}) · Phần 3: {cfg.n3} câu × {cfg.p3}đ
        {cfg.identity !== 'phach' && !batch.class_id && ' · Không gắn lớp (không khớp được danh sách học sinh)'}
        <br />
        Phiếu:{' '}
        <b>
          {cfg.sheet === 'school'
            ? 'phiếu tô ô của trường — nhận diện bằng Mã phách + Số phách'
            : cfg.sheet === 'class'
              ? `phiếu tô ô do web tạo (${cfg.paper === 'A5' ? '2 phiếu/tờ A4' : '1 phiếu/tờ A4'})`
              : 'phiếu viết tay (kiểu cũ)'}
        </b>
        {cfg.sheet === 'class' && (
          <button className="btn secondary" style={{ padding: '3px 10px', fontSize: 12, marginLeft: 10 }} onClick={() => openPrintSheets(cfg, batch.title)}>
            🖨 In / tải PDF mẫu phiếu
          </button>
        )}
        {isBubbleSheet(cfg) && !sheets.length && (
          <button className="btn secondary" style={{ padding: '3px 10px', fontSize: 12, marginLeft: 10 }} onClick={switchSheet}>
            {cfg.sheet === 'school' ? '↔ Đổi sang phiếu lớp (web in)' : '↔ Đổi sang phiếu của trường'}
          </button>
        )}
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        {tabBtn('key', `1. Đáp án (${keys.length} mã đề)`)}
        {tabBtn('grade', '2. Chấm phiếu')}
        {tabBtn('result', `3. Kết quả (${sheets.length})`)}
      </div>

      {tab === 'key' && (
        <KeySection batchId={batch.id} teacherId={teacher.id} cfg={cfg} keys={keys} sheets={sheets} onChanged={loadAll} />
      )}
      {/* Giữ trang chấm luôn được gắn để không mất hàng đợi khi chuyển tab */}
      <div style={{ display: tab === 'grade' ? 'block' : 'none' }}>
        <GradeSection
          batchId={batch.id}
          teacherId={teacher.id}
          cfg={cfg}
          keys={keys}
          roster={roster}
          sheets={sheets}
          onSaved={loadAll}
          hasClass={!!batch.class_id}
        />
      </div>
      {tab === 'result' && <ResultSection batch={batch} cfg={cfg} keys={keys} sheets={sheets} roster={roster} onChanged={loadAll} />}
    </div>
  )
}

// ======================================================================
// 1. ĐÁP ÁN THEO MÃ ĐỀ
// ======================================================================

function KeySection(props: {
  batchId: string
  teacherId: string
  cfg: PaperConfig
  keys: KeyRow[]
  sheets: SheetRow[]
  onChanged: () => Promise<void>
}) {
  const { batchId, teacherId, cfg, keys, sheets, onChanged } = props
  const bubble = isBubbleSheet(cfg)
  const [draft, setDraft] = useState<KeyDraft | null>(null)
  const [pending, setPending] = useState<KeyTableItem[]>([]) // các mã đề đọc được từ bảng đáp án, chờ rà lần lượt
  const [camera, setCamera] = useState(false)
  const [saving, setSaving] = useState(false)
  const [tableMsg, setTableMsg] = useState('')
  const [pages, setPages] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const tableRef = useRef<HTMLInputElement>(null)

  function startNew() {
    setDraft({ maDe: '', answers: emptyAnswers(cfg), flags: {}, reading: false, error: '' })
  }

  async function readKeyImage(dataUrl: string) {
    setDraft((d) => (d ? { ...d, dataUrl, reading: true, error: '' } : d))
    try {
      // Đáp án quan trọng nhất -> luôn đọc 2 lần đối chiếu
      const r = bubble ? await readBubbleSheet(dataUrl, cfg, true) : await readSheet(dataUrl, cfg, 'key', true)
      const flags = { ...r.flags }
      // phiếu đáp án không cần họ tên / phách
      delete flags['name']
      delete flags['phach']
      setDraft((d) =>
        d ? { ...d, answers: r.answers, flags, maDe: d.maDe || r.maDe, reading: false, dataUrl: r.overlay || dataUrl } : d,
      )
    } catch (e) {
      setDraft((d) => (d ? { ...d, reading: false, error: (e as Error).message } : d))
    }
  }

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    try {
      const imgs = await filesToImages([f])
      if (imgs[0]) readKeyImage(imgs[0].dataUrl)
    } catch (err) {
      setDraft((d) => (d ? { ...d, error: (err as Error).message } : d))
    }
  }

  /** "1-3, 5" -> [1,2,3,5] */
  function parsePages(txt: string, max: number): number[] {
    const out = new Set<number>()
    for (const part of txt.split(/[,;\s]+/).filter(Boolean)) {
      const m = part.match(/^(\d+)(?:-(\d+))?$/)
      if (!m) continue
      const a = Number(m[1]),
        b = Number(m[2] || m[1])
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (i >= 1 && i <= max) out.add(i)
    }
    return [...out].sort((x, y) => x - y)
  }

  async function onTableFile(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    if (!files.length) return
    setTableMsg('Đang mở file…')
    try {
      let imgs: KeyPage[] = []
      for (const f of files) {
        if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) {
          // Bảng đáp án chữ nhỏ -> ảnh độ phân giải cao hơn phiếu; kèm lớp chữ của PDF (nếu có) để AI chép chính xác
          let pick = pages.trim() ? parsePages(pages, 999) : []
          if (!pick.length) {
            const head = await pdfFileToPages(f, 2800, [1])
            if (head.total > 6) {
              setTableMsg(`File có ${head.total} trang — hãy ghi số trang có bảng đáp án (VD: ${head.total}) vào ô "Trang" rồi chọn lại file.`)
              return
            }
            pick = Array.from({ length: head.total }, (_, i) => i + 1)
          }
          const got = await pdfFileToPages(f, 2800, pick)
          if (!got.pages.length) {
            setTableMsg(`File chỉ có ${got.total} trang — kiểm tra lại ô "Trang".`)
            return
          }
          imgs = imgs.concat(got.pages)
        } else imgs = imgs.concat((await filesToImages([f])).map((x) => ({ img: x.dataUrl })))
      }
      const found = await readKeyTable(imgs, cfg, (i) => setTableMsg(`Đang đọc bảng đáp án (2 lần đối chiếu) — trang ${i}/${imgs.length}…`))
      setTableMsg(
        `Đọc được ${found.length} mã đề: ${found.map((k) => k.maDe || '(không ghi mã)').join(', ')}. Rà từng mã đề rồi bấm Lưu.`,
      )
      const [first, ...rest] = found
      setPending(rest)
      openItem(first)
    } catch (err) {
      setTableMsg((err as Error).message)
    }
  }

  function openItem(it: KeyTableItem | undefined) {
    if (!it) return setDraft(null)
    const old = keys.find((k) => k.ma_de === it.maDe)
    setDraft({
      id: old?.id,
      maDe: it.maDe,
      answers: it.answers,
      flags: it.flags,
      sources: it.sources,
      reading: false,
      error: old ? `Mã đề ${it.maDe} đã có đáp án — lưu sẽ thay đáp án cũ.` : '',
    })
  }

  async function save() {
    if (!draft) return
    const maDe = draft.maDe.trim()
    const miss = missingKeyCells(draft.answers, cfg)
    const bad = invalidShortKeys(draft.answers)
    const errs: string[] = []
    if (!maDe) errs.push('Chưa nhập mã đề.')
    if (keys.some((k) => k.ma_de === maDe && k.id !== draft.id)) errs.push(`Mã đề ${maDe} đã có đáp án.`)
    if (miss.length) errs.push(`Còn trống: ${miss.join(', ')}.`)
    if (bad.length) errs.push(`Đáp án Phần 3 không phải số: ${bad.join(', ')}.`)
    if (Object.keys(draft.flags).length) errs.push('Còn ô tô vàng chưa rà — kiểm tra rồi bấm "Đã rà xong các ô vàng".')
    if (errs.length) return setDraft({ ...draft, error: errs.join('\n') })

    setSaving(true)
    const payload = { batch_id: batchId, teacher_id: teacherId, ma_de: maDe, answers: draft.answers }
    const old = draft.id ? keys.find((k) => k.id === draft.id) : undefined
    const res = draft.id
      ? await supabase.from('paper_keys').update(payload).eq('id', draft.id)
      : await supabase.from('paper_keys').insert(payload)
    if (res.error) {
      setSaving(false)
      return setDraft({ ...draft, error: res.error.message })
    }

    // Sửa đáp án / đổi mã đề -> chấm lại các phiếu đã lưu của mã đề đó
    const affected = sheets.filter((s) => s.ma_de === (old?.ma_de ?? maDe))
    if (affected.length) {
      for (const s of affected) {
        const sc = scorePaper(s.answers, draft.answers, cfg)
        await supabase
          .from('paper_sheets')
          .update({
            ma_de: maDe,
            score: sc.total,
            part_scores: { p1: sc.p1, p2: sc.p2, p3: sc.p3, total: sc.total, max: sc.max },
            updated_at: new Date().toISOString(),
          })
          .eq('id', s.id)
      }
      alert(`Đã chấm lại ${affected.length} phiếu của mã đề ${maDe} theo đáp án mới.`)
    }
    setSaving(false)
    await onChanged()
    // còn mã đề đọc từ bảng đáp án -> mở mã kế tiếp
    if (pending.length) {
      const [next, ...rest] = pending
      setPending(rest)
      openItem(next)
    } else setDraft(null)
  }

  async function remove(k: KeyRow) {
    const n = sheets.filter((s) => s.ma_de === k.ma_de).length
    if (n) return alert(`Mã đề ${k.ma_de} đã có ${n} phiếu chấm. Xoá các phiếu đó ở tab Kết quả trước.`)
    if (!confirm(`Xoá đáp án mã đề ${k.ma_de}?`)) return
    const { error } = await supabase.from('paper_keys').delete().eq('id', k.id)
    if (error) return alert(error.message)
    await onChanged()
  }

  return (
    <>
      <div className="card">
        <h2>Đáp án theo mã đề</h2>
        {bubble ? (
          <div style={{ color: 'var(--muted)', marginTop: 0, fontSize: 14 }}>
            <p style={{ margin: '0 0 6px' }}>Có 3 cách đưa đáp án vào:</p>
            <ol style={{ margin: '0 0 8px', paddingLeft: 20 }}>
              <li>
                <b>Tô đáp án lên một tờ phiếu</b> (ghi mã đề, Phần III ghi đáp số) rồi chụp ảnh hoặc chọn file scan.
              </li>
              <li>
                <b>Bảng đáp án của đề</b>: chọn file PDF / ảnh có bảng đáp án (một hoặc nhiều mã đề). AI đọc 2 lần đối chiếu.
              </li>
              <li>Bấm "+ Thêm đáp án mã đề" rồi chọn trực tiếp trên lưới.</li>
            </ol>
            <p style={{ margin: 0 }}>Ô nào chưa chắc sẽ tô vàng để cô rà. Đáp án phải đủ tất cả các ô mới lưu được.</p>
          </div>
        ) : (
          <p style={{ color: 'var(--muted)', marginTop: 0 }}>
            Cô ghi đáp án lên một tờ phiếu trả lời (ô Mã đề ghi mã đề, ô Họ tên có thể ghi "ĐÁP ÁN") rồi chụp. Máy đọc 2 lần để đối
            chiếu; ô nào chưa chắc sẽ tô vàng để cô rà. Đáp án phải đủ tất cả các ô mới lưu được.
          </p>
        )}
        {keys.map((k) => (
          <div key={k.id} style={{ borderTop: '1px solid var(--border)', padding: '12px 0' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
              <span className="badge" style={{ fontSize: 14 }}>
                Mã đề {k.ma_de}
              </span>
              <span style={{ color: 'var(--muted)', fontSize: 13 }}>{sheets.filter((s) => s.ma_de === k.ma_de).length} phiếu đã chấm</span>
              <button
                className="btn secondary"
                style={{ padding: '3px 10px', fontSize: 12 }}
                onClick={() => setDraft({ id: k.id, maDe: k.ma_de, answers: k.answers, flags: {}, reading: false, error: '' })}
              >
                Sửa
              </button>
              <button className="btn danger" style={{ padding: '3px 10px', fontSize: 12 }} onClick={() => remove(k)}>
                Xoá
              </button>
            </div>
            <PaperAnswerGrid cfg={cfg} value={k.answers} />
          </div>
        ))}
        {!draft && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <button className="btn" onClick={startNew}>
              + Thêm đáp án mã đề
            </button>
            {bubble && (
              <>
                <button className="btn accent" onClick={() => tableRef.current?.click()}>
                  📄 Đọc bảng đáp án (PDF / ảnh)
                </button>
                <div style={{ width: 150 }}>
                  <label style={{ fontSize: 12 }}>Trang (PDF dài)</label>
                  <input value={pages} onChange={(e) => setPages(e.target.value)} placeholder="VD: 5 hoặc 4-5" style={{ margin: 0 }} />
                </div>
                <input ref={tableRef} type="file" multiple accept="image/*,application/pdf" style={{ display: 'none' }} onChange={onTableFile} />
              </>
            )}
          </div>
        )}
        {tableMsg && <p style={{ whiteSpace: 'pre-line', fontSize: 13.5 }}>{tableMsg}</p>}
      </div>

      {draft && (
        <div className="card" style={{ border: '2px solid var(--primary)' }}>
          <h2>{draft.id ? `Sửa đáp án mã đề ${draft.maDe}` : 'Thêm đáp án mã đề'}</h2>
          {pending.length > 0 && <p className="badge">Còn {pending.length} mã đề đọc từ bảng đáp án chờ rà sau mã này</p>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 12 }}>
            <div style={{ width: 160 }}>
              <label>Mã đề</label>
              <input
                value={draft.maDe}
                onChange={(e) => {
                  const flags = { ...draft.flags }
                  delete flags['made']
                  setDraft({ ...draft, maDe: e.target.value, flags })
                }}
                placeholder="VD: 101"
                style={draft.flags['made'] ? { background: '#fef3c7', borderColor: '#f59e0b' } : undefined}
              />
            </div>
            <button className="btn accent" onClick={() => setCamera(true)} disabled={draft.reading} style={{ marginBottom: 12 }}>
              📸 Chụp phiếu đáp án
            </button>
            <button className="btn secondary" onClick={() => fileRef.current?.click()} disabled={draft.reading} style={{ marginBottom: 12 }}>
              🖼 Chọn ảnh / file scan
            </button>
            <input ref={fileRef} type="file" accept="image/*,application/pdf" style={{ display: 'none' }} onChange={onFile} />
          </div>
          {draft.reading && <p className="badge warn">Đang đọc phiếu đáp án (2 lần đối chiếu)…</p>}
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            {!!draft.sources?.length && (
              <div style={{ width: 420, maxWidth: '100%' }}>
                <p style={{ fontSize: 12.5, margin: '0 0 4px' }}>Bảng đáp án gốc (bấm để phóng to) — đối chiếu từng câu:</p>
                {draft.sources.map((src, i) => (
                  <a key={i} href="#" onClick={(e) => openImage(e, src)} title="Mở ảnh lớn">
                    <img src={src} alt={`Bảng đáp án trang ${i + 1}`} style={{ width: '100%', borderRadius: 8, border: '1px solid var(--border)', marginBottom: 6 }} />
                  </a>
                ))}
              </div>
            )}
            {draft.dataUrl && (
              <a href="#" onClick={(e) => openImage(e, draft.dataUrl)} title="Mở ảnh lớn">
                <img src={draft.dataUrl} alt="Phiếu đáp án" style={{ width: 320, borderRadius: 8, border: '1px solid var(--border)' }} />
              </a>
            )}
            <div style={{ flex: 1, minWidth: 300 }}>
              <PaperAnswerGrid
                cfg={cfg}
                value={draft.answers}
                flags={draft.flags}
                onChange={(v) => setDraft({ ...draft, answers: v, flags: clearChangedFlags(draft.answers, v, draft.flags, cfg) })}
              />
              <p style={{ fontSize: 12.5, margin: '6px 0 0', wordBreak: 'break-word' }}>
                <b>Đáp án dạng chữ:</b> {answersToText(draft.answers)}
              </p>
              <FlagList flags={draft.flags} onClear={() => setDraft({ ...draft, flags: {} })} />
            </div>
          </div>
          {draft.error && <p style={{ color: 'var(--danger)', whiteSpace: 'pre-line' }}>{draft.error}</p>}
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button className="btn" onClick={save} disabled={saving || draft.reading}>
              {saving ? 'Đang lưu…' : 'Lưu đáp án'}
            </button>
            <button
              className="btn secondary"
              onClick={() => {
                if (pending.length) {
                  const [next, ...rest] = pending
                  setPending(rest)
                  openItem(next)
                } else setDraft(null)
              }}
            >
              {pending.length ? 'Bỏ mã này' : 'Huỷ'}
            </button>
          </div>
        </div>
      )}

      {camera && (
        <CameraCapture
          continuous={false}
          onCapture={(url) => readKeyImage(url)}
          onClose={() => setCamera(false)}
        />
      )}
    </>
  )
}

/** Danh sách lý do các ô tô vàng + nút xác nhận đã rà */
function FlagList({ flags, onClear }: { flags: Record<CellId, string>; onClear: () => void }) {
  const entries = Object.entries(flags)
  if (!entries.length) return null
  const label = (id: string) => {
    if (id === 'made') return 'Mã đề'
    if (id === 'name') return 'Họ tên'
    if (id === 'phach') return 'Phách'
    if (id === 'ai') return 'Phần viết tay'
    if (id === 'all') return 'Cả bảng đáp án'
    const [p, rest] = id.split('.')
    return `Phần ${p} – ${rest === '*' ? 'số câu' : `câu ${rest}`}`
  }
  return (
    <div style={{ background: '#fffbeb', border: '1px solid #f59e0b', borderRadius: 8, padding: '8px 12px', margin: '8px 0', fontSize: 13 }}>
      <b>⚠ {entries.length} chỗ cần rà:</b>
      <ul style={{ margin: '4px 0 6px', paddingLeft: 18 }}>
        {entries.map(([id, why]) => (
          <li key={id}>
            <b>{label(id)}</b>: {why}
          </li>
        ))}
      </ul>
      <button className="btn secondary" style={{ padding: '3px 10px', fontSize: 12 }} onClick={onClear}>
        ✓ Đã rà xong các ô vàng
      </button>
    </div>
  )
}

// ======================================================================
// 2. CHẤM PHIẾU (camera / ảnh / scan)
// ======================================================================

function GradeSection(props: {
  batchId: string
  teacherId: string
  cfg: PaperConfig
  keys: KeyRow[]
  roster: StudentLite[]
  sheets: SheetRow[]
  onSaved: () => Promise<void>
  hasClass: boolean
}) {
  const { batchId, teacherId, cfg, keys, roster, sheets, onSaved, hasClass } = props
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [camera, setCamera] = useState(false)
  const [doubleCheck, setDoubleCheck] = useState(true)
  const [importing, setImporting] = useState(false)
  const [msg, setMsg] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const busy = useRef(false)

  // Giá trị mới nhất cho vòng xử lý nền
  const ctx = useRef({ cfg, keys, roster, doubleCheck })
  ctx.current = { cfg, keys, roster, doubleCheck }

  function addImages(imgs: { name: string; dataUrl: string }[]) {
    setQueue((q) => [
      ...q,
      ...imgs.map<QueueItem>((im) => ({
        uid: newUid(),
        label: im.name,
        dataUrl: im.dataUrl,
        status: 'waiting',
        flags: {},
        studentId: '',
        studentName: '',
        maDe: '',
        maPhach: '',
        soPhach: '',
      })),
    ])
  }

  async function onFiles(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    if (!files.length) return
    setImporting(true)
    setMsg('')
    try {
      addImages(await filesToImages(files))
    } catch (err) {
      setMsg((err as Error).message)
    }
    setImporting(false)
  }

  const update = (uid: string, patch: Partial<QueueItem>) =>
    setQueue((q) => q.map((it) => (it.uid === uid ? { ...it, ...patch } : it)))

  // Xử lý tuần tự từng phiếu (tránh vượt hạn mức số yêu cầu/phút của AI miễn phí)
  useEffect(() => {
    if (busy.current) return
    const next = queue.find((it) => it.status === 'waiting')
    if (!next) return
    busy.current = true
    update(next.uid, { status: 'reading', error: undefined })
    ;(async () => {
      const { cfg: c, keys: ks, roster: rs, doubleCheck: dc } = ctx.current
      try {
        const r = isBubbleSheet(c) ? await readBubbleSheet(next.dataUrl, c, dc) : await readSheet(next.dataUrl, c, 'sheet', dc)
        const flags = { ...r.flags }
        const phach = c.identity === 'phach'
        let match: NameMatch | undefined
        let studentId = ''
        if (phach) {
          // Bài cắt phách: nhận diện bằng Mã phách + Số phách
          delete flags['name']
          if (!r.maPhach || !r.soPhach)
            flags['phach'] = flags['phach'] || `Chưa đọc được ${!r.maPhach ? 'mã phách' : 'số phách'} — hãy nhập`
        } else {
          // Khớp họ tên với danh sách lớp; STT (nếu có) dùng để xác nhận khi tên chưa chắc
          match = rs.length ? matchStudent(r.name, rs) : undefined
          if (match && !match.sure && r.stt) {
            const byStt = rs.find((x) => x.stt === Number(r.stt)) || (rs.some((x) => x.stt) ? undefined : rs[Number(r.stt) - 1])
            if (byStt && nameSimilarity(r.name, byStt.full_name) >= 0.6)
              match = { ...match, student: byStt, sure: true, candidates: [byStt, ...match.candidates.filter((x) => x.id !== byStt.id)] }
          }
          if (match?.student) studentId = match.student.id
          if (rs.length && !match?.sure)
            flags['name'] = flags['name'] || (r.name ? `Đọc được "${r.name}" — chưa chắc là học sinh nào, hãy chọn lại` : 'Không đọc được họ tên')
          else if (rs.length && match?.sure) delete flags['name']
          if (!rs.length && !r.name) flags['name'] = 'Không đọc được họ tên'
        }
        // Khớp mã đề
        let maDe = ''
        const readMa = r.maDe.replace(/\s+/g, '')
        const exact = ks.find((k) => k.ma_de.replace(/\s+/g, '') === readMa)
        if (exact) maDe = exact.ma_de
        else if (ks.length === 1) {
          maDe = ks[0].ma_de
          if (readMa) flags['made'] = `Phiếu ghi mã "${r.maDe}" nhưng đợt chấm chỉ có mã ${ks[0].ma_de}`
        } else flags['made'] = readMa ? `Mã đề "${r.maDe}" chưa có đáp án` : 'Không đọc được mã đề — hãy chọn'
        update(next.uid, {
          status: 'review',
          read: r,
          answers: r.answers,
          flags,
          match,
          studentId,
          studentName: phach ? '' : match?.student?.full_name || r.name,
          maDe,
          maPhach: r.maPhach || '',
          soPhach: r.soPhach || '',
        })
      } catch (e) {
        update(next.uid, { status: 'error', error: (e as Error).message })
      } finally {
        busy.current = false
        // kích hoạt lại effect cho phiếu kế tiếp
        setQueue((q) => [...q])
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue])

  const phach = cfg.identity === 'phach'
  const samePhach = (a: { maPhach: string; soPhach: string }, ma?: string | null, so?: string | null) =>
    normMaPhach(a.maPhach) === normMaPhach(ma) && normSoPhach(a.soPhach) === normSoPhach(so)

  function readyToSave(it: QueueItem): string[] {
    const errs: string[] = []
    if (!it.answers) errs.push('Chưa đọc xong.')
    if (!it.maDe || !keys.some((k) => k.ma_de === it.maDe)) errs.push('Chưa chọn mã đề có đáp án.')
    if (phach) {
      if (!it.maPhach.trim() || !it.soPhach.trim()) errs.push('Chưa có mã phách / số phách.')
      const dupQ = queue.find((o) => o.uid !== it.uid && o.status === 'saved' && samePhach(o, it.maPhach, it.soPhach))
      if (dupQ) errs.push('Phách này vừa được chấm ở phiếu khác trong lượt này.')
      if (Object.keys(it.flags).length) errs.push('Còn ô tô vàng chưa rà.')
      return errs
    }
    if (hasClass && roster.length && !it.studentId) errs.push('Chưa chọn học sinh.')
    if (!it.studentName.trim()) errs.push('Chưa có họ tên.')
    if (Object.keys(it.flags).length) errs.push('Còn ô tô vàng chưa rà.')
    const dupInQueue = queue.find(
      (o) => o.uid !== it.uid && o.status === 'saved' && it.studentId && it.studentId !== '__other' && o.studentId === it.studentId,
    )
    if (dupInQueue) errs.push('Học sinh này vừa được chấm ở phiếu khác trong lượt này.')
    return errs
  }

  async function saveItem(it: QueueItem, silent = false): Promise<boolean> {
    const errs = readyToSave(it)
    if (errs.length) {
      if (!silent) update(it.uid, { error: errs.join(' ') })
      return false
    }
    const key = keys.find((k) => k.ma_de === it.maDe)!
    const sc = scorePaper(it.answers!, key.answers, cfg)
    const studentId = it.studentId && it.studentId !== '__other' ? it.studentId : null
    const existing = it.savedId
      ? sheets.find((s) => s.id === it.savedId)
      : phach
        ? sheets.find((s) => samePhach(it, s.ma_phach, s.so_phach))
        : studentId
          ? sheets.find((s) => s.student_id === studentId)
          : undefined
    const who = phach ? `Phách ${it.maPhach} – ${it.soPhach}` : existing?.student_name
    if (existing && !it.savedId) {
      if (silent) {
        update(it.uid, { error: `${who} đã có phiếu (${existing.score}đ) — bấm Lưu để ghi đè.` })
        return false
      }
      if (!confirm(`${who} đã có phiếu chấm (${existing.score} điểm). Ghi đè bằng phiếu này?`)) return false
    }
    const row = {
      batch_id: batchId,
      teacher_id: teacherId,
      student_id: phach ? null : studentId,
      // bài cắt phách: giữ họ tên đã ghép (nếu ghi đè phiếu cũ), chưa ghép thì để trống
      student_name: phach ? existing?.student_name || '' : it.studentName.trim(),
      name_read: it.read?.name || null,
      class_label: phach ? existing?.class_label || null : it.read?.classLabel || null,
      ...(isBubbleSheet(cfg)
        ? {
            ma_phach: phach ? it.maPhach.trim().toUpperCase() : null,
            so_phach: phach ? it.soPhach.trim() : null,
            stt: it.read?.stt || null,
          }
        : {}),
      ma_de: it.maDe,
      answers: it.answers,
      score: sc.total,
      part_scores: { p1: sc.p1, p2: sc.p2, p3: sc.p3, total: sc.total, max: sc.max },
      edited_cells: it.read ? diffCells(it.read.answers, it.answers!, cfg) : [],
      ai_model: it.read?.model || null,
      updated_at: new Date().toISOString(),
    }
    const res = existing
      ? await supabase.from('paper_sheets').update(row).eq('id', existing.id).select('id').single()
      : await supabase.from('paper_sheets').insert(row).select('id').single()
    if (res.error) {
      const dup = res.error.code === '23505'
      const noCol = /ma_phach|so_phach|stt/.test(res.error.message)
      update(it.uid, {
        error: dup
          ? phach
            ? 'Phách này đã có phiếu trong đợt chấm. Kiểm tra lại mã phách / số phách.'
            : 'Học sinh này đã có phiếu trong đợt chấm (vừa lưu ở phiếu khác). Kiểm tra lại họ tên.'
          : noCol
            ? 'Chưa cập nhật cơ sở dữ liệu: hãy chạy lại file supabase/schema_cham_phieu.sql trong Supabase.'
            : res.error.message,
      })
      return false
    }
    update(it.uid, { status: 'saved', savedId: res.data.id, error: undefined })
    return true
  }

  async function saveAllReady() {
    const ready = queue.filter((it) => it.status === 'review' && readyToSave(it).length === 0)
    if (!ready.length)
      return setMsg(`Chưa có phiếu nào đủ điều kiện lưu (đã có ${phach ? 'phách' : 'học sinh'}, mã đề và rà hết ô vàng).`)
    let ok = 0
    for (const it of ready) if (await saveItem(it, true)) ok++
    setMsg(`Đã lưu ${ok}/${ready.length} phiếu.`)
    await onSaved()
  }

  const counts = useMemo(() => {
    const c: Record<ItemStatus, number> = { waiting: 0, reading: 0, review: 0, saved: 0, error: 0 }
    queue.forEach((it) => c[it.status]++)
    return c
  }, [queue])

  if (!keys.length)
    return (
      <div className="card">
        <p>Cần nhập đáp án ít nhất một mã đề ở tab "1. Đáp án" trước khi chấm.</p>
      </div>
    )

  return (
    <>
      <div className="card">
        <h2>Chấm phiếu bài làm</h2>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="btn accent" onClick={() => setCamera(true)}>
            📸 Bật camera chụp liên tục
          </button>
          <button className="btn secondary" onClick={() => fileRef.current?.click()} disabled={importing}>
            {importing ? 'Đang mở file…' : '🖼 Chọn ảnh / file scan (PDF)'}
          </button>
          <input ref={fileRef} type="file" multiple accept="image/*,application/pdf" style={{ display: 'none' }} onChange={onFiles} />
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, margin: 0, fontWeight: 500 }}>
            <input type="checkbox" checked={doubleCheck} onChange={(e) => setDoubleCheck(e.target.checked)} style={{ width: 'auto', margin: 0 }} />
            {isBubbleSheet(cfg)
              ? 'Chữ viết tay (mã đề, phách/họ tên, Phần III) đọc 2 lần bằng 2 model để đối chiếu'
              : 'Đọc 2 lần bằng 2 model để đối chiếu (chính xác hơn, tốn gấp đôi lượt AI)'}
          </label>
        </div>
        <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 0 }}>
          File PDF scan nhiều trang: mỗi trang là một phiếu. Chờ đọc: {counts.waiting + counts.reading} · Cần rà: {counts.review} · Đã
          lưu: {counts.saved} · Lỗi: {counts.error}
        </p>
        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          <button className="btn" onClick={saveAllReady} disabled={!counts.review}>
            💾 Lưu tất cả phiếu đã sẵn sàng
          </button>
          {counts.saved > 0 && (
            <button className="btn secondary" onClick={() => setQueue((q) => q.filter((it) => it.status !== 'saved'))}>
              Ẩn các phiếu đã lưu
            </button>
          )}
        </div>
        {msg && <p style={{ whiteSpace: 'pre-line' }}>{msg}</p>}
      </div>

      {queue.map((it, idx) => (
        <QueueCard
          key={it.uid}
          index={idx + 1}
          it={it}
          cfg={cfg}
          keys={keys}
          roster={roster}
          sheets={sheets}
          issues={it.status === 'review' ? readyToSave(it) : []}
          onPatch={(p) => update(it.uid, p)}
          onSave={async () => {
            if (await saveItem(it)) await onSaved()
          }}
          onRetry={() => update(it.uid, { status: 'waiting', error: undefined })}
          onRemove={() => setQueue((q) => q.filter((x) => x.uid !== it.uid))}
        />
      ))}

      {camera && <CameraCapture onCapture={(url) => addImages([{ name: `Ảnh chụp ${new Date().toLocaleTimeString('vi-VN')}`, dataUrl: url }])} onClose={() => setCamera(false)} />}
    </>
  )
}

function QueueCard(props: {
  index: number
  it: QueueItem
  cfg: PaperConfig
  keys: KeyRow[]
  roster: StudentLite[]
  sheets: SheetRow[]
  issues: string[]
  onPatch: (p: Partial<QueueItem>) => void
  onSave: () => void
  onRetry: () => void
  onRemove: () => void
}) {
  const { index, it, cfg, keys, roster, sheets, issues, onPatch, onSave, onRetry, onRemove } = props
  const key = keys.find((k) => k.ma_de === it.maDe)
  const sc = it.answers && key ? scorePaper(it.answers, key.answers, cfg) : null
  const saved = it.status === 'saved'
  const phach = cfg.identity === 'phach'
  const already = phach
    ? it.maPhach && it.soPhach
      ? sheets.find(
          (s) => s.id !== it.savedId && normMaPhach(s.ma_phach) === normMaPhach(it.maPhach) && normSoPhach(s.so_phach) === normSoPhach(it.soPhach),
        )
      : undefined
    : it.studentId && it.studentId !== '__other'
      ? sheets.find((s) => s.student_id === it.studentId && s.id !== it.savedId)
      : undefined
  const clearFlag = (k: string) => {
    const flags = { ...it.flags }
    delete flags[k]
    return flags
  }

  // Danh sách chọn: ưu tiên các tên gần giống nhất lên đầu
  const options = it.match?.candidates?.length ? it.match.candidates : roster

  const statusBadge = {
    waiting: <span className="badge">Chờ đọc</span>,
    reading: <span className="badge warn">Đang đọc…</span>,
    review: issues.length ? <span className="badge warn">Cần rà</span> : <span className="badge correct">Sẵn sàng lưu</span>,
    saved: <span className="badge correct">Đã lưu</span>,
    error: <span className="badge wrong">Lỗi</span>,
  }[it.status]

  return (
    <div className="card" style={{ opacity: saved ? 0.75 : 1 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <div>
          <b>Phiếu {index}</b> <span style={{ color: 'var(--muted)', fontSize: 13 }}>{it.label}</span> {statusBadge}
          {it.read?.model && <span style={{ color: 'var(--muted)', fontSize: 12 }}> · {it.read.model}</span>}
        </div>
        {sc && (
          <div style={{ fontSize: 15 }}>
            P1 <b>{sc.p1}</b> · P2 <b>{sc.p2}</b> · P3 <b>{sc.p3}</b> → <b style={{ fontSize: 20, color: 'var(--primary-dark)' }}>{sc.total}</b>/
            {sc.max}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start', marginTop: 10 }}>
        <div style={{ width: it.read?.overlay ? 360 : 240 }}>
          <a href="#" onClick={(e) => openImage(e, it.read?.overlay || it.dataUrl)} title="Mở ảnh lớn">
            <img src={it.read?.overlay || it.dataUrl} alt={it.label} style={{ width: '100%', borderRadius: 8, border: '1px solid var(--border)' }} />
          </a>
          {it.read?.overlay && (
            <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.4 }}>
              Ảnh đã nắn thẳng: <span style={{ color: '#16a34a', fontWeight: 700 }}>vòng xanh</span> = ô máy đọc được,{' '}
              <span style={{ color: '#d97706', fontWeight: 700 }}>vòng cam</span> = hàng cần rà.{' '}
              <a href="#" onClick={(e) => openImage(e, it.dataUrl)}>
                Ảnh gốc
              </a>
            </div>
          )}
        </div>
        <div style={{ flex: 1, minWidth: 320 }}>
          {it.status === 'error' && (
            <>
              <p style={{ color: 'var(--danger)', whiteSpace: 'pre-line' }}>{it.error}</p>
              <button className="btn secondary" onClick={onRetry}>
                Đọc lại
              </button>{' '}
              <button className="btn danger" onClick={onRemove}>
                Bỏ phiếu này
              </button>
            </>
          )}

          {it.answers && (
            <>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {phach && (
                  <>
                    <div style={{ width: 140 }}>
                      <label>Mã phách</label>
                      <input
                        value={it.maPhach}
                        disabled={saved}
                        placeholder="VD: T106"
                        style={it.flags['phach'] ? { background: '#fef3c7', borderColor: '#f59e0b' } : undefined}
                        onChange={(e) => onPatch({ maPhach: e.target.value, flags: clearFlag('phach') })}
                      />
                    </div>
                    <div style={{ width: 120 }}>
                      <label>Số phách</label>
                      <input
                        value={it.soPhach}
                        disabled={saved}
                        placeholder="VD: 01"
                        style={it.flags['phach'] ? { background: '#fef3c7', borderColor: '#f59e0b' } : undefined}
                        onChange={(e) => onPatch({ soPhach: e.target.value, flags: clearFlag('phach') })}
                      />
                      {already && (
                        <p style={{ color: '#b45309', fontSize: 12.5, margin: '2px 0 0' }}>Phách này đã có phiếu ({already.score}đ) — lưu sẽ hỏi ghi đè.</p>
                      )}
                    </div>
                  </>
                )}
                {!phach && (
                <div style={{ flex: 2, minWidth: 220 }}>
                  <label>
                    Học sinh {it.read?.name && <span style={{ color: 'var(--muted)', fontWeight: 400 }}>(phiếu ghi: "{it.read.name}")</span>}
                  </label>
                  {roster.length ? (
                    <select
                      value={it.studentId}
                      disabled={saved}
                      style={it.flags['name'] ? { background: '#fef3c7', borderColor: '#f59e0b' } : undefined}
                      onChange={(e) => {
                        const id = e.target.value
                        const s = roster.find((x) => x.id === id)
                        const flags = { ...it.flags }
                        delete flags['name']
                        onPatch({ studentId: id, studentName: s ? s.full_name : it.read?.name || '', flags })
                      }}
                    >
                      <option value="">— Chọn học sinh —</option>
                      {options.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.full_name}
                          {s.student_code ? ` (${s.student_code})` : ''}
                        </option>
                      ))}
                      <option value="__other">Không có trong danh sách lớp…</option>
                    </select>
                  ) : null}
                  {(!roster.length || it.studentId === '__other') && (
                    <input
                      value={it.studentName}
                      disabled={saved}
                      placeholder="Họ và tên"
                      onChange={(e) => {
                        const flags = { ...it.flags }
                        delete flags['name']
                        onPatch({ studentName: e.target.value, flags })
                      }}
                    />
                  )}
                  {already && (
                    <p style={{ color: '#b45309', fontSize: 12.5, margin: '2px 0 0' }}>
                      Học sinh này đã có phiếu lưu trước đó ({already.score}đ) — lưu sẽ hỏi ghi đè.
                    </p>
                  )}
                  {it.read?.stt && <p style={{ fontSize: 12, color: 'var(--muted)', margin: '2px 0 0' }}>Phiếu ghi STT: {it.read.stt}{it.read.classLabel ? ` · Lớp: ${it.read.classLabel}` : ''}</p>}
                </div>
                )}
                <div style={{ width: 150 }}>
                  <label>
                    Mã đề {it.read?.maDe && <span style={{ color: 'var(--muted)', fontWeight: 400 }}>(ghi: {it.read.maDe})</span>}
                  </label>
                  <select
                    value={it.maDe}
                    disabled={saved}
                    style={it.flags['made'] ? { background: '#fef3c7', borderColor: '#f59e0b' } : undefined}
                    onChange={(e) => {
                      const flags = { ...it.flags }
                      delete flags['made']
                      onPatch({ maDe: e.target.value, flags })
                    }}
                  >
                    <option value="">— Chọn —</option>
                    {keys.map((k) => (
                      <option key={k.id} value={k.ma_de}>
                        {k.ma_de}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <PaperAnswerGrid
                cfg={cfg}
                value={it.answers}
                flags={it.flags}
                correct={sc?.correct}
                answerKey={key?.answers}
                onChange={saved ? undefined : (v) => onPatch({ answers: v, flags: clearChangedFlags(it.answers!, v, it.flags, cfg) })}
              />
              {!saved && <FlagList flags={it.flags} onClear={() => onPatch({ flags: {} })} />}
              {it.read?.note && <p style={{ fontSize: 12.5, color: 'var(--muted)' }}>Ghi chú của AI: {it.read.note}</p>}
              {it.error && <p style={{ color: 'var(--danger)' }}>{it.error}</p>}
              {!saved && (
                <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
                  <button className="btn" onClick={onSave} disabled={issues.length > 0} title={issues.join(' ')}>
                    💾 Lưu phiếu
                  </button>
                  <button className="btn secondary" onClick={onRetry}>
                    Đọc lại
                  </button>
                  <button className="btn danger" onClick={onRemove}>
                    Bỏ
                  </button>
                  {issues.length > 0 && <span style={{ color: '#b45309', fontSize: 12.5, alignSelf: 'center' }}>{issues.join(' ')}</span>}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ======================================================================
// 3. KẾT QUẢ + XUẤT EXCEL
// ======================================================================

function ResultSection(props: {
  batch: Batch
  cfg: PaperConfig
  keys: KeyRow[]
  sheets: SheetRow[]
  roster: StudentLite[]
  onChanged: () => Promise<void>
}) {
  const { batch, cfg, keys, sheets, onChanged } = props
  const phach = cfg.identity === 'phach'
  const roster = phach ? [] : props.roster
  const [open, setOpen] = useState<string | null>(null)
  const [edit, setEdit] = useState<{ id: string; answers: PaperAnswers; maDe: string; maPhach: string; soPhach: string } | null>(null)
  const [mergeMsg, setMergeMsg] = useState('')
  const mergeRef = useRef<HTMLInputElement>(null)

  const phachKey = (s: { ma_phach?: string | null; so_phach?: string | null }) => `${normMaPhach(s.ma_phach)}|${normSoPhach(s.so_phach)}`
  const sorted = useMemo(
    () =>
      [...sheets].sort((a, b) =>
        phach
          ? normMaPhach(a.ma_phach).localeCompare(normMaPhach(b.ma_phach), 'vi', { numeric: true }) ||
            normSoPhach(a.so_phach).localeCompare(normSoPhach(b.so_phach), 'vi', { numeric: true })
          : vnNameCompare(a.student_name, b.student_name),
      ),
    [sheets, phach],
  )
  const missing = useMemo(
    () => roster.filter((s) => !sheets.some((x) => x.student_id === s.id)),
    [roster, sheets],
  )

  /** File Excel mẫu để ghép phách: đã điền sẵn các phách đã chấm, cô điền Họ tên, Lớp */
  function exportPhachTemplate() {
    const rows: (string | number)[][] = [['Mã phách', 'Số phách', 'Họ và tên', 'Lớp']]
    sorted.forEach((s) => rows.push([s.ma_phach || '', s.so_phach || '', s.student_name || '', s.class_label || '']))
    const ws = XLSX.utils.aoa_to_sheet(rows)
    ws['!cols'] = [{ wch: 12 }, { wch: 10 }, { wch: 28 }, { wch: 10 }]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Ghép phách')
    const safe = stripVN(batch.title).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'cham_phieu'
    XLSX.writeFile(wb, `${safe}_ghep_phach.xlsx`)
  }

  /** Đọc file Excel (Mã phách, Số phách, Họ và tên, Lớp) và ghi họ tên vào các phiếu cùng phách */
  async function importPhach(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    setMergeMsg('Đang đọc file…')
    try {
      const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' })
      const ws = wb.Sheets[wb.SheetNames[0]]
      const data = XLSX.utils.sheet_to_json<(string | number)[]>(ws, { header: 1, defval: '' }) as (string | number)[][]
      // tìm dòng tiêu đề
      let h = -1
      let cMa = -1,
        cSo = -1,
        cTen = -1,
        cLop = -1
      for (let r = 0; r < Math.min(15, data.length) && h < 0; r++) {
        const cells = data[r].map((x) => stripVN(String(x)))
        const find = (re: RegExp) => cells.findIndex((c) => re.test(c))
        const ma = find(/^ma\s*phach/),
          so = find(/^so\s*phach/),
          ten = find(/ho\s*(va\s*)?ten|^ten/)
        if (ma >= 0 && so >= 0 && ten >= 0) {
          h = r
          cMa = ma
          cSo = so
          cTen = ten
          cLop = find(/^lop/)
        }
      }
      if (h < 0) return setMergeMsg('Không thấy dòng tiêu đề có các cột "Mã phách", "Số phách", "Họ và tên" (cột "Lớp" không bắt buộc).')
      const map = new Map<string, { name: string; lop: string }>()
      for (const row of data.slice(h + 1)) {
        const ma = String(row[cMa] ?? '').trim(),
          so = String(row[cSo] ?? '').trim(),
          name = String(row[cTen] ?? '').trim()
        if (!ma || !so || !name) continue
        map.set(phachKey({ ma_phach: ma, so_phach: so }), { name, lop: cLop >= 0 ? String(row[cLop] ?? '').trim() : '' })
      }
      let ok = 0
      const noName: string[] = []
      for (const s of sheets) {
        const m = map.get(phachKey(s))
        if (!m) {
          noName.push(`${s.ma_phach}–${s.so_phach}`)
          continue
        }
        const { error } = await supabase
          .from('paper_sheets')
          .update({ student_name: m.name, class_label: m.lop || s.class_label || null, updated_at: new Date().toISOString() })
          .eq('id', s.id)
        if (!error) ok++
      }
      const used = new Set(sheets.map((s) => phachKey(s)))
      const extra = [...map.keys()].filter((k) => !used.has(k)).map((k) => k.replace('|', '–'))
      setMergeMsg(
        [
          `Đã ghép tên cho ${ok}/${sheets.length} phiếu.`,
          noName.length ? `Phiếu chưa có tên trong file: ${noName.join(', ')}.` : '',
          extra.length ? `Phách có trong file nhưng chưa có phiếu chấm: ${extra.join(', ')}.` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      )
      await onChanged()
    } catch (err) {
      setMergeMsg((err as Error).message)
    }
  }
  const avg = sheets.length ? Math.round((sheets.reduce((t, s) => t + s.score, 0) / sheets.length) * 100) / 100 : 0

  async function remove(s: SheetRow) {
    if (!confirm(`Xoá phiếu của ${s.student_name || `phách ${s.ma_phach} – ${s.so_phach}`}?`)) return
    const { error } = await supabase.from('paper_sheets').delete().eq('id', s.id)
    if (error) return alert(error.message)
    await onChanged()
  }

  async function saveEdit() {
    if (!edit) return
    const key = keys.find((k) => k.ma_de === edit.maDe)
    if (!key) return alert('Mã đề chưa có đáp án.')
    const s = sheets.find((x) => x.id === edit.id)!
    if (phach && (!edit.maPhach.trim() || !edit.soPhach.trim())) return alert('Cần có mã phách và số phách.')
    if (phach && sheets.some((x) => x.id !== s.id && phachKey(x) === phachKey({ ma_phach: edit.maPhach, so_phach: edit.soPhach })))
      return alert('Phách này đã có phiếu khác trong đợt chấm.')
    const sc = scorePaper(edit.answers, key.answers, cfg)
    const edited = Array.from(new Set([...(s.edited_cells || []), ...diffCells(s.answers, edit.answers, cfg)]))
    const { error } = await supabase
      .from('paper_sheets')
      .update({
        answers: edit.answers,
        ma_de: edit.maDe,
        ...(phach ? { ma_phach: edit.maPhach.trim().toUpperCase(), so_phach: edit.soPhach.trim() } : {}),
        score: sc.total,
        part_scores: { p1: sc.p1, p2: sc.p2, p3: sc.p3, total: sc.total, max: sc.max },
        edited_cells: edited,
        updated_at: new Date().toISOString(),
      })
      .eq('id', edit.id)
    if (error) return alert(error.message)
    setEdit(null)
    await onChanged()
  }

  function exportExcel() {
    const qCols: string[] = []
    for (let i = 1; i <= cfg.n1; i++) qCols.push(`P1.C${i}`)
    for (let i = 1; i <= cfg.n2; i++) TF_KEYS.forEach((k) => qCols.push(`P2.C${i}${k}`))
    for (let i = 1; i <= cfg.n3; i++) qCols.push(`P3.C${i}`)

    const flat = (a: PaperAnswers): string[] => [
      ...a.p1.map((x) => x || ''),
      ...a.p2.flatMap((q) => q.map((x) => tfLabel(x))),
      ...a.p3.map((x) => x || ''),
    ]

    // Sheet 1: kết quả
    const head = [
      'STT',
      ...(phach ? ['Mã phách', 'Số phách'] : []),
      'Họ và tên',
      phach ? 'Lớp' : 'Lớp (phiếu ghi)',
      'Mã đề',
      'Điểm P1',
      'Điểm P2',
      'Điểm P3',
      'Tổng điểm',
      'Số ô sửa tay',
      ...qCols,
    ]
    const rows: (string | number)[][] = [head]
    sorted.forEach((s, i) => {
      rows.push([
        i + 1,
        ...(phach ? [s.ma_phach || '', s.so_phach || ''] : []),
        s.student_name,
        s.class_label || '',
        s.ma_de,
        s.part_scores.p1,
        s.part_scores.p2,
        s.part_scores.p3,
        s.score,
        (s.edited_cells || []).length,
        ...flat(s.answers),
      ])
    })
    missing.forEach((s) => rows.push(['', s.full_name, '', '', '', '', '', 'Chưa có phiếu', '']))
    const ws1 = XLSX.utils.aoa_to_sheet(rows)
    ws1['!cols'] = [
      { wch: 5 },
      ...(phach ? [{ wch: 10 }, { wch: 9 }] : []),
      { wch: 26 },
      { wch: 10 },
      { wch: 8 },
      { wch: 8 },
      { wch: 8 },
      { wch: 8 },
      { wch: 10 },
      { wch: 8 },
    ]

    // Sheet 2: đáp án
    const keyRows: string[][] = [['Mã đề', ...qCols]]
    keys.forEach((k) => keyRows.push([k.ma_de, ...flat(k.answers)]))
    const ws2 = XLSX.utils.aoa_to_sheet(keyRows)

    // Sheet 3: tỉ lệ đúng từng câu theo mã đề
    const statRows: (string | number)[][] = [['Mã đề', 'Câu', 'Số phiếu', 'Số đúng', 'Tỉ lệ đúng (%)']]
    for (const k of keys) {
      const group = sheets.filter((s) => s.ma_de === k.ma_de)
      if (!group.length) continue
      const results = group.map((s) => scorePaper(s.answers, k.answers, cfg).correct)
      const ids: [string, CellId][] = []
      for (let i = 1; i <= cfg.n1; i++) ids.push([`P1.C${i}`, `1.${i}`])
      for (let i = 1; i <= cfg.n2; i++) TF_KEYS.forEach((t) => ids.push([`P2.C${i}${t}`, `2.${i}${t}`]))
      for (let i = 1; i <= cfg.n3; i++) ids.push([`P3.C${i}`, `3.${i}`])
      for (const [label, id] of ids) {
        const ok = results.filter((r) => r[id]).length
        statRows.push([k.ma_de, label, group.length, ok, Math.round((ok / group.length) * 1000) / 10])
      }
    }
    const ws3 = XLSX.utils.aoa_to_sheet(statRows)

    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws1, 'Kết quả')
    XLSX.utils.book_append_sheet(wb, ws2, 'Đáp án')
    XLSX.utils.book_append_sheet(wb, ws3, 'Tỉ lệ đúng')
    const safe = stripVN(batch.title).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'cham_phieu'
    XLSX.writeFile(wb, `${safe}_ket_qua.xlsx`)
  }

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ margin: 0 }}>Kết quả</h2>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {phach && (
            <>
              <button className="btn secondary" onClick={exportPhachTemplate} disabled={!sheets.length} title="File Excel đã điền sẵn các phách đã chấm">
                ⬇ File ghép phách
              </button>
              <button className="btn secondary" onClick={() => mergeRef.current?.click()} disabled={!sheets.length}>
                🔗 Ghép phách từ Excel
              </button>
              <input ref={mergeRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} onChange={importPhach} />
            </>
          )}
          <button className="btn" onClick={exportExcel} disabled={!sheets.length}>
            📊 Xuất Excel
          </button>
        </div>
      </div>
      {phach && (
        <p style={{ fontSize: 13, color: 'var(--muted)', margin: '6px 0 0' }}>
          Ghép phách: bấm "File ghép phách" để tải danh sách phách đã chấm, điền cột Họ và tên, Lớp rồi bấm "Ghép phách từ Excel". File
          tự làm cũng được, chỉ cần có các cột Mã phách, Số phách, Họ và tên (Lớp tuỳ chọn).
        </p>
      )}
      {mergeMsg && <p style={{ whiteSpace: 'pre-line', fontSize: 13.5 }}>{mergeMsg}</p>}
      <div className="stat-cards" style={{ marginTop: 12 }}>
        <div className="stat-card">
          <div className="value">{sheets.length}</div>
          <div className="label">Phiếu đã chấm</div>
        </div>
        <div className="stat-card">
          <div className="value">{avg}</div>
          <div className="label">Điểm trung bình</div>
        </div>
        {roster.length > 0 && (
          <div className="stat-card">
            <div className="value">{missing.length}</div>
            <div className="label">HS chưa có phiếu</div>
          </div>
        )}
      </div>

      <table className="list">
        <thead>
          <tr>
            <th>STT</th>
            {phach && <th>Phách</th>}
            <th>Họ và tên</th>
            <th>Mã đề</th>
            <th>P1</th>
            <th>P2</th>
            <th>P3</th>
            <th>Tổng</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((s, i) => {
            const key = keys.find((k) => k.ma_de === s.ma_de)
            const isOpen = open === s.id
            const isEdit = edit?.id === s.id
            return (
              <Fragment key={s.id}>
                <tr>
                  <td>{i + 1}</td>
                  {phach && (
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {s.ma_phach} – {s.so_phach}
                    </td>
                  )}
                  <td>
                    {s.student_name || (phach ? <span style={{ color: 'var(--muted)' }}>(chưa ghép)</span> : '')}
                    {phach && s.class_label ? <span style={{ color: 'var(--muted)' }}> · {s.class_label}</span> : null}
                    {!phach && !s.student_id && <span className="badge warn" style={{ marginLeft: 6 }}>ngoài DS lớp</span>}
                    {(s.edited_cells || []).length > 0 && (
                      <span className="badge" style={{ marginLeft: 6 }} title={(s.edited_cells || []).join(', ')}>
                        sửa {(s.edited_cells || []).length} ô
                      </span>
                    )}
                  </td>
                  <td>{s.ma_de}</td>
                  <td>{s.part_scores.p1}</td>
                  <td>{s.part_scores.p2}</td>
                  <td>{s.part_scores.p3}</td>
                  <td>
                    <b>{s.score}</b>
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn secondary" style={{ padding: '3px 10px', fontSize: 12 }} onClick={() => setOpen(isOpen ? null : s.id)}>
                      {isOpen ? 'Đóng' : 'Xem'}
                    </button>{' '}
                    <button className="btn danger" style={{ padding: '3px 10px', fontSize: 12 }} onClick={() => remove(s)}>
                      Xoá
                    </button>
                  </td>
                </tr>
                {isOpen && (
                  <tr>
                    <td colSpan={phach ? 9 : 8} style={{ background: '#fafafa' }}>
                      {isEdit ? (
                        <>
                          {phach && (
                            <div style={{ display: 'flex', gap: 8 }}>
                              <div style={{ width: 140 }}>
                                <label>Mã phách</label>
                                <input value={edit.maPhach} onChange={(e) => setEdit({ ...edit, maPhach: e.target.value })} />
                              </div>
                              <div style={{ width: 120 }}>
                                <label>Số phách</label>
                                <input value={edit.soPhach} onChange={(e) => setEdit({ ...edit, soPhach: e.target.value })} />
                              </div>
                            </div>
                          )}
                          <label>Mã đề</label>
                          <select value={edit.maDe} onChange={(e) => setEdit({ ...edit, maDe: e.target.value })} style={{ width: 150 }}>
                            {keys.map((k) => (
                              <option key={k.id} value={k.ma_de}>
                                {k.ma_de}
                              </option>
                            ))}
                          </select>
                          <PaperAnswerGrid cfg={cfg} value={edit.answers} onChange={(v) => setEdit({ ...edit, answers: v })} />
                          <button className="btn" onClick={saveEdit}>
                            Lưu & chấm lại
                          </button>{' '}
                          <button className="btn secondary" onClick={() => setEdit(null)}>
                            Huỷ
                          </button>
                        </>
                      ) : (
                        <>
                          <p style={{ margin: '4px 0', fontSize: 13, color: 'var(--muted)' }}>
                            Phiếu ghi tên: {s.name_read || '—'} · {answersToText(s.answers)}
                          </p>
                          <PaperAnswerGrid
                            cfg={cfg}
                            value={s.answers}
                            correct={key ? scorePaper(s.answers, key.answers, cfg).correct : undefined}
                            answerKey={key?.answers}
                          />
                          <button className="btn secondary" onClick={() => setEdit({ id: s.id, answers: s.answers, maDe: s.ma_de, maPhach: s.ma_phach || '', soPhach: s.so_phach || '' })}>
                            Sửa bài làm
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
          {!sheets.length && (
            <tr>
              <td colSpan={phach ? 9 : 8} style={{ color: 'var(--muted)' }}>
                Chưa có phiếu nào được lưu.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {missing.length > 0 && (
        <p style={{ fontSize: 13, color: 'var(--muted)' }}>
          <b>Chưa có phiếu:</b> {missing.map((s) => s.full_name).join(', ')}
        </p>
      )}
    </div>
  )
}
