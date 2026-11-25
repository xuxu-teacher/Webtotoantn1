import { ChangeEvent, Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import * as XLSX from 'xlsx'
import { supabase } from '../lib/supabase'
import { connectDrive, disconnectDrive, driveConfigured, driveConnected, driveOriginOk, driveViewUrl, mainUrlForHere, onDriveChange, uploadImage } from '../lib/drive'
import { useAuth } from '../auth'
import CameraCapture from '../components/CameraCapture'
import PaperAnswerGrid from '../components/PaperAnswerGrid'
import {
  CellId,
  NameMatch,
  PaperAnswers,
  PaperConfig,
  SheetKind,
  PartScores,
  ReadResult,
  StudentLite,
  TF_KEYS,
  answersToText,
  emptyAnswers,
  filesToImages,
  fitAnswers,
  invalidShortKeys,
  unfillableP3Keys,
  p3Bubble,
  isBubbleSheet,
  keyIsComplete,
  KeyTableItem,
  normalizeConfig,
  countFlagKinds,
  flagKind,
  FLAG_KIND_LABEL,
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
  shrinkJpeg,
  stripVN,
  tfLabel,
} from '../utils/omr'
import { downloadSheetPdf, openPrintSheets } from '../utils/printSheets'
import { GRID35_LIMITS, P3_GRID_MAX, SCHOOL_LIMITS, describeClassPaper, fitsA4, fitsHalfA4 } from '../utils/sheetTemplates'
import { renderGradedOverlay } from '../utils/overlay'
import GradedImage from '../components/GradedImage'
import ResultSummary from '../components/ResultSummary'

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
  /** mã file ảnh phiếu gốc / ảnh máy đọc trong Google Drive của giáo viên */
  image_drive_id?: string | null
  overlay_drive_id?: string | null
  /** cảnh báo máy đưa ra lúc đọc phiếu (giáo viên đã rà trước khi lưu) */
  read_flags?: Record<CellId, string> | null
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
  /** giáo viên đã tự chọn mã đề (không tự khớp lại khi danh sách đáp án thay đổi) */
  maDePicked?: boolean
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

/** Chuẩn hoá mã đề để so khớp: bỏ khoảng trắng/dấu, không phân biệt hoa thường, bỏ số 0 ở đầu ("0502" = "502") */
const normMaDe = (v: string | null | undefined) =>
  String(v ?? '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/^0+(?=\d)/, '')

/**
 * Khớp mã đề đọc được trên phiếu với các mã đề ĐÃ CÓ ĐÁP ÁN của đợt chấm.
 * Nguyên tắc: KHÔNG BAO GIỜ tự gán một mã đề khác với mã ghi trên phiếu
 * (trước đây đợt chấm chỉ có 1 mã thì phiếu ghi 502, 503… vẫn bị gán và chấm theo mã đó).
 */
function matchMaDe(read: string | null | undefined, ks: KeyRow[]): { maDe: string; flag?: string } {
  const readMa = normMaDe(read)
  const exact = readMa ? ks.find((k) => normMaDe(k.ma_de) === readMa) : undefined
  if (exact) return { maDe: exact.ma_de }
  if (readMa)
    return {
      maDe: '',
      flag: `Phiếu ghi mã "${String(read).trim()}" nhưng đợt chấm chưa có đáp án mã này (đang có: ${ks.map((k) => k.ma_de).join(', ')}). Nhập đáp án mã ${String(read).trim()} ở tab "1. Đáp án", hoặc chọn mã đề đúng nếu máy đọc nhầm`,
    }
  // không đọc được mã đề: đợt chấm chỉ có 1 mã thì dùng mã đó, nhiều mã thì giáo viên chọn
  if (ks.length === 1) return { maDe: ks[0].ma_de }
  return { maDe: '', flag: 'Không đọc được mã đề — hãy chọn' }
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

/** Xuất Excel kết quả: bảng điểm (không có cột Phần III khi đợt chấm không chấm Phần III), đáp án, tỉ lệ đúng từng câu */
function exportBatchExcel(batch: Batch, cfg: PaperConfig, keys: KeyRow[], sheets: SheetRow[], roster: StudentLite[]) {
  const phach = cfg.identity === 'phach'
  const hasP3 = cfg.n3 > 0
  const sorted = [...sheets].sort((a, b) =>
    phach
      ? normMaPhach(a.ma_phach).localeCompare(normMaPhach(b.ma_phach), 'vi', { numeric: true }) ||
        normSoPhach(a.so_phach).localeCompare(normSoPhach(b.so_phach), 'vi', { numeric: true })
      : vnNameCompare(a.student_name, b.student_name),
  )
  const missing = phach ? [] : roster.filter((s) => !sheets.some((x) => x.student_id === s.id))
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
    ...(hasP3 ? ['Điểm P3'] : []),
    'Tổng điểm',
    'Số câu đúng',
    'Số ô sửa tay',
    ...qCols,
  ]
  const rows: (string | number)[][] = [head]
  sorted.forEach((s, i) => {
    const key = keys.find((k) => k.ma_de === s.ma_de)
    const nRight = key ? countRight(scorePaper(s.answers, key.answers, cfg).correct) : ''
    rows.push([
      i + 1,
      ...(phach ? [s.ma_phach || '', s.so_phach || ''] : []),
      s.student_name,
      s.class_label || '',
      s.ma_de,
      s.part_scores.p1,
      s.part_scores.p2,
      ...(hasP3 ? [s.part_scores.p3] : []),
      s.score,
      nRight,
      (s.edited_cells || []).length,
      ...flat(s.answers),
    ])
  })
  missing.forEach((s) => {
    const r: (string | number)[] = new Array(head.length - qCols.length).fill('')
    r[1] = s.full_name
    r[head.indexOf('Tổng điểm')] = 'Chưa có phiếu'
    rows.push(r)
  })
  const ws1 = XLSX.utils.aoa_to_sheet(rows)
  ws1['!cols'] = head.slice(0, head.length - qCols.length).map((h) => ({ wch: h === 'Họ và tên' ? 26 : Math.max(8, h.length + 2) }))

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

/** Số câu làm đúng: Phần I, III theo câu; Phần II tính câu đúng đủ 4 ý */
function countRight(correct: Record<CellId, boolean>): number {
  let n = 0
  const p2: Record<string, number> = {}
  for (const [id, ok] of Object.entries(correct)) {
    if (id.startsWith('2.')) {
      const q = id.slice(0, -1)
      p2[q] = (p2[q] || 0) + (ok ? 1 : 0)
    } else if (ok) n++
  }
  return n + Object.values(p2).filter((v) => v === 4).length
}

export default function TeacherPaperGradingDetail() {
  const { batchId } = useParams()
  const { teacher } = useAuth()
  const [batch, setBatch] = useState<Batch | null>(null)
  const [keys, setKeys] = useState<KeyRow[]>([])
  const [sheets, setSheets] = useState<SheetRow[]>([])
  const [roster, setRoster] = useState<StudentLite[]>([])
  const [loadError, setLoadError] = useState('')
  const [tab, setTab] = useState<'key' | 'grade' | 'result'>('key')
  const [rescoring, setRescoring] = useState(false)
  const [pdfBusy, setPdfBusy] = useState(false)
  // số phiếu đang chờ rà (có cảnh báo) trong hàng đợi chấm
  const [queueStats, setQueueStats] = useState({ review: 0, warn: 0, waiting: 0 })
  // bấm "Quét bài" -> mở camera ở tab Chấm phiếu
  const [cameraSignal, setCameraSignal] = useState(0)
  // mã đề cần nhập đáp án (bấm từ tab Chấm phiếu) -> tab Đáp án mở sẵn ô nhập với mã này
  const [wantKey, setWantKey] = useState<{ maDe: string; n: number } | null>(null)
  const firstLoad = useRef(true)

  const cfg = batch?.config

  async function loadAll() {
    if (!batchId) return
    const { data: b, error } = await supabase.from('paper_batches').select('id, title, class_id, config').eq('id', batchId).single()
    if (error || !b) return setLoadError(error?.message || 'Không tìm thấy đợt chấm.')
    const c = normalizeConfig((b as Batch).config)
    setBatch({ ...(b as Batch), config: c })
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

  const stats = useMemo(() => {
    const scores = sheets.map((s) => s.score)
    const n = scores.length
    return {
      n,
      avg: n ? Math.round((scores.reduce((t, v) => t + v, 0) / n) * 100) / 100 : 0,
      hi: n ? Math.max(...scores) : 0,
      lo: n ? Math.min(...scores) : 0,
      warned: sheets.filter((s) => s.read_flags && Object.keys(s.read_flags).length).length,
    }
  }, [sheets])

  if (loadError)
    return (
      <div className="container">
        <div className="notice err">{loadError}</div>
        <Link to="/cham-phieu">← Danh sách đợt chấm</Link>
      </div>
    )
  if (!batch || !cfg || !teacher)
    return (
      <div className="container">
        <p>Đang tải…</p>
      </div>
    )

  /** Lưu cấu hình mới của đợt chấm (giữ nguyên đáp án, phiếu) */
  async function saveConfig(next: PaperConfig): Promise<boolean> {
    if (!batch) return false
    const { error } = await supabase.from('paper_batches').update({ config: next }).eq('id', batch.id)
    if (error) {
      alert(error.message)
      return false
    }
    await loadAll()
    return true
  }

  /** Đổi cách tính điểm Phần 2 (thang Bộ / chia đều) và chấm lại mọi phiếu đã lưu theo đáp án hiện có */
  async function changeTfMethod(m: PaperConfig['tfMethod']) {
    if (!batch || !cfg || m === cfg.tfMethod) return
    const label = m === 'ministry_partial' ? 'thang Bộ GDĐT' : 'chia đều'
    if (sheets.length && !confirm(`Đổi Phần 2 sang ${label} và chấm lại ${sheets.length} phiếu đã lưu?`)) return
    setRescoring(true)
    try {
      const next: PaperConfig = { ...cfg, tfMethod: m }
      const { error } = await supabase.from('paper_batches').update({ config: next }).eq('id', batch.id)
      if (error) throw error
      let n = 0
      for (const s of sheets) {
        const key = keys.find((k) => k.ma_de === s.ma_de)
        if (!key) continue
        const sc = scorePaper(s.answers, key.answers, next)
        const r = await supabase
          .from('paper_sheets')
          .update({
            score: sc.total,
            part_scores: { p1: sc.p1, p2: sc.p2, p3: sc.p3, total: sc.total, max: sc.max },
            updated_at: new Date().toISOString(),
          })
          .eq('id', s.id)
        if (r.error) throw r.error
        n++
      }
      await loadAll()
      if (sheets.length) alert(`Đã đổi sang ${label} và chấm lại ${n} phiếu.`)
    } catch (e) {
      alert((e as Error).message)
    } finally {
      setRescoring(false)
    }
  }

  /** Chọn nhầm loại phiếu khi tạo đợt: đổi loại phiếu (đáp án giữ nguyên) — chỉ khi chưa lưu phiếu nào */
  async function switchSheet(to: SheetKind) {
    if (!batch || !cfg || to === cfg.sheet) return
    if (sheets.length) return alert('Đợt chấm đã có phiếu được lưu nên không đổi loại phiếu được. Hãy tạo đợt chấm mới.')
    const L = to === 'school' ? SCHOOL_LIMITS : to === 'grid35' ? GRID35_LIMITS : null
    if (L && (cfg.n1 > L.n1 || cfg.n2 > L.n2 || cfg.n3 > L.n3))
      return alert(
        to === 'school'
          ? `Phiếu của trường chỉ có ${L.n1} – ${L.n2} – ${L.n3} câu, đợt chấm này có ${cfg.n1} – ${cfg.n2} – ${cfg.n3} câu.`
          : `Phiếu 35 câu chỉ có ${L.n1} câu trắc nghiệm A–D (không có Phần 2, Phần 3), đợt chấm này có ${cfg.n1} – ${cfg.n2} – ${cfg.n3} câu.`,
      )
    if (to === 'class' && cfg.n3 > P3_GRID_MAX) return alert(`Phiếu web tạo: Phần III (lưới tô ô) tối đa ${P3_GRID_MAX} câu, đợt chấm này có ${cfg.n3} câu.`)
    // đổi sang phiếu web tạo: phiếu sẽ in mới nên dùng Phần III lưới tô
    const asClass: PaperConfig = { ...cfg, p3Mode: 'bubble' }
    if (to === 'class' && !fitsA4(asClass)) return alert('Đề quá dài, phiếu không vừa 1 trang A4.')
    const next: PaperConfig =
      to === 'class'
        ? { ...asClass, sheet: 'class', identity: 'name', paper: fitsHalfA4(asClass) ? 'A5' : 'A4', bigBubbles: !fitsHalfA4(asClass), parts: undefined }
        : { ...cfg, sheet: to, identity: 'phach', paper: undefined, bigBubbles: undefined, parts: to === 'school' ? cfg.parts || 'all' : undefined, p3Mode: undefined }
    await saveConfig(next)
  }

  /** Đổi khổ phiếu lớp (nửa trang / 1 trang). Đổi được bất cứ lúc nào — điểm đã lưu không đổi */
  async function changePaper(p: 'A5' | 'A4') {
    if (!cfg || cfg.sheet !== 'class') return
    const cur = cfg.paper === 'A5' ? 'A5' : 'A4'
    if (p === cur) return
    if (p === 'A5' && !fitsHalfA4(cfg))
      return alert(p3Bubble(cfg) ? 'Phần III lưới tô cần 1 trang A4 — nửa trang chỉ dùng khi đề không có Phần III.' : 'Đề này quá dài, không vừa nửa trang A4.')
    if (!confirm('Đổi khổ phiếu? Phiếu đã in theo khổ cũ sẽ KHÔNG quét được với khổ mới — chỉ đổi khi cô chưa in phiếu hoặc sẽ in lại.')) return
    await saveConfig({ ...cfg, paper: p, bigBubbles: p === 'A4' })
  }

  /** Phiếu trường: đổi phạm vi chấm (chỉ P1+P2 / cả 3 phần) — chỉ khi chưa lưu phiếu nào */
  async function changeParts(p: 'p12' | 'all') {
    if (!cfg || cfg.sheet !== 'school') return
    if ((cfg.parts === 'p12' ? 'p12' : 'all') === p) return
    if (sheets.length) return alert('Đợt chấm đã có phiếu được lưu nên không đổi phạm vi chấm được. Hãy tạo đợt chấm mới.')
    if (p === 'p12') return void saveConfig({ ...cfg, parts: 'p12', n3: 0 })
    const v = prompt(`Chấm cả Phần III: Phần III có mấy câu? (tối đa ${SCHOOL_LIMITS.n3})`, '6')
    const n3 = Math.round(Number(v))
    if (!v || !Number.isFinite(n3) || n3 < 1 || n3 > SCHOOL_LIMITS.n3) return
    const ok = await saveConfig({ ...cfg, parts: 'all', n3 })
    if (ok && keys.length) alert('Đã bật Phần III. Hãy bổ sung đáp án Phần III cho từng mã đề ở tab "1. Đáp án" trước khi chấm.')
  }

  async function pdf() {
    if (!cfg || !batch) return
    setPdfBusy(true)
    try {
      await downloadSheetPdf(cfg, batch.title)
    } catch (e) {
      alert((e as Error).message)
    } finally {
      setPdfBusy(false)
    }
  }

  const tabBtn = (t: typeof tab, label: string, count?: number) => (
    <button type="button" className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
      {label}
      {count !== undefined && <span className="count">{count}</span>}
    </button>
  )
  const sheetName =
    cfg.sheet === 'school'
      ? 'Phiếu của trường (phách)'
      : cfg.sheet === 'grid35'
        ? 'Phiếu 35 câu (phách)'
        : cfg.sheet === 'class'
          ? 'Phiếu tô ô do web tạo'
          : 'Phiếu viết tay (kiểu cũ)'
  const incompleteKeys = keys.filter((k) => !keyIsComplete(k.answers, cfg))

  return (
    <div className="container wide">
      <Link to="/cham-phieu" className="back-link">
        ← Danh sách đợt chấm
      </Link>
      <div className="page-head">
        <div>
          <h1 style={{ marginBottom: 6 }}>{batch.title}</h1>
          <div className="toolbar" style={{ gap: 6 }}>
            <span className="badge">{sheetName}</span>
            {cfg.sheet === 'class' && <span className="badge gray">{describeClassPaper(cfg, cfg.paper, cfg.bigBubbles)}</span>}
            <span className="badge gray">
              P1: {cfg.n1} × {cfg.p1}đ
            </span>
            {cfg.n2 > 0 && (
              <span className="badge gray">
                P2: {cfg.n2} × {cfg.p2}đ
              </span>
            )}
            {cfg.n3 > 0 ? (
              <span className={`badge gray ${p3Bubble(cfg) ? 'p3grid' : ''}`}>
                P3: {cfg.n3} × {cfg.p3}đ{cfg.sheet === 'class' ? (p3Bubble(cfg) ? ' · tô ô' : ' · viết tay') : ''}
              </span>
            ) : (
              cfg.sheet !== 'grid35' && <span className="badge warn">Phần III: không chấm</span>
            )}
            {cfg.identity !== 'phach' && !batch.class_id && <span className="badge warn">Không gắn lớp</span>}
          </div>
        </div>
      </div>

      {/* THAO TÁC NHANH */}
      <div className="quick-actions">
        <button
          type="button"
          className="qa orange"
          disabled={!keys.length}
          title={keys.length ? '' : 'Cần nhập đáp án trước'}
          onClick={() => {
            setTab('grade')
            setCameraSignal((n) => n + 1)
          }}
        >
          <span className="ico">📸</span>
          <span>
            Quét bài<small>Camera / ảnh / PDF scan</small>
          </span>
        </button>
        {cfg.sheet === 'class' && (
          <button type="button" className="qa violet" onClick={pdf} disabled={pdfBusy}>
            <span className="ico">⬇</span>
            <span>
              {pdfBusy ? 'Đang tạo PDF…' : 'Tải phiếu (PDF)'}
              <small>
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    openPrintSheets(cfg, batch.title)
                  }}
                >
                  hoặc 🖨 in trực tiếp
                </a>
              </small>
            </span>
          </button>
        )}
        <button type="button" className="qa" onClick={() => setTab('key')}>
          <span className="ico">🔑</span>
          <span>
            Nhập đáp án<small>{keys.length ? `${keys.length} mã đề` : 'Chưa có mã đề nào'}</small>
          </span>
        </button>
        <button type="button" className="qa green" disabled={!sheets.length} onClick={() => exportBatchExcel(batch, cfg, keys, sheets, roster)}>
          <span className="ico">📊</span>
          <span>
            Xuất Excel<small>Bảng điểm + tỉ lệ đúng</small>
          </span>
        </button>
      </div>

      {/* THỐNG KÊ NHANH */}
      <div className="stat-cards">
        <div className="stat-card">
          <span className="icon">📝</span>
          <div>
            <div className="value">{stats.n}</div>
            <div className="label">Bài đã chấm{cfg.identity !== 'phach' && roster.length ? ` / ${roster.length} HS` : ''}</div>
          </div>
        </div>
        <div className="stat-card green">
          <span className="icon">⭐</span>
          <div>
            <div className="value">{stats.avg}</div>
            <div className="label">Điểm trung bình</div>
          </div>
        </div>
        <div className="stat-card violet">
          <span className="icon">📈</span>
          <div>
            <div className="value">{stats.n ? `${stats.hi} / ${stats.lo}` : '—'}</div>
            <div className="label">Cao nhất / thấp nhất</div>
          </div>
        </div>
        <div className="stat-card orange">
          <span className="icon">⚠️</span>
          <div>
            <div className="value">{queueStats.warn}</div>
            <div className="label">
              Bài cần kiểm tra{stats.warned ? ` · ${stats.warned} bài đã lưu từng có cảnh báo` : ''}
            </div>
          </div>
        </div>
      </div>

      {incompleteKeys.length > 0 && (
        <div className="notice warn">
          Đáp án mã đề <b>{incompleteKeys.map((k) => k.ma_de).join(', ')}</b> chưa đủ theo cấu trúc hiện tại
          {cfg.n3 > 0 ? ' (thường do vừa bật chấm Phần III)' : ''} — bổ sung ở tab "1. Đáp án" thì mới chấm được các mã này.
        </div>
      )}

      <div className="card" style={{ padding: '12px 16px' }}>
        <div className="toolbar" style={{ gap: '8px 18px' }}>
          {cfg.n2 > 0 && (
            <span className="small">
              Điểm Phần II:{' '}
              <select
                value={cfg.tfMethod}
                disabled={rescoring}
                onChange={(e) => changeTfMethod(e.target.value as PaperConfig['tfMethod'])}
                title="Đổi cách tính điểm Phần 2 — các phiếu đã lưu được chấm lại ngay"
                style={{ display: 'inline-block', width: 'auto', maxWidth: '100%', margin: 0, padding: '4px 8px', fontSize: 13 }}
              >
                <option value="ministry_partial">Thang Bộ GDĐT (1 ý 10%, 2 ý 25%, 3 ý 50%, 4 ý 100%)</option>
                <option value="equal_split">Chia đều (mỗi ý 25%)</option>
              </select>
              {rescoring && ' đang chấm lại…'}
            </span>
          )}
          {cfg.sheet === 'class' && (
            <span className="small">
              Khổ phiếu:{' '}
              <span className="seg small">
                <button type="button" className={cfg.paper === 'A5' ? 'on' : ''} disabled={!fitsHalfA4(cfg)} onClick={() => changePaper('A5')}>
                  Nửa trang A4
                </button>
                <button type="button" className={cfg.paper !== 'A5' ? 'on' : ''} onClick={() => changePaper('A4')}>
                  1 trang A4
                </button>
              </span>
            </span>
          )}
          {cfg.sheet === 'school' && (
            <span className="small">
              Phạm vi chấm:{' '}
              <span className="seg small">
                <button type="button" className={cfg.parts === 'p12' ? 'on' : ''} disabled={!!sheets.length} onClick={() => changeParts('p12')}>
                  Chỉ Phần I + II
                </button>
                <button type="button" className={cfg.parts !== 'p12' ? 'on' : ''} disabled={!!sheets.length} onClick={() => changeParts('all')}>
                  Cả 3 phần
                </button>
              </span>
            </span>
          )}
          {isBubbleSheet(cfg) && !sheets.length && (
            <select
              value=""
              onChange={(e) => e.target.value && switchSheet(e.target.value as SheetKind)}
              title="Chọn nhầm loại phiếu khi tạo đợt? Đổi ở đây (chỉ khi chưa lưu phiếu nào)"
              style={{ display: 'inline-block', width: 'auto', maxWidth: '100%', margin: 0, padding: '4px 8px', fontSize: 13 }}
            >
              <option value="">↔ Đổi loại phiếu…</option>
              {cfg.sheet !== 'class' && <option value="class">Phiếu tô ô do web tạo</option>}
              {cfg.sheet !== 'school' && <option value="school">Phiếu của trường (40 – 6 – 8)</option>}
              {cfg.sheet !== 'grid35' && <option value="grid35">Phiếu 35 câu (chữ trong ô)</option>}
            </select>
          )}
        </div>
      </div>

      <div className="tabs">
        {tabBtn('key', '1. Đáp án', keys.length)}
        {tabBtn('grade', '2. Chấm phiếu', queueStats.review || undefined)}
        {tabBtn('result', '3. Kết quả', sheets.length)}
      </div>

      {tab === 'key' && (
        <KeySection
          batchId={batch.id}
          teacherId={teacher.id}
          cfg={cfg}
          keys={keys}
          sheets={sheets}
          onChanged={loadAll}
          wantKey={wantKey}
          onWantKeyDone={() => setWantKey(null)}
        />
      )}
      {/* Giữ trang chấm luôn được gắn để không mất hàng đợi khi chuyển tab */}
      <div style={{ display: tab === 'grade' ? 'block' : 'none' }}>
        <GradeSection
          batchId={batch.id}
          batchTitle={batch.title}
          teacherId={teacher.id}
          cfg={cfg}
          keys={keys}
          roster={roster}
          sheets={sheets}
          onSaved={loadAll}
          hasClass={!!batch.class_id}
          cameraSignal={cameraSignal}
          onStats={setQueueStats}
          onNeedKey={(maDe) => {
            setWantKey((w) => ({ maDe, n: (w?.n || 0) + 1 }))
            setTab('key')
          }}
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
  wantKey?: { maDe: string; n: number } | null
  onWantKeyDone?: () => void
}) {
  const { batchId, teacherId, cfg, keys, sheets, onChanged, wantKey, onWantKeyDone } = props
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

  // Được gọi từ tab Chấm phiếu ("+ Nhập đáp án mã 503"): mở sẵn ô nhập đáp án với mã đề đó
  useEffect(() => {
    if (!wantKey) return
    const old = keys.find((k) => normMaDe(k.ma_de) === normMaDe(wantKey.maDe))
    setDraft(
      old
        ? { id: old.id, maDe: old.ma_de, answers: old.answers, flags: {}, reading: false, error: '' }
        : { maDe: wantKey.maDe, answers: emptyAnswers(cfg), flags: {}, reading: false, error: '' },
    )
    onWantKeyDone?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantKey])

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
      const found = await readKeyTable(imgs, cfg, (i) =>
        setTableMsg(
          i === 0
            ? `Đang đọc bảng đáp án ${imgs.length} trang cùng lúc (ghép bảng bị ngắt trang, 2 lần đối chiếu)…`
            : `Đang đọc bảng đáp án (2 lần đối chiếu) — trang ${i}/${imgs.length}…`,
        ),
      )
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
    if (keys.some((k) => normMaDe(k.ma_de) === normMaDe(maDe) && k.id !== draft.id)) errs.push(`Mã đề ${maDe} đã có đáp án.`)
    if (miss.length) errs.push(`Còn trống: ${miss.join(', ')}.`)
    if (bad.length) errs.push(`Đáp án Phần 3 không phải số: ${bad.join(', ')}.`)
    if (Object.keys(draft.flags).length) errs.push('Còn ô tô vàng chưa rà — kiểm tra rồi bấm "Đã rà xong các ô vàng".')
    if (errs.length) return setDraft({ ...draft, error: errs.join('\n') })
    // Phần III lưới tô: đáp án mà học sinh không tô được trên lưới 4 cột (quá 4 ký tự, dấu phẩy sai cột…) -> không ai chấm đúng được
    const unfill = unfillableP3Keys(draft.answers, cfg)
    if (
      unfill.length &&
      !confirm(
        `Đáp án ${unfill.join(', ')} không tô được trên lưới Phần III (tối đa 4 ký tự; dấu − ở cột 1, dấu phẩy ở cột 2 hoặc 3) nên học sinh sẽ không thể làm đúng. Vẫn lưu?`,
      )
    )
      return

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
        <div className="card-title">
          <span className="num">1</span>
          <h2>Đáp án theo mã đề</h2>
        </div>
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
              {missingKeyCells(k.answers, cfg).length > 0 ? (
                <span className="badge wrong" title={missingKeyCells(k.answers, cfg).join(', ')}>
                  Thiếu {missingKeyCells(k.answers, cfg).length} ô đáp án
                </span>
              ) : (
                <span className="badge ok">✓ Đủ đáp án</span>
              )}
              <span style={{ color: 'var(--muted)', fontSize: 13 }}>{sheets.filter((s) => s.ma_de === k.ma_de).length} phiếu đã chấm</span>
              <button
                className="btn secondary sm"
                onClick={() => setDraft({ id: k.id, maDe: k.ma_de, answers: k.answers, flags: {}, reading: false, error: '' })}
              >
                Sửa
              </button>
              <button className="btn danger soft sm" onClick={() => remove(k)}>
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
        <div className="card accent">
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
          {draft.error && <div className="notice err">{draft.error}</div>}
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
const ROMAN = ['', 'I', 'II', 'III']

function flagLabel(id: string): string {
  if (id === 'made') return 'Mã đề'
  if (id === 'name') return 'Họ tên'
  if (id === 'phach') return 'Phách'
  if (id === 'ai') return 'Phần viết tay'
  if (id === 'all') return 'Cả bảng đáp án'
  if (id === 'img') return 'Chất lượng ảnh'
  const [p, rest] = id.split('.')
  return `Phần ${ROMAN[Number(p)] || p} – ${rest === '*' ? 'số câu' : `câu ${rest}`}`
}

/** Danh sách lý do các ô tô vàng (phân loại: bỏ trống / tô nhiều ô / tô mờ / ảnh kém) + nút xác nhận đã rà */
function FlagList({ flags, onClear }: { flags: Record<CellId, string>; onClear: () => void }) {
  const entries = Object.entries(flags)
  if (!entries.length) return null
  // ảnh kém lên đầu, rồi tô nhiều ô, bỏ trống, tô mờ…
  const order: Record<string, number> = { image: 0, multi: 1, blank: 2, faint: 3, info: 4, other: 5 }
  const sorted = [...entries].sort((a, b) => order[flagKind(a[0], a[1])] - order[flagKind(b[0], b[1])])
  const kinds = countFlagKinds(flags)
  return (
    <div className="flag-box">
      <b>⚠ {entries.length} chỗ cần rà</b>
      <div className="flag-kinds">
        {(Object.keys(kinds) as (keyof typeof kinds)[]).map((k) => (
          <span key={k} className={`badge ${k === 'image' || k === 'multi' ? 'wrong' : 'warn'}`}>
            {FLAG_KIND_LABEL[k]}: {kinds[k]}
          </span>
        ))}
      </div>
      <ul>
        {sorted.map(([id, why]) => {
          const k = flagKind(id, why)
          return (
            <li key={id}>
              <span className={`badge ${k === 'image' || k === 'multi' ? 'wrong' : k === 'info' || k === 'other' ? 'gray' : 'warn'}`}>{FLAG_KIND_LABEL[k]}</span>
              <span>
                <b>{flagLabel(id)}</b>: {why}
              </span>
            </li>
          )
        })}
      </ul>
      <button className="btn secondary sm" onClick={onClear}>
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
  batchTitle: string
  teacherId: string
  cfg: PaperConfig
  keys: KeyRow[]
  roster: StudentLite[]
  sheets: SheetRow[]
  onSaved: () => Promise<void>
  hasClass: boolean
  /** mở tab Đáp án để nhập đáp án cho một mã đề chưa có */
  onNeedKey: (maDe: string) => void
  /** tăng lên 1 -> mở camera (nút "Quét bài" ở đầu trang) */
  cameraSignal?: number
  /** báo số phiếu chờ rà / có cảnh báo cho thẻ thống kê đầu trang */
  onStats?: (s: { review: number; warn: number; waiting: number }) => void
}) {
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [camera, setCamera] = useState(false)
  const [doubleCheck, setDoubleCheck] = useState(true)
  const [importing, setImporting] = useState(false)
  const [msg, setMsg] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const busy = useRef(false)
  const { batchId, batchTitle, teacherId, cfg, keys, roster, sheets, onSaved, hasClass, onNeedKey, cameraSignal, onStats } = props
  useEffect(() => {
    if (cameraSignal && keys.length) setCamera(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraSignal])
  const { teacher } = useAuth()
  const [driveOn, setDriveOn] = useState(driveConnected())
  // giáo viên đã chọn lưu ảnh vào Drive trong phiên này -> khi token hết hạn, lần bấm Lưu kế tiếp tự xin lại
  const driveWanted = useRef(driveConnected())
  useEffect(() => onDriveChange(setDriveOn), [])

  async function connect() {
    try {
      await connectDrive(teacher?.email)
      driveWanted.current = true
      setMsg('Đã kết nối Google Drive — ảnh các phiếu lưu từ giờ sẽ được cất vào Drive của cô.')
    } catch (e) {
      setMsg((e as Error).message)
    }
  }

  /** Lấy lại quyền Drive nếu đã hết hạn (gọi ngay đầu sự kiện bấm Lưu). Trả về lỗi (nếu có) */
  async function ensureDrive(): Promise<string> {
    if (!driveConfigured || !driveWanted.current || driveConnected()) return ''
    try {
      await connectDrive(teacher?.email)
      return ''
    } catch (e) {
      return (e as Error).message
    }
  }

  /** Tải ảnh gốc (nén ~1600px) + ảnh máy đọc lên Drive. Lỗi không chặn việc lưu điểm. */
  async function uploadImages(it: QueueItem, who: string): Promise<{ ids: { image_drive_id?: string; overlay_drive_id?: string }; err: string }> {
    if (!driveConfigured || !driveConnected()) return { ids: {}, err: driveWanted.current ? 'chưa kết nối được Google Drive' : '' }
    const stamp = new Date().toLocaleString('sv-SE').replace(/[: ]/g, '-').slice(0, 16)
    const base = `${who || it.label} – mã ${it.maDe || '?'} – ${stamp}`
    try {
      const img = await shrinkJpeg(it.dataUrl, 1600, 0.8)
      const image_drive_id = await uploadImage(batchTitle, `${base} (ảnh gốc).jpg`, img)
      // ảnh máy đọc: vẽ lớp chấm đúng/sai theo bài làm cuối cùng (đã rà) và đáp án của mã đề
      const key = keys.find((k) => k.ma_de === it.maDe)
      let ov = it.read?.overlay
      if (it.read?.overlayBase && it.read.overlayGeo && it.answers)
        ov = await renderGradedOverlay(it.read.overlayBase, it.read.overlayGeo, it.answers, key?.answers, {}, cfg).catch(() => it.read?.overlay)
      const overlay_drive_id = ov ? await uploadImage(batchTitle, `${base} (máy đọc).jpg`, ov) : undefined
      return { ids: { image_drive_id, ...(overlay_drive_id ? { overlay_drive_id } : {}) }, err: '' }
    } catch (e) {
      return { ids: {}, err: (e as Error).message }
    }
  }

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
        const mm = matchMaDe(r.maDe, ks)
        const maDe = mm.maDe
        if (mm.flag) flags['made'] = mm.flag
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

  // Vừa nhập thêm / sửa / xoá đáp án ở tab 1 -> khớp lại mã đề cho các phiếu đang chờ rà
  // (phiếu giáo viên đã tự chọn mã đề thì giữ nguyên lựa chọn đó)
  const keySig = keys.map((k) => `${k.id}:${k.ma_de}`).join('|')
  useEffect(() => {
    setQueue((q) => {
      let changed = false
      const out = q.map((it) => {
        if (it.status !== 'review' || !it.read) return it
        const stillValid = !!it.maDe && keys.some((k) => k.ma_de === it.maDe)
        if (stillValid && (it.maDePicked || normMaDe(it.read.maDe) === normMaDe(it.maDe))) return it
        const mm = matchMaDe(it.read.maDe, keys)
        const flags = { ...it.flags }
        delete flags['made']
        if (mm.flag) flags['made'] = mm.flag
        if (mm.maDe === it.maDe && flags['made'] === it.flags['made']) return it
        changed = true
        return { ...it, maDe: mm.maDe, maDePicked: false, flags, error: undefined }
      })
      return changed ? out : q
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keySig])

  // Các mã đề ghi trên phiếu (đang chờ rà) mà đợt chấm chưa có đáp án
  const missingCodes = useMemo(() => {
    const m = new Map<string, { code: string; n: number }>()
    for (const it of queue) {
      if (it.status !== 'review' || !it.read?.maDe) continue
      const nk = normMaDe(it.read.maDe)
      if (!nk || keys.some((k) => normMaDe(k.ma_de) === nk)) continue
      const cur = m.get(nk)
      if (cur) cur.n++
      else m.set(nk, { code: it.read.maDe.trim(), n: 1 })
    }
    return [...m.values()].sort((a, b) => a.code.localeCompare(b.code, 'vi', { numeric: true }))
  }, [queue, keys])

  const phach = cfg.identity === 'phach'
  const samePhach = (a: { maPhach: string; soPhach: string }, ma?: string | null, so?: string | null) =>
    normMaPhach(a.maPhach) === normMaPhach(ma) && normSoPhach(a.soPhach) === normSoPhach(so)

  function readyToSave(it: QueueItem): string[] {
    const errs: string[] = []
    if (!it.answers) errs.push('Chưa đọc xong.')
    if (!it.maDe || !keys.some((k) => k.ma_de === it.maDe))
      errs.push(
        it.read?.maDe && !keys.some((k) => normMaDe(k.ma_de) === normMaDe(it.read!.maDe))
          ? `Chưa có đáp án mã đề ${it.read.maDe.trim()} — nhập đáp án ở tab 1 hoặc chọn mã đề khác.`
          : 'Chưa chọn mã đề có đáp án.',
      )
    const kk = keys.find((k) => k.ma_de === it.maDe)
    if (kk && !keyIsComplete(kk.answers, cfg)) errs.push(`Đáp án mã ${kk.ma_de} chưa đủ — bổ sung ở tab 1 rồi lưu.`)
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

  async function saveItem(it: QueueItem, silent = false, driveErr0?: string): Promise<boolean> {
    const errs = readyToSave(it)
    if (errs.length) {
      if (!silent) update(it.uid, { error: errs.join(' ') })
      return false
    }
    // xin lại quyền Drive (nếu hết hạn) ngay đầu sự kiện bấm — trình duyệt chỉ cho mở cửa sổ Google lúc này
    const driveErr1 = driveErr0 ?? (await ensureDrive())
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
    const up = await uploadImages(it, phach ? `Phách ${it.maPhach.trim()}-${it.soPhach.trim()}` : it.studentName.trim())
    const driveErr = driveErr1 || up.err
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
      ...up.ids,
      // cảnh báo lúc máy đọc (để thống kê bài từng cần kiểm tra); cột tuỳ chọn — CSDL cũ chưa có cột vẫn lưu được
      read_flags: it.read?.flags || {},
      updated_at: new Date().toISOString(),
    }
    const write = (r: Record<string, unknown>) =>
      existing
        ? supabase.from('paper_sheets').update(r).eq('id', existing.id).select('id').single()
        : supabase.from('paper_sheets').insert(r).select('id').single()
    let res = await write(row)
    if (res.error && /read_flags/.test(res.error.message || '')) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { read_flags: _omit, ...rest } = row
      res = await write(rest)
    }
    if (res.error) {
      const dup = res.error.code === '23505'
      const noCol = /ma_phach|so_phach|stt|drive_id/.test(res.error.message)
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
    update(it.uid, {
      status: 'saved',
      savedId: res.data.id,
      error: driveErr ? `Đã lưu điểm, nhưng ảnh phiếu CHƯA lưu được vào Google Drive: ${driveErr}` : undefined,
    })
    return true
  }

  async function saveAllReady() {
    const ready = queue.filter((it) => it.status === 'review' && readyToSave(it).length === 0)
    if (!ready.length)
      return setMsg(`Chưa có phiếu nào đủ điều kiện lưu (đã có ${phach ? 'phách' : 'học sinh'}, mã đề và rà hết ô vàng).`)
    const driveErr = await ensureDrive()
    let ok = 0
    for (const it of ready) if (await saveItem(it, true, driveErr)) ok++
    setMsg(`Đã lưu ${ok}/${ready.length} phiếu.`)
    await onSaved()
  }

  const counts = useMemo(() => {
    const c: Record<ItemStatus, number> = { waiting: 0, reading: 0, review: 0, saved: 0, error: 0 }
    queue.forEach((it) => c[it.status]++)
    return c
  }, [queue])
  const warnCount = queue.filter((it) => it.status === 'error' || (it.status === 'review' && Object.keys(it.flags).length > 0)).length
  useEffect(() => {
    onStats?.({ review: counts.review, warn: warnCount, waiting: counts.waiting + counts.reading })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [counts.review, counts.waiting, counts.reading, warnCount])

  if (!keys.length)
    return (
      <div className="card">
        <p>Cần nhập đáp án ít nhất một mã đề ở tab "1. Đáp án" trước khi chấm.</p>
      </div>
    )

  return (
    <>
      <div className="card">
        <div className="card-title">
          <span className="num">2</span>
          <h2>Chấm phiếu bài làm</h2>
        </div>
        <div className="toolbar big">
          <button className="btn accent" onClick={() => setCamera(true)}>
            <span className="ico">📸</span> Bật camera chụp liên tục
          </button>
          <button className="btn secondary" onClick={() => fileRef.current?.click()} disabled={importing}>
            <span className="ico">🖼</span> {importing ? 'Đang mở file…' : 'Chọn ảnh / file scan (PDF)'}
          </button>
          <input ref={fileRef} type="file" multiple accept="image/*,application/pdf" style={{ display: 'none' }} onChange={onFiles} />
          {driveConfigured &&
            (driveOn ? (
              <span style={{ fontSize: 13 }}>
                ☁️ Ảnh phiếu đang lưu vào Google Drive của cô{' '}
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault()
                    driveWanted.current = false
                    disconnectDrive()
                  }}
                >
                  (ngắt)
                </a>
              </span>
            ) : !driveOriginOk() ? (
              mainUrlForHere() ? (
                <a className="btn secondary" href={mainUrlForHere()!} title="Google chỉ cho kết nối Drive khi mở web bằng địa chỉ chính">
                  ☁️ Mở địa chỉ chính để lưu ảnh vào Drive
                </a>
              ) : null
            ) : (
              <button className="btn secondary" onClick={connect} title="Ảnh phiếu gốc + ảnh máy đọc được cất vào Drive của chính cô; web chỉ thấy các file do nó tạo">
                ☁️ Kết nối Google Drive để lưu ảnh phiếu
              </button>
            ))}
          <label className="check small">
            <input type="checkbox" checked={doubleCheck} onChange={(e) => setDoubleCheck(e.target.checked)} />
            {isBubbleSheet(cfg)
              ? 'Chữ viết tay (mã đề, phách/họ tên, Phần III) đọc 2 lần bằng 2 model để đối chiếu'
              : 'Đọc 2 lần bằng 2 model để đối chiếu (chính xác hơn, tốn gấp đôi lượt AI)'}
          </label>
        </div>
        <p className="small muted" style={{ margin: '10px 0 6px' }}>File PDF scan nhiều trang: mỗi trang là một phiếu.</p>
        <div className="toolbar" style={{ gap: 6 }}>
          <span className="badge gray">⏳ Chờ đọc {counts.waiting + counts.reading}</span>
          <span className="badge warn">⚠ Cần rà {counts.review}</span>
          <span className="badge ok">✓ Đã lưu {counts.saved}</span>
          {counts.error > 0 && <span className="badge wrong">✗ Lỗi {counts.error}</span>}
        </div>
        <div className="toolbar" style={{ marginTop: 10 }}>
          <button className="btn success" onClick={saveAllReady} disabled={!counts.review}>
            💾 Lưu tất cả phiếu đã sẵn sàng
          </button>
          {counts.saved > 0 && (
            <button className="btn secondary" onClick={() => setQueue((q) => q.filter((it) => it.status !== 'saved'))}>
              Ẩn các phiếu đã lưu
            </button>
          )}
        </div>
        {msg && <div className="notice info">{msg}</div>}
        {missingCodes.length > 0 && (
          <div className="notice warn">
            <b>⚠ Chưa có đáp án cho mã đề ghi trên phiếu:</b>{' '}
            {missingCodes.map((m) => `${m.code} (${m.n} phiếu)`).join(', ')}. Đợt chấm hiện chỉ có đáp án mã{' '}
            {keys.map((k) => k.ma_de).join(', ')} nên các phiếu này <b>chưa được chấm</b>. Nhập đáp án xong, phiếu sẽ tự khớp đúng mã đề.
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
              {missingCodes.map((m) => (
                <button key={m.code} className="btn secondary" style={{ padding: '3px 10px', fontSize: 12 }} onClick={() => onNeedKey(m.code)}>
                  + Nhập đáp án mã {m.code}
                </button>
              ))}
            </div>
          </div>
        )}
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
          onNeedKey={onNeedKey}
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
  onNeedKey: (maDe: string) => void
  onSave: () => void
  onRetry: () => void
  onRemove: () => void
}) {
  const { index, it, cfg, keys, roster, sheets, issues, onPatch, onNeedKey, onSave, onRetry, onRemove } = props
  const key = keys.find((k) => k.ma_de === it.maDe)
  const readCode = (it.read?.maDe || '').trim()
  // mã ghi trên phiếu chưa có đáp án trong đợt chấm
  const readNoKey = !!readCode && !keys.some((k) => normMaDe(k.ma_de) === normMaDe(readCode))
  // giáo viên đang chấm theo mã khác với mã ghi trên phiếu
  const differs = !!readCode && !!it.maDe && normMaDe(readCode) !== normMaDe(it.maDe)
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

  const kinds = countFlagKinds(it.flags)
  const nRight = sc ? countRight(sc.correct) : 0
  const nAll = cfg.n1 + cfg.n2 + cfg.n3

  return (
    <div className={`card queue-card ${saved ? 'saved' : ''}`}>
      <div className="qc-head">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <b>Phiếu {index}</b> {statusBadge}
          <span className="muted small">{it.label}</span>
          {it.status === 'review' &&
            (Object.keys(kinds) as (keyof typeof kinds)[]).map((k) => (
              <span key={k} className={`badge ${k === 'image' || k === 'multi' ? 'wrong' : 'warn'}`}>
                {FLAG_KIND_LABEL[k]} {kinds[k]}
              </span>
            ))}
        </div>
        {sc && (
          <div className="qc-score">
            <span>
              P1 <b>{sc.p1}</b>
            </span>
            {cfg.n2 > 0 && (
              <span>
                P2 <b>{sc.p2}</b>
              </span>
            )}
            {cfg.n3 > 0 && (
              <span>
                P3 <b>{sc.p3}</b>
              </span>
            )}
            <span className="badge ok">
              ✓ {nRight}/{nAll} câu
            </span>
            <span>
              <span className="total">{sc.total}</span>/{sc.max}
            </span>
          </div>
        )}
      </div>
      {it.read?.model && <p className="small muted" style={{ margin: '-4px 0 8px' }}>{it.read.model}</p>}

      <div className="qc-body">
        <GradedImage
          cfg={cfg}
          base={it.read?.overlayBase}
          geo={it.read?.overlayGeo}
          fallback={it.read?.overlay || it.dataUrl}
          original={it.dataUrl}
          answers={it.answers}
          answerKey={key?.answers}
          flags={saved ? {} : it.flags}
          width={it.read?.overlay ? 380 : 260}
          alt={it.label}
        />
        <div className="qc-main">
          {it.status === 'error' && (
            <>
              <div className="notice err">{it.error}</div>
              <div className="toolbar">
                <button className="btn secondary" onClick={onRetry}>
                  ↻ Đọc lại
                </button>
                <button className="btn danger soft" onClick={onRemove}>
                  Bỏ phiếu này
                </button>
              </div>
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
                        className={it.flags['phach'] ? 'input-flag' : undefined}
                        onChange={(e) => onPatch({ maPhach: e.target.value, flags: clearFlag('phach') })}
                      />
                    </div>
                    <div style={{ width: 120 }}>
                      <label>Số phách</label>
                      <input
                        value={it.soPhach}
                        disabled={saved}
                        placeholder="VD: 01"
                        className={it.flags['phach'] ? 'input-flag' : undefined}
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
                      className={it.flags['name'] ? 'input-flag' : undefined}
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
                <div style={{ width: 210 }}>
                  <label>
                    Mã đề chấm {readCode && <span style={{ color: 'var(--muted)', fontWeight: 400 }}>(phiếu ghi: {readCode})</span>}
                  </label>
                  <select
                    value={it.maDe}
                    disabled={saved}
                    style={it.flags['made'] || (!it.maDe && !saved) ? { background: '#fef3c7', borderColor: '#f59e0b' } : undefined}
                    onChange={(e) => {
                      const flags = { ...it.flags }
                      delete flags['made']
                      onPatch({ maDe: e.target.value, maDePicked: !!e.target.value, flags, error: undefined })
                    }}
                  >
                    <option value="">— Chọn mã đề —</option>
                    {keys.map((k) => (
                      <option key={k.id} value={k.ma_de}>
                        {k.ma_de}
                        {readCode && normMaDe(k.ma_de) === normMaDe(readCode) ? ' ✓ khớp phiếu' : ''}
                      </option>
                    ))}
                    {readNoKey && (
                      <option value={`__nokey_${readCode}`} disabled>
                        {readCode} — chưa có đáp án
                      </option>
                    )}
                  </select>
                  {!saved && readNoKey && (
                    <p style={{ color: '#b45309', fontSize: 12.5, margin: '2px 0 0' }}>
                      Chưa có đáp án mã {readCode}.{' '}
                      <a
                        href="#"
                        onClick={(e) => {
                          e.preventDefault()
                          onNeedKey(readCode)
                        }}
                      >
                        + Nhập đáp án mã {readCode}
                      </a>
                      {it.maDe ? '' : ' — hoặc chọn mã đề đúng nếu máy đọc nhầm.'}
                    </p>
                  )}
                  {differs && (
                    <p style={{ color: '#b45309', fontSize: 12.5, margin: '2px 0 0' }}>
                      Đang chấm theo mã <b>{it.maDe}</b> (cô chọn), khác mã ghi trên phiếu ({readCode}).
                    </p>
                  )}
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
              {!it.maDe && !saved && (
                <p style={{ color: '#b45309', fontSize: 13, margin: '6px 0 0' }}>
                  Chưa tính điểm vì chưa có mã đề chấm — chọn mã đề ở ô "Mã đề chấm" phía trên.
                </p>
              )}
              {key && <ResultSummary cfg={cfg} answers={it.answers} answerKey={key.answers} />}
              {!saved && <FlagList flags={it.flags} onClear={() => onPatch({ flags: {} })} />}
              {it.read?.note && <p style={{ fontSize: 12.5, color: 'var(--muted)' }}>Ghi chú của AI: {it.read.note}</p>}
              {it.error && <div className="notice err">{it.error}</div>}
              {!saved && (
                <div className="toolbar" style={{ marginTop: 6 }}>
                  <button className="btn success" onClick={onSave} disabled={issues.length > 0} title={issues.join(' ')}>
                    💾 Lưu phiếu
                  </button>
                  <button className="btn secondary" onClick={onRetry}>
                    ↻ Đọc lại
                  </button>
                  <button className="btn danger soft" onClick={onRemove}>
                    Bỏ
                  </button>
                  {issues.length > 0 && <span style={{ color: '#b45309', fontSize: 12.5 }}>{issues.join(' ')}</span>}
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

  const exportExcel = () => exportBatchExcel(batch, cfg, keys, sheets, props.roster)
  const hasP3 = cfg.n3 > 0
  const nCols = 7 + (phach ? 1 : 0) + (hasP3 ? 1 : 0)
  const [onlyWarn, setOnlyWarn] = useState(false)
  const shown = onlyWarn ? sorted.filter((s) => (s.read_flags && Object.keys(s.read_flags).length) || (s.edited_cells || []).length) : sorted
  // phân bố điểm (thang 10 chia 5 khoảng)
  const maxScore = sheets[0]?.part_scores?.max || cfg.n1 * cfg.p1 + cfg.n2 * cfg.p2 + cfg.n3 * cfg.p3 || 10
  const bins = [0, 0, 0, 0, 0]
  for (const s of sheets) bins[Math.min(4, Math.floor((s.score / maxScore) * 5))]++

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <div className="card-title" style={{ margin: 0 }}>
          <span className="num">3</span>
          <h2>Kết quả</h2>
        </div>
        <div className="toolbar">
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
          <button className="btn success" onClick={exportExcel} disabled={!sheets.length}>
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
      {mergeMsg && <div className="notice info">{mergeMsg}</div>}
      {sheets.length > 0 && (
        <div className="toolbar" style={{ margin: '12px 0', gap: 6 }}>
          <span className="small muted">Phổ điểm:</span>
          {bins.map((n, i) => (
            <span key={i} className={`badge ${i <= 1 ? 'wrong' : i === 2 ? 'warn' : i === 3 ? 'gray' : 'ok'}`}>
              {Math.round(((maxScore * i) / 5) * 10) / 10}–{Math.round(((maxScore * (i + 1)) / 5) * 10) / 10}: {n}
            </span>
          ))}
          <span className="small muted">· TB {avg}</span>
          {roster.length > 0 && <span className="badge warn">{missing.length} HS chưa có phiếu</span>}
          <span className="spacer" />
          <label className="check small">
            <input type="checkbox" checked={onlyWarn} onChange={(e) => setOnlyWarn(e.target.checked)} /> Chỉ bài từng có cảnh báo / sửa tay
          </label>
        </div>
      )}

      <div className="table-wrap">
      <table className="list">
        <thead>
          <tr>
            <th>STT</th>
            {phach && <th>Phách</th>}
            <th>Họ và tên</th>
            <th>Mã đề</th>
            <th className="num">P1</th>
            <th className="num">P2</th>
            {hasP3 && <th className="num">P3</th>}
            <th className="num">Tổng</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {shown.map((s, i) => {
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
                    {s.read_flags && Object.keys(s.read_flags).length > 0 && (
                      <span
                        className="badge warn"
                        style={{ marginLeft: 6 }}
                        title={Object.entries(s.read_flags)
                          .map(([id, why]) => `${flagLabel(id)}: ${why}`)
                          .join('\n')}
                      >
                        ⚠ {Object.keys(s.read_flags).length} cảnh báo khi đọc
                      </span>
                    )}
                  </td>
                  <td>{s.ma_de}</td>
                  <td className="num">{s.part_scores.p1}</td>
                  <td className="num">{s.part_scores.p2}</td>
                  {hasP3 && <td className="num">{s.part_scores.p3}</td>}
                  <td className="num">
                    <span className="score">{s.score}</span>
                  </td>
                  <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                    <button className="btn secondary sm" onClick={() => setOpen(isOpen ? null : s.id)}>
                      {isOpen ? 'Đóng' : 'Xem'}
                    </button>{' '}
                    <button className="btn danger soft sm" onClick={() => remove(s)}>
                      Xoá
                    </button>
                  </td>
                </tr>
                {isOpen && (
                  <tr>
                    <td colSpan={nCols} className="detail">
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
                          <p style={{ margin: '4px 0', fontSize: 13 }}>
                            {s.image_drive_id || s.overlay_drive_id ? (
                              <>
                                Ảnh phiếu (Google Drive):{' '}
                                {s.image_drive_id && (
                                  <a href={driveViewUrl(s.image_drive_id)} target="_blank" rel="noreferrer">
                                    📷 ảnh gốc
                                  </a>
                                )}
                                {s.image_drive_id && s.overlay_drive_id && ' · '}
                                {s.overlay_drive_id && (
                                  <a href={driveViewUrl(s.overlay_drive_id)} target="_blank" rel="noreferrer">
                                    🔍 ảnh máy đọc
                                  </a>
                                )}
                              </>
                            ) : (
                              <span style={{ color: 'var(--muted)' }}>Không có ảnh phiếu (phiếu chấm khi chưa kết nối Google Drive).</span>
                            )}
                          </p>
                          {key && <ResultSummary cfg={cfg} answers={s.answers} answerKey={key.answers} />}
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
              <td colSpan={nCols} className="muted">
                Chưa có phiếu nào được lưu.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      </div>
      {missing.length > 0 && (
        <p style={{ fontSize: 13, color: 'var(--muted)' }}>
          <b>Chưa có phiếu:</b> {missing.map((s) => s.full_name).join(', ')}
        </p>
      )}
    </div>
  )
}
