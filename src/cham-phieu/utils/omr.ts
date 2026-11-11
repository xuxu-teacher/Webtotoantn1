/**
 * CHẤM PHIẾU TRẢ LỜI GIẤY (viết tay) BẰNG ẢNH CHỤP / SCAN / CAMERA
 *
 * Luồng: ảnh phiếu -> /api/omr (AI đọc chữ viết tay, trả JSON thô) -> chuẩn hoá ở đây
 * -> giáo viên rà các ô bị đánh dấu -> chấm điểm -> lưu bảng paper_sheets.
 *
 * Phần 2 chấp nhận cả hai cách ghi: "Đ"/"S" và "Đúng"/"Sai" (kể cả viết không dấu,
 * chữ Đ bị đọc thành D/Ð, chữ S bị đọc thành số 5).
 */
import { supabase } from '../lib/supabase'
import { Gray, OmrError, SheetTemplate, applyH, readBubbles, rgbaToGray, warpRegion, BubbleRead } from './bubbleOmr'
import { classLayout, grid35Template, schoolTemplate } from './sheetTemplates'

// ---------------- KIỂU DỮ LIỆU ----------------

/** Cấu trúc đề + thang điểm của một đợt chấm */
export interface PaperConfig {
  n1: number // số câu Phần 1 (trắc nghiệm 4 phương án)
  n2: number // số câu Phần 2 (đúng/sai, mỗi câu 4 ý)
  n3: number // số câu Phần 3 (trả lời ngắn)
  p1: number // điểm mỗi câu Phần 1
  p2: number // điểm tối đa mỗi câu Phần 2
  p3: number // điểm mỗi câu Phần 3
  tfMethod: 'ministry_partial' | 'equal_split'
  /**
   * Loại phiếu: 'school' = phiếu tô ô in sẵn của trường (có phách),
   * 'class' = phiếu tô ô do web tạo (đúng số câu),
   * 'grid35' = phiếu 35 câu in sẵn chữ A B C D trong ô (không có ô vuông đen, có Mã đề thi + Mã phách),
   * không có = phiếu viết tay kiểu cũ.
   */
  sheet?: SheetKind
  /** Nhận diện bài làm: 'phach' = mã phách + số phách (bài đã cắt phách), 'name' = họ tên viết tay */
  identity?: 'phach' | 'name'
  /** Khổ phiếu lớp (A5 = 2 phiếu/tờ A4); tự chọn khi tạo đợt */
  paper?: 'A4' | 'A5'
}

export type SheetKind = 'school' | 'class' | 'grid35'

export const DEFAULT_CONFIG: PaperConfig = {
  n1: 12,
  n2: 4,
  n3: 6,
  p1: 0.25,
  p2: 1,
  p3: 0.5,
  tfMethod: 'ministry_partial',
  sheet: 'class',
  identity: 'name',
}

/** Bộ đáp án / bài làm đã chuẩn hoá. null = ô trống hoặc không đọc được */
export interface PaperAnswers {
  p1: (string | null)[] // 'A' | 'B' | 'C' | 'D'
  p2: (boolean | null)[][] // [câu][ý a..d], true = Đúng
  p3: (string | null)[]
}

/** Mã ô dùng để đánh dấu: "1.9" (Phần 1 câu 9), "2.3b" (Phần 2 câu 3 ý b), "3.5" */
export type CellId = string

export interface ReadResult {
  name: string // họ tên đọc được
  classLabel: string // lớp đọc được
  maDe: string // mã đề đọc được
  answers: PaperAnswers
  flags: Record<CellId, string> // ô cần giáo viên kiểm tra -> lý do
  note: string // ghi chú chung của AI
  model: string
  maPhach?: string
  soPhach?: string
  stt?: string
  /** Ảnh phiếu đã nắn thẳng, vẽ sẵn ô máy đọc được (để giáo viên đối chiếu) */
  overlay?: string
}

export interface PartScores {
  p1: number
  p2: number
  p3: number
  total: number
  max: number
  correct: Record<CellId, boolean> // đúng/sai từng ô (Phần 2 theo từng ý)
}

export const TF_KEYS = ['a', 'b', 'c', 'd'] as const

// ---------------- CHUẨN HOÁ CHỮ VIẾT TAY ----------------

/** Bỏ dấu tiếng Việt, đ -> d, viết thường, bỏ khoảng trắng thừa */
export function stripVN(s: string): string {
  return (s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐÐð]/g, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Phần 1: chỉ nhận A, B, C, D.
 * Trả về { value, warn } — warn khác rỗng khi giá trị không hợp lệ.
 */
export function normalizeMcq(raw: unknown): { value: string | null; warn: string } {
  const s0 = String(raw ?? '').trim()
  if (!s0) return { value: null, warn: '' }
  const s = s0.replace(/[đĐÐ]/g, 'D').replace(/[\s.)(:]/g, '').toUpperCase()
  if (/^[ABCD]$/.test(s)) return { value: s, warn: '' }
  return { value: null, warn: `Đọc được "${s0}" — không phải A/B/C/D` }
}

/**
 * Phần 2: nhận "Đ", "S", "Đúng", "Sai" (có/không dấu, hoa/thường).
 * Chữ Đ viết tay hay bị đọc thành "D"/"Ð"; chữ S hay bị đọc thành số "5" — vì Phần 2
 * chỉ có hai khả năng nên quy đổi được, nhưng vẫn đánh dấu để giáo viên liếc lại.
 */
export function normalizeTF(raw: unknown): { value: boolean | null; warn: string } {
  const s0 = String(raw ?? '').trim()
  if (!s0) return { value: null, warn: '' }
  const s = stripVN(s0).replace(/[\s.)(:]/g, '')
  // "D" có thể là chữ Đ bị đọc thiếu gạch ngang — Phần 2 chỉ có Đ/S nên vẫn là Đúng
  if (s === 'd' || s === 'dung') return { value: true, warn: '' }
  if (s === 's' || s === 'sai') return { value: false, warn: '' }
  if (s === '5') return { value: false, warn: `Đọc được "5", hiểu là S (Sai)` }
  if (s === 'true' || s === 't') return { value: true, warn: `Đọc được "${s0}", hiểu là Đúng` }
  if (s === 'false' || s === 'f') return { value: false, warn: `Đọc được "${s0}", hiểu là Sai` }
  return { value: null, warn: `Đọc được "${s0}" — không phải Đ/S` }
}

/** Phần 3: giữ nguyên chuỗi học sinh viết, chỉ chuẩn hoá dấu trừ, dấu chia và khoảng trắng */
export function normalizeShort(raw: unknown): { value: string | null; warn: string } {
  const s0 = String(raw ?? '').trim()
  if (!s0) return { value: null, warn: '' }
  const s = s0.replace(/[−–—]/g, '-').replace(/[:÷]/g, '/').replace(/\s+/g, '')
  // Số nguyên / thập phân, hoặc phân số (13/4) — phân số được chấm theo giá trị, không cần cô rà
  if (/^-?\d+([.,]\d+)?$/.test(s) || isFraction(s)) return { value: s, warn: '' }
  return { value: s, warn: `Đọc được "${s0}" — không phải một số` }
}

function isFraction(s: string): boolean {
  return /\//.test(s) && shortValue(s) !== null
}

/** Giá trị số của đáp số: "3,25", "-1.5", "13/4", "-7/2", "13:4" -> number; không phải số -> null */
export function shortValue(raw: string): number | null {
  const s = (raw || '').replace(/[−–—]/g, '-').replace(/[:÷]/g, '/').replace(/\s+/g, '').replace(/,/g, '.')
  if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return Number(s)
  const m = s.match(/^\(?([+-]?(?:\d+\.?\d*|\.\d+))\)?\/\(?([+-]?(?:\d+\.?\d*|\.\d+))\)?$/)
  if (m) {
    const den = Number(m[2])
    if (den !== 0) return Number(m[1]) / den
  }
  return null
}

/** So đáp số dạng chữ: bỏ khoảng trắng, phẩy = chấm, không phân biệt hoa thường; số so theo giá trị */
export function shortAnswerEqual(a: string, b: string): boolean {
  const n = (s: string) => s.replace(/,/g, '.').replace(/[−–—]/g, '-').replace(/\s+/g, '').toLowerCase()
  const na = n(a || ''),
    nb = n(b || '')
  if (!na || !nb) return false
  if (na === nb) return true
  const numRe = /^[+-]?(\d+\.?\d*|\.\d+)$/
  return numRe.test(na) && numRe.test(nb) && Number(na) === Number(nb)
}

/**
 * So đáp số Phần III phiếu giấy. Đúng khi:
 *  - cùng giá trị số (2,50 = 2,5);
 *  - học sinh ghi PHÂN SỐ có giá trị bằng đáp án (13/4 = 3,25), hoặc bằng đáp án sau khi làm tròn
 *    tới đúng số chữ số thập phân của đáp án — chỉ áp dụng khi đáp án có từ 2 chữ số thập phân trở lên
 *    (VD 2/3 ≈ 0,67 tính đúng; 2/3 với đáp án 0,7 KHÔNG tính đúng).
 *  Đáp án là phân số thì so theo giá trị.
 */
export function paperShortEqual(ans: string, key: string): boolean {
  if (!ans || !key) return false
  if (shortAnswerEqual(ans, key)) return true
  const a = shortValue(ans),
    k = shortValue(key)
  if (a === null || k === null) return false
  if (Math.abs(a - k) < 1e-9 * Math.max(1, Math.abs(k))) return true
  // phân số của học sinh khớp đáp án thập phân đã làm tròn
  const keyNorm = key.replace(/[−–—]/g, '-').replace(/\s+/g, '').replace(/,/g, '.')
  const dec = /^[+-]?\d*\.(\d+)$/.exec(keyNorm)?.[1]?.length ?? 0
  if (isFraction(ans.replace(/[:÷]/g, '/').replace(/\s+/g, '')) && dec >= 2) {
    const f = 10 ** dec
    return Math.abs(Math.round(a * f) - Math.round(k * f)) === 0 && Math.abs(a - k) < 0.5 / f + 1e-12
  }
  return false
}

// ---------------- CHUYỂN KẾT QUẢ AI -> DỮ LIỆU CHUẨN ----------------

export function emptyAnswers(cfg: PaperConfig): PaperAnswers {
  return {
    p1: Array.from({ length: cfg.n1 }, () => null),
    p2: Array.from({ length: cfg.n2 }, () => [null, null, null, null]),
    p3: Array.from({ length: cfg.n3 }, () => null),
  }
}

function asArray(x: unknown): unknown[] {
  return Array.isArray(x) ? x : []
}

/**
 * Chuyển JSON thô AI trả về thành PaperAnswers + danh sách ô cần kiểm tra.
 * Mọi sai lệch số câu / giá trị lạ đều được đánh dấu, không tự đoán.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseAiRead(raw: any, cfg: PaperConfig, model = ''): ReadResult {
  const answers = emptyAnswers(cfg)
  const flags: Record<CellId, string> = {}

  const r1 = asArray(raw?.p1)
  if (r1.length && r1.length !== cfg.n1) flags['1.*'] = `AI đọc được ${r1.length} câu Phần 1, đợt chấm khai báo ${cfg.n1} câu`
  for (let i = 0; i < cfg.n1; i++) {
    const { value, warn } = normalizeMcq(r1[i])
    answers.p1[i] = value
    if (warn) flags[`1.${i + 1}`] = warn
  }

  const r2 = asArray(raw?.p2)
  if (r2.length && r2.length !== cfg.n2) flags['2.*'] = `AI đọc được ${r2.length} câu Phần 2, đợt chấm khai báo ${cfg.n2} câu`
  for (let i = 0; i < cfg.n2; i++) {
    const col = asArray(r2[i])
    for (let j = 0; j < 4; j++) {
      const { value, warn } = normalizeTF(col[j])
      answers.p2[i][j] = value
      if (warn) flags[`2.${i + 1}${TF_KEYS[j]}`] = warn
    }
  }

  const r3 = asArray(raw?.p3)
  if (r3.length && r3.length !== cfg.n3) flags['3.*'] = `AI đọc được ${r3.length} câu Phần 3, đợt chấm khai báo ${cfg.n3} câu`
  for (let i = 0; i < cfg.n3; i++) {
    const { value, warn } = normalizeShort(r3[i])
    answers.p3[i] = value
    if (warn) flags[`3.${i + 1}`] = warn
  }

  // Ô AI tự khai là không chắc chắn (chữ mờ, gạch xoá, viết lệch ô...)
  for (const u of asArray(raw?.uncertain)) {
    const id = normalizeCellId(String(u))
    if (id && !flags[id]) flags[id] = 'AI không chắc (chữ mờ / gạch xoá / lệch ô)'
  }

  return {
    name: String(raw?.ho_ten ?? '').trim(),
    classLabel: String(raw?.lop ?? '').trim(),
    maDe: String(raw?.ma_de ?? '').trim(),
    answers,
    flags,
    note: String(raw?.ghi_chu ?? '').trim(),
    model,
  }
}

/** Chấp nhận "P1.9", "1.9", "P2.3b", "2.3B", "P3-5"... -> "1.9" / "2.3b" / "3.5" */
export function normalizeCellId(s: string): CellId | null {
  const m = s
    .trim()
    .toLowerCase()
    .match(/^p?\s*([123])\s*[.\-_ ]\s*(\d+)\s*([abcd])?$/)
  if (!m) return null
  return `${m[1]}.${Number(m[2])}${m[1] === '2' && m[3] ? m[3] : ''}`
}

/**
 * Đối chiếu 2 lần đọc (2 model khác nhau). Ô nào khác nhau -> đánh dấu,
 * giữ giá trị của lần đọc thứ nhất để giáo viên quyết định.
 */
export function crossCheck(a: ReadResult, b: ReadResult, cfg: PaperConfig): ReadResult {
  const flags = { ...a.flags }
  const show = (v: unknown) => (v === null || v === undefined || v === '' ? 'trống' : v === true ? 'Đ' : v === false ? 'S' : String(v))
  for (let i = 0; i < cfg.n1; i++)
    if (a.answers.p1[i] !== b.answers.p1[i])
      flags[`1.${i + 1}`] = `2 lần đọc khác nhau: ${show(a.answers.p1[i])} / ${show(b.answers.p1[i])}`
  for (let i = 0; i < cfg.n2; i++)
    for (let j = 0; j < 4; j++)
      if (a.answers.p2[i][j] !== b.answers.p2[i][j])
        flags[`2.${i + 1}${TF_KEYS[j]}`] = `2 lần đọc khác nhau: ${show(a.answers.p2[i][j])} / ${show(b.answers.p2[i][j])}`
  for (let i = 0; i < cfg.n3; i++) {
    const x = a.answers.p3[i]
    const y = b.answers.p3[i]
    const same = (!x && !y) || (!!x && !!y && (x === y || paperShortEqual(x, y)))
    if (!same) flags[`3.${i + 1}`] = `2 lần đọc khác nhau: ${show(x)} / ${show(y)}`
  }
  const norm = (x?: string) => (x || '').replace(/\s+/g, '').toUpperCase()
  if (norm(a.maDe) !== norm(b.maDe)) flags['made'] = `Mã đề đọc 2 lần khác nhau: ${a.maDe || 'trống'} / ${b.maDe || 'trống'}`
  if (norm(a.maPhach) !== norm(b.maPhach) || normSoPhach(a.soPhach) !== normSoPhach(b.soPhach))
    flags['phach'] = `Phách đọc 2 lần khác nhau: ${a.maPhach || '?'}-${a.soPhach || '?'} / ${b.maPhach || '?'}-${b.soPhach || '?'}`
  if (a.name && b.name && stripVN(a.name) !== stripVN(b.name)) flags['name'] = flags['name'] || `Họ tên đọc 2 lần khác nhau: ${a.name} / ${b.name}`
  return { ...a, flags }
}

// ---------------- KIỂM TRA ĐÁP ÁN ----------------

/** Liệt kê các ô còn trống trong bộ đáp án (đáp án phải đủ 100% mới cho lưu) */
export function missingKeyCells(key: PaperAnswers, cfg: PaperConfig): CellId[] {
  const miss: CellId[] = []
  for (let i = 0; i < cfg.n1; i++) if (!key.p1[i]) miss.push(`1.${i + 1}`)
  for (let i = 0; i < cfg.n2; i++)
    for (let j = 0; j < 4; j++) if (typeof key.p2[i]?.[j] !== 'boolean') miss.push(`2.${i + 1}${TF_KEYS[j]}`)
  for (let i = 0; i < cfg.n3; i++) if (!key.p3[i]) miss.push(`3.${i + 1}`)
  return miss
}

/** Đáp án Phần 3 phải là số thì mới so khớp được theo giá trị */
export function invalidShortKeys(key: PaperAnswers): CellId[] {
  return key.p3
    .map((v, i) => (v && shortValue(v) === null ? `3.${i + 1}` : ''))
    .filter(Boolean)
}

/** Ép dữ liệu đọc từ CSDL về đúng kích thước cấu hình (phòng khi đổi cấu hình sau) */
export function fitAnswers(a: Partial<PaperAnswers> | null | undefined, cfg: PaperConfig): PaperAnswers {
  const out = emptyAnswers(cfg)
  for (let i = 0; i < cfg.n1; i++) out.p1[i] = a?.p1?.[i] ?? null
  for (let i = 0; i < cfg.n2; i++)
    for (let j = 0; j < 4; j++) {
      const v = a?.p2?.[i]?.[j]
      out.p2[i][j] = typeof v === 'boolean' ? v : null
    }
  for (let i = 0; i < cfg.n3; i++) out.p3[i] = a?.p3?.[i] ?? null
  return out
}

// ---------------- CHẤM ĐIỂM ----------------

const MINISTRY_RATIO = [0, 0.1, 0.25, 0.5, 1]

const r2 = (x: number) => Math.round(x * 100) / 100

export function scorePaper(ans: PaperAnswers, key: PaperAnswers, cfg: PaperConfig): PartScores {
  const correct: Record<CellId, boolean> = {}
  let s1 = 0
  for (let i = 0; i < cfg.n1; i++) {
    const ok = !!ans.p1[i] && ans.p1[i] === key.p1[i]
    correct[`1.${i + 1}`] = ok
    if (ok) s1 += cfg.p1
  }

  let s2 = 0
  for (let i = 0; i < cfg.n2; i++) {
    let k = 0
    for (let j = 0; j < 4; j++) {
      const a = ans.p2[i]?.[j]
      const ok = typeof a === 'boolean' && a === key.p2[i]?.[j]
      correct[`2.${i + 1}${TF_KEYS[j]}`] = ok
      if (ok) k++
    }
    s2 += cfg.tfMethod === 'ministry_partial' ? cfg.p2 * MINISTRY_RATIO[k] : (cfg.p2 * k) / 4
  }

  let s3 = 0
  for (let i = 0; i < cfg.n3; i++) {
    const ok = !!ans.p3[i] && paperShortEqual(ans.p3[i] || '', key.p3[i] || '')
    correct[`3.${i + 1}`] = ok
    if (ok) s3 += cfg.p3
  }

  const max = cfg.n1 * cfg.p1 + cfg.n2 * cfg.p2 + cfg.n3 * cfg.p3
  return { p1: r2(s1), p2: r2(s2), p3: r2(s3), total: r2(s1 + s2 + s3), max: r2(max), correct }
}

// ---------------- KHỚP TÊN HỌC SINH ----------------

export interface StudentLite {
  id: string
  full_name: string
  student_code?: string | null
  stt?: number | null
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  const m = a.length
  const n = b.length
  if (!m) return n
  if (!n) return m
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++)
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[n]
}

/** Độ giống 0..1 giữa hai họ tên (bỏ dấu; ưu tiên khớp tên riêng = từ cuối) */
export function nameSimilarity(a: string, b: string): number {
  const x = stripVN(a)
  const y = stripVN(b)
  if (!x || !y) return 0
  if (x === y) return 1
  const full = 1 - levenshtein(x, y) / Math.max(x.length, y.length)
  const lx = x.split(' ').pop() || ''
  const ly = y.split(' ').pop() || ''
  // Tên riêng khác hẳn -> phạt mạnh (tránh nhầm "Nguyễn Văn An" với "Nguyễn Văn Anh")
  const lastOk = lx === ly
  return lastOk ? full : full * 0.6
}

export interface NameMatch {
  student: StudentLite | null
  score: number
  sure: boolean // true = đủ chắc chắn để tự gán
  candidates: StudentLite[] // sắp xếp giảm dần độ giống
}

export function matchStudent(readName: string, roster: StudentLite[]): NameMatch {
  if (!readName.trim() || !roster.length) return { student: null, score: 0, sure: false, candidates: roster }
  // Học sinh có thể ghi mã HS thay cho tên
  const byCode = roster.find((s) => s.student_code && stripVN(s.student_code) === stripVN(readName))
  if (byCode) return { student: byCode, score: 1, sure: true, candidates: [byCode] }

  const ranked = roster
    .map((s) => ({ s, v: nameSimilarity(readName, s.full_name) }))
    .sort((p, q) => q.v - p.v)
  const best = ranked[0]
  const second = ranked[1]
  // Chắc chắn khi: giống >= 0.85 và hơn hẳn người thứ hai (tránh 2 HS trùng/ gần trùng tên)
  const sure = best.v >= 0.85 && (!second || best.v - second.v >= 0.1)
  return {
    student: best.v >= 0.5 ? best.s : null,
    score: best.v,
    sure,
    candidates: ranked.map((r) => r.s),
  }
}

// ---------------- ẢNH: NÉN, PDF SCAN ----------------

/** Vẽ nguồn ảnh lên canvas, cạnh dài tối đa maxSide, trả về dataURL JPEG */
export function canvasToJpeg(src: CanvasImageSource, w: number, h: number, maxSide = 2000, quality = 0.85): string {
  const scale = Math.min(1, maxSide / Math.max(w, h))
  const c = document.createElement('canvas')
  c.width = Math.round(w * scale)
  c.height = Math.round(h * scale)
  const ctx = c.getContext('2d')
  if (!ctx) throw new Error('Trình duyệt không hỗ trợ xử lý ảnh.')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, c.width, c.height)
  ctx.drawImage(src, 0, 0, c.width, c.height)
  let url = c.toDataURL('image/jpeg', quality)
  if (url.length > 3_400_000) url = c.toDataURL('image/jpeg', 0.65)
  return url
}

export async function imageFileToJpeg(file: File): Promise<string> {
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () =>
        reject(new Error(`Không mở được ảnh "${file.name}" (ảnh HEIC của iPhone?). Hãy chụp bằng nút Camera hoặc đổi sang JPG.`))
      el.src = url
    })
    if (!img.naturalWidth) throw new Error(`Ảnh "${file.name}" bị lỗi.`)
    return canvasToJpeg(img, img.naturalWidth, img.naturalHeight)
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Một trang PDF: ảnh JPEG + chữ có sẵn trong PDF (PDF xuất từ Word có lớp chữ; PDF scan thì rỗng) */
export interface PdfPage {
  img: string
  text: string
}

/** Ghép mảnh chữ của trang PDF thành dòng; khoảng cách ngang lớn (ô bảng) -> " | " */
function pageTextLines(items: { str: string; transform: number[]; width: number }[]): string {
  const rows: { y: number; items: typeof items }[] = []
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue
    const y = it.transform[5]
    let row = rows.find((r) => Math.abs(r.y - y) <= 2.5)
    if (!row) rows.push((row = { y, items: [] }))
    row.items.push(it)
  }
  rows.sort((p, q) => q.y - p.y)
  return rows
    .map((r) => {
      r.items.sort((p, q) => p.transform[4] - q.transform[4])
      let line = ''
      let lastEnd: number | null = null
      for (const it of r.items) {
        const x = it.transform[4]
        if (lastEnd !== null) {
          const gap = x - lastEnd
          if (gap > 8) line += ' | '
          else if (gap > 1.5 && !line.endsWith(' ') && !it.str.startsWith(' ')) line += ' '
        }
        line += it.str
        lastEnd = x + it.width
      }
      return line.replace(/[ \t]+/g, ' ').trim()
    })
    .filter(Boolean)
    .join('\n')
}

/** Đọc các trang PDF: ảnh (cạnh dài ≤ maxSide) + lớp chữ. pages = danh sách số trang (1-based), bỏ trống = tất cả */
export async function pdfFileToPages(file: File, maxSide = 2000, pages?: number[]): Promise<{ total: number; pages: PdfPage[] }> {
  const pdfjsLib = await import('pdfjs-dist')
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
  pdfjsLib.GlobalWorkerOptions.workerSrc = worker.default
  const task = pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) })
  const doc = await task.promise
  const out: PdfPage[] = []
  try {
    const list = pages && pages.length ? pages.filter((i) => i >= 1 && i <= doc.numPages) : Array.from({ length: doc.numPages }, (_, i) => i + 1)
    for (const i of list) {
      const page = await doc.getPage(i)
      const base = page.getViewport({ scale: 1 })
      const scale = Math.min(4, maxSide / Math.max(base.width, base.height))
      const vp = page.getViewport({ scale })
      const c = document.createElement('canvas')
      c.width = Math.round(vp.width)
      c.height = Math.round(vp.height)
      const ctx = c.getContext('2d')
      if (!ctx) throw new Error('Trình duyệt không hỗ trợ xử lý ảnh.')
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, c.width, c.height)
      await page.render({ canvasContext: ctx, viewport: vp }).promise
      let text = ''
      try {
        const content = await page.getTextContent()
        text = pageTextLines(content.items as unknown as { str: string; transform: number[]; width: number }[])
      } catch {
        text = ''
      }
      out.push({ img: c.toDataURL('image/jpeg', 0.9), text })
    }
    return { total: doc.numPages, pages: out }
  } finally {
    await task.destroy()
  }
}

/** File PDF từ máy scan: mỗi trang = một phiếu */
export async function pdfFileToJpegs(file: File): Promise<string[]> {
  return (await pdfFileToPages(file, 2000)).pages.map((p) => p.img)
}

/** Chuyển danh sách file (ảnh / PDF scan) thành danh sách ảnh JPEG, giữ đúng thứ tự */
export async function filesToImages(files: File[]): Promise<{ name: string; dataUrl: string }[]> {
  const out: { name: string; dataUrl: string }[] = []
  for (const f of files) {
    if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) {
      const pages = await pdfFileToJpegs(f)
      pages.forEach((p, i) => out.push({ name: pages.length > 1 ? `${f.name} – trang ${i + 1}` : f.name, dataUrl: p }))
    } else {
      out.push({ name: f.name, dataUrl: await imageFileToJpeg(f) })
    }
  }
  return out
}

// ---------------- GỌI AI ----------------

async function authToken(): Promise<string> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) throw new Error('Phiên đăng nhập giáo viên đã hết hạn. Hãy đăng nhập lại.')
  return token
}

async function callOmr(dataUrl: string, cfg: PaperConfig, mode: 'key' | 'sheet', modelOffset: number) {
  const token = await authToken()
  const res = await fetch('/api/omr', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      image: dataUrl.replace(/^data:image\/\w+;base64,/, ''),
      mode,
      n1: cfg.n1,
      n2: cfg.n2,
      n3: cfg.n3,
      modelOffset,
    }),
  })
  const json = await res.json().catch(() => null)
  if (!res.ok) throw new Error(json?.error || `Máy chủ AI báo lỗi (${res.status}).`)
  return { data: json?.data, model: String(json?.model || '') }
}

/**
 * Đọc một phiếu. doubleCheck = true: đọc song song bằng 2 model khác nhau rồi đối chiếu;
 * nếu lần đọc thứ hai lỗi (hết lượt...) thì vẫn dùng kết quả lần một.
 */
export async function readSheet(
  dataUrl: string,
  cfg: PaperConfig,
  mode: 'key' | 'sheet',
  doubleCheck: boolean,
): Promise<ReadResult & { checked: boolean }> {
  if (!doubleCheck) {
    const a = await callOmr(dataUrl, cfg, mode, 0)
    return { ...parseAiRead(a.data, cfg, a.model), checked: false }
  }
  const [ra, rb] = await Promise.allSettled([callOmr(dataUrl, cfg, mode, 0), callOmr(dataUrl, cfg, mode, 1)])
  if (ra.status === 'rejected' && rb.status === 'rejected') throw ra.reason
  if (ra.status === 'rejected' || rb.status === 'rejected') {
    const ok = (ra.status === 'fulfilled' ? ra.value : (rb as PromiseFulfilledResult<{ data: unknown; model: string }>).value)
    return { ...parseAiRead(ok.data, cfg, ok.model), checked: false }
  }
  const a = parseAiRead(ra.value.data, cfg, ra.value.model)
  const b = parseAiRead(rb.value.data, cfg, rb.value.model)
  // Hai lần đọc trùng model (chỉ cấu hình 1 model) thì đối chiếu không có ý nghĩa
  const checked = ra.value.model !== rb.value.model
  return { ...crossCheck(a, b, cfg), model: checked ? `${a.model} + ${b.model}` : a.model, checked }
}

// ---------------- HIỂN THỊ ----------------

export function tfLabel(v: boolean | null | undefined): string {
  return v === true ? 'Đ' : v === false ? 'S' : ''
}

/** Chuỗi đáp án gọn để xem nhanh / xuất Excel: "ADDCABCDBBDA | ĐĐĐS ĐĐSS ... | 0;4;-1" */
export function answersToText(a: PaperAnswers): string {
  const p1 = a.p1.map((x) => x || '_').join('')
  const p2 = a.p2.map((q) => q.map((x) => tfLabel(x) || '_').join('')).join(' ')
  const p3 = a.p3.map((x) => x || '_').join('; ')
  return `${p1} | ${p2} | ${p3}`
}

// ======================================================================
// PHIẾU TÔ Ô (phiếu trường / phiếu lớp do web tạo)
//   Phần I, II: đọc ô tô bằng xử lý ảnh (bubbleOmr.ts) — không dùng AI.
//   Đầu phiếu + Phần III (viết tay): cắt vùng chữ, nắn thẳng, gửi AI đọc.
// ======================================================================

export function isBubbleSheet(cfg: PaperConfig): boolean {
  return cfg.sheet === 'school' || cfg.sheet === 'class' || cfg.sheet === 'grid35'
}

export function templateFor(cfg: PaperConfig): SheetTemplate {
  if (cfg.sheet === 'school') return schoolTemplate()
  if (cfg.sheet === 'grid35') return grid35Template()
  return classLayout({ n1: cfg.n1, n2: cfg.n2, n3: cfg.n3 }, cfg.paper).template
}

/** "01" = "1"; mã phách viết hoa, bỏ khoảng trắng — dùng để so khớp phách */
export function normSoPhach(s?: string | null): string {
  const t = (s || '').replace(/\s+/g, '').toUpperCase()
  return /^\d+$/.test(t) ? String(Number(t)) : t
}
export function normMaPhach(s?: string | null): string {
  return (s || '').replace(/\s+/g, '').toUpperCase()
}

async function loadRgba(dataUrl: string): Promise<{ rgba: Uint8ClampedArray; w: number; h: number }> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image()
    el.onload = () => resolve(el)
    el.onerror = () => reject(new Error('Không mở được ảnh phiếu.'))
    el.src = dataUrl
  })
  const c = document.createElement('canvas')
  c.width = img.naturalWidth
  c.height = img.naturalHeight
  const ctx = c.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Trình duyệt không hỗ trợ xử lý ảnh.')
  ctx.drawImage(img, 0, 0)
  return { rgba: ctx.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height }
}

function grayToCanvas(g: Gray): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = g.w
  c.height = g.h
  const ctx = c.getContext('2d')!
  const im = ctx.createImageData(g.w, g.h)
  for (let i = 0; i < g.w * g.h; i++) {
    const v = g.d[i]
    im.data[i * 4] = v
    im.data[i * 4 + 1] = v
    im.data[i * 4 + 2] = v
    im.data[i * 4 + 3] = 255
  }
  ctx.putImageData(im, 0, 0)
  return c
}

/** Số điểm ảnh gốc ứng với 1 đơn vị mẫu (ước lượng theo cạnh trên) */
function pxPerUnit(H: number[], t: SheetTemplate): number {
  const [a, b] = t.corners
  const p = applyH(H, a),
    q = applyH(H, b)
  return Math.hypot(q.x - p.x, q.y - p.y) / Math.hypot(b.x - a.x, b.y - a.y)
}

/**
 * Đọc thất bại: thử xem ảnh có phải LOẠI PHIẾU KIA không (phiếu trường <-> phiếu lớp do web in),
 * để báo đúng lỗi thay vì "không khớp mẫu".
 */
function mismatchHint(g: Gray, cfg: PaperConfig): string {
  const isSchool = () => {
    try {
      readBubbles(g, schoolTemplate(), { n1: 1, n2: 0 })
      return true
    } catch {
      return false
    }
  }
  const isGrid35 = () => {
    try {
      return readBubbles(g, grid35Template(), { n1: 1, n2: 0 }).quality >= 0.8
    } catch {
      return false
    }
  }
  const SCHOOL = 'PHIẾU CỦA TRƯỜNG (40 – 6 – 8 câu, có 6 ô vuông đen)'
  const G35 = 'PHIẾU 35 CÂU (chữ A B C D trong ô, không có ô vuông đen)'
  const go = (name: string) => `Bấm "Đổi loại phiếu" ở đầu trang, chọn ${name}, rồi bấm Đọc lại.`
  if (cfg.sheet === 'class') {
    if (isSchool()) return `Ảnh này là ${SCHOOL}, nhưng đợt chấm đang chọn "Phiếu tô ô do web tạo". ${go('phiếu của trường')}`
    if (isGrid35()) return `Ảnh này là ${G35}, nhưng đợt chấm đang chọn "Phiếu tô ô do web tạo". ${go('phiếu 35 câu')}`
  } else if (cfg.sheet === 'school') {
    if (isGrid35()) return `Ảnh này là ${G35}, nhưng đợt chấm đang chọn phiếu của trường. ${go('phiếu 35 câu')}`
  } else if (cfg.sheet === 'grid35') {
    if (isSchool()) return `Ảnh này là ${SCHOOL}, nhưng đợt chấm đang chọn phiếu 35 câu. ${go('phiếu của trường')}`
  }
  return ''
}

/** Ghép vùng đầu phiếu + Phần III (đã nắn thẳng) thành 1 ảnh JPEG gửi AI */
function handwritingImage(g: Gray, br: BubbleRead, t: SheetTemplate): string {
  const ppu = pxPerUnit(br.H, t)
  const parts = t.crops.map((r) => {
    const scale = Math.min(1500 / r.w, ppu * 1.3)
    return grayToCanvas(warpRegion(g, br.H, r, scale))
  })
  const W = Math.max(...parts.map((p) => p.width))
  const gap = 16
  const c = document.createElement('canvas')
  c.width = W
  c.height = parts.reduce((s, p) => s + p.height, 0) + gap * (parts.length - 1)
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, c.width, c.height)
  let y = 0
  for (const p of parts) {
    ctx.drawImage(p, 0, y)
    y += p.height + gap
    ctx.fillStyle = '#888'
    ctx.fillRect(0, y - gap / 2 - 1, W, 2)
  }
  return c.toDataURL('image/jpeg', 0.9)
}

/** Ảnh đối chiếu: phiếu nắn thẳng, khoanh xanh ô máy chọn, khoanh cam hàng cần rà */
function overlayImage(g: Gray, br: BubbleRead, t: SheetTemplate): string {
  const f = t.frame
  const scale = Math.min(900 / f.w, pxPerUnit(br.H, t) * 1.2)
  const c = grayToCanvas(warpRegion(g, br.H, f, scale))
  const ctx = c.getContext('2d')!
  const X = (x: number) => (x - f.x) * scale
  const Y = (y: number) => (y - f.y) * scale
  for (const d of br.detail) {
    const R = (d.row.r ?? t.bubbleR) * scale
    d.centers.forEach((p, i) => {
      // hàng cần rà: vòng cam quanh mọi ô; ô máy chọn (kể cả ở hàng cần rà): vòng xanh
      if (d.flagged) {
        ctx.strokeStyle = '#f59e0b'
        ctx.lineWidth = Math.max(2, R * 0.25)
        ctx.beginPath()
        ctx.arc(X(p.x), Y(p.y), R * (d.chosen === i ? 1.75 : 1.35), 0, Math.PI * 2)
        ctx.stroke()
      }
      if (d.chosen === i) {
        ctx.strokeStyle = '#16a34a'
        ctx.lineWidth = Math.max(2, R * 0.3)
        ctx.beginPath()
        ctx.arc(X(p.x), Y(p.y), R * 1.35, 0, Math.PI * 2)
        ctx.stroke()
      }
    })
  }
  return c.toDataURL('image/jpeg', 0.82)
}

async function callOmrRaw(body: Record<string, unknown>) {
  const token = await authToken()
  const res = await fetch('/api/omr', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => null)
  if (!res.ok) throw new Error(json?.error || `Máy chủ AI báo lỗi (${res.status}).`)
  return { data: json?.data, model: String(json?.model || '') }
}

interface FieldsRead {
  maDe: string
  maPhach: string
  soPhach: string
  name: string
  stt: string
  classLabel: string
  p3: (string | null)[]
  flags: Record<CellId, string>
  note: string
  model: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseFields(raw: any, n3: number, model: string): FieldsRead {
  const flags: Record<CellId, string> = {}
  const r3 = asArray(raw?.p3)
  const p3: (string | null)[] = []
  for (let i = 0; i < n3; i++) {
    const { value, warn } = normalizeShort(r3[i])
    p3.push(value)
    if (warn) flags[`3.${i + 1}`] = warn
  }
  const names: Record<string, CellId> = { MA_DE: 'made', MA_PHACH: 'phach', SO_PHACH: 'phach', HO_TEN: 'name', STT: 'name', LOP: 'name' }
  for (const u of asArray(raw?.uncertain)) {
    const k = String(u).trim().toUpperCase()
    if (names[k]) {
      if (!flags[names[k]]) flags[names[k]] = `AI không chắc khi đọc ${k.replace('_', ' ').toLowerCase()}`
      continue
    }
    const id = normalizeCellId(String(u))
    if (id && id.startsWith('3.') && !flags[id]) flags[id] = 'AI không chắc (chữ mờ / gạch xoá / lệch ô)'
  }
  const str = (v: unknown) => String(v ?? '').trim()
  return {
    maDe: str(raw?.ma_de),
    maPhach: str(raw?.ma_phach),
    soPhach: str(raw?.so_phach),
    name: str(raw?.ho_ten),
    stt: str(raw?.stt).replace(/\D+/g, ''),
    classLabel: str(raw?.lop),
    p3,
    flags,
    note: str(raw?.ghi_chu),
    model,
  }
}

/**
 * Đọc 1 phiếu tô ô. Phần I/II luôn đọc bằng xử lý ảnh; phần viết tay gửi AI
 * (doubleCheck: 2 model đối chiếu). AI lỗi/hết lượt -> vẫn trả kết quả ô tô, đánh dấu phần viết tay để nhập tay.
 */
export async function readBubbleSheet(
  dataUrl: string,
  cfg: PaperConfig,
  doubleCheck: boolean,
): Promise<ReadResult & { checked: boolean }> {
  const t = templateFor(cfg)
  const { rgba, w, h } = await loadRgba(dataUrl)
  const g = rgbaToGray(rgba, w, h, 2200)
  let br: BubbleRead
  try {
    br = readBubbles(g, t, { n1: cfg.n1, n2: cfg.n2 })
  } catch (e) {
    if (e instanceof OmrError) throw new Error(mismatchHint(g, cfg) || e.message)
    throw e
  }
  const answers = emptyAnswers(cfg)
  answers.p1 = br.p1
  answers.p2 = br.p2
  const flags: Record<CellId, string> = { ...br.flags }
  // ảnh xám GIỮ mực đỏ: số phách / điểm thường viết mực đỏ (ảnh dùng đọc ô tô đã xoá mực đỏ của giáo viên chấm)
  const gc = rgbaToGray(rgba, w, h, 2200, false)
  const overlay = overlayImage(gc, br, t)

  const img = handwritingImage(gc, br, t).replace(/^data:image\/\w+;base64,/, '')
  const body = { image: img, mode: 'fields', kind: cfg.sheet, n1: cfg.n1, n2: cfg.n2, n3: cfg.n3 }
  let fields: FieldsRead | null = null
  let checked = false
  let aiError = ''
  if (!doubleCheck) {
    try {
      const a = await callOmrRaw({ ...body, modelOffset: 0 })
      fields = parseFields(a.data, cfg.n3, a.model)
    } catch (e) {
      aiError = (e as Error).message
    }
  } else {
    const [ra, rb] = await Promise.allSettled([callOmrRaw({ ...body, modelOffset: 0 }), callOmrRaw({ ...body, modelOffset: 1 })])
    const ok = [ra, rb].filter((x): x is PromiseFulfilledResult<{ data: unknown; model: string }> => x.status === 'fulfilled')
    if (!ok.length) aiError = (ra as PromiseRejectedResult).reason?.message || 'AI lỗi'
    else {
      const a = parseFields(ok[0].value.data, cfg.n3, ok[0].value.model)
      fields = a
      if (ok.length === 2 && ok[0].value.model !== ok[1].value.model) {
        const b = parseFields(ok[1].value.data, cfg.n3, ok[1].value.model)
        checked = true
        fields = { ...a, model: `${a.model} + ${b.model}`, flags: { ...b.flags, ...a.flags } }
        const show = (v: string | null) => v || 'trống'
        for (let i = 0; i < cfg.n3; i++) {
          const x = a.p3[i],
            y = b.p3[i]
          const same = (!x && !y) || (!!x && !!y && (x === y || paperShortEqual(x, y)))
          if (!same) fields.flags[`3.${i + 1}`] = `2 lần đọc khác nhau: ${show(x)} / ${show(y)}`
        }
        const n = (s: string) => s.replace(/\s+/g, '').toUpperCase()
        if (n(a.maDe) !== n(b.maDe)) fields.flags['made'] = `Mã đề đọc 2 lần khác nhau: ${show(a.maDe)} / ${show(b.maDe)}`
        if ((cfg.sheet === 'school' || cfg.sheet === 'grid35') && (normMaPhach(a.maPhach) !== normMaPhach(b.maPhach) || normSoPhach(a.soPhach) !== normSoPhach(b.soPhach)))
          fields.flags['phach'] = `Phách đọc 2 lần khác nhau: ${a.maPhach || '?'} / ${a.soPhach || '?'} và ${b.maPhach || '?'} / ${b.soPhach || '?'}`
        if (cfg.sheet === 'class' && stripVN(a.name) !== stripVN(b.name))
          fields.flags['name'] = `Họ tên đọc 2 lần khác nhau: ${a.name || 'trống'} / ${b.name || 'trống'}`
      }
    }
  }
  if (fields) {
    answers.p3 = fields.p3
    Object.assign(flags, fields.flags)
  } else {
    flags['ai'] = `Chưa đọc được phần viết tay (mã đề${cfg.sheet === 'class' ? ', họ tên' : ', phách'}${cfg.n3 ? ', Phần III' : ''}): ${aiError.replace(/\.+$/, '')}. ${cfg.n2 ? 'Phần I, II' : 'Phần trắc nghiệm'} vẫn đã đọc xong — cô nhập tay phần còn lại hoặc bấm Đọc lại sau.`
  }
  return {
    name: fields?.name || '',
    classLabel: fields?.classLabel || '',
    maDe: fields?.maDe || '',
    maPhach: fields?.maPhach || '',
    soPhach: fields?.soPhach || '',
    stt: fields?.stt || '',
    answers,
    flags,
    note: fields?.note || '',
    model: fields ? `Ô tô: xử lý ảnh · Chữ viết: ${fields.model}` : 'Ô tô: xử lý ảnh',
    overlay,
    checked,
  }
}

// ---------------- ĐÁP ÁN TỪ BẢNG ĐÁP ÁN (PDF / ảnh) ----------------
//
// Bảng đáp án là chỗ dễ sai nhất (đáp án sai thì cả lớp bị chấm sai), nên:
//  1. PDF xuất từ Word: gửi kèm LỚP CHỮ của PDF để AI chép đúng từng kí tự (không phải "nhìn" ảnh).
//  2. Đọc 2 lần bằng 2 model, đối chiếu từng ô.
//  3. AI phải chép NGUYÊN VĂN đoạn ghi đáp án của từng câu (p1_raw, p2_raw); máy tự phân tích đoạn đó
//     và so với kết quả AI điền — lệch nhau (đọc nhầm hàng/cột, đảo ý) thì tô vàng.
//  4. Luôn bắt giáo viên đối chiếu với ảnh bảng gốc trước khi lưu.

export interface KeyTableItem {
  maDe: string
  answers: PaperAnswers
  flags: Record<CellId, string>
  /** Ảnh các trang bảng đáp án (để giáo viên đối chiếu) */
  sources?: string[]
}

export interface KeyPage {
  img: string
  text?: string
}

/** "1C 2D 3.A 4-B ..." -> {1:'C', 2:'D', ...} (chỉ dùng cho kiểu ghi số câu liền chữ cái) */
export function parseP1Raw(raw: string): Record<number, string> {
  const out: Record<number, string> = {}
  const re = /(?<!\d)(\d{1,2})\s*[.:)\-–]?\s*([ABCD])(?![A-Za-zÀ-ỹ])/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw.toUpperCase().replace(/Đ/g, 'D')))) {
    const q = Number(m[1])
    if (!(q in out)) out[q] = m[2]
  }
  return out
}

/** "a) Đ b) S c) Đúng d) Sai" | "ĐSSĐ" | "a-Đ, b-S, ..." -> [true,false,...] (null = không rõ) */
export function parseP2Raw(raw: string): (boolean | null)[] | null {
  const s = (raw || '').trim()
  if (!s) return null
  const tf = (w: string): boolean | null => {
    const x = stripVN(w)
    if (x === 'd' || x === 'dung' || x === 't' || x === 'true') return true
    if (x === 's' || x === 'sai' || x === 'f' || x === 'false') return false
    return null
  }
  const out: (boolean | null)[] = [null, null, null, null]
  const re = /([abcd])\s*[).:\-–=]\s*(Đúng|đúng|ĐÚNG|Dung|DUNG|Sai|sai|SAI|Đ|đ|D|S|s|True|False|T|F)(?![A-Za-zÀ-ỹ])/gu
  let m: RegExpExecArray | null
  let found = 0
  while ((m = re.exec(s))) {
    const i = 'abcd'.indexOf(m[1].toLowerCase())
    const v = tf(m[2])
    if (i >= 0 && v !== null && out[i] === null) {
      out[i] = v
      found++
    }
  }
  if (found) return out
  // kiểu viết liền "ĐSSĐ" / "Đ S S Đ"
  const compact = s.replace(/[\s,;|/]+/g, '')
  if (/^[ĐDSđds]{4}$/u.test(compact)) return [...compact].map((c) => tf(c))
  const words = s.split(/[\s,;|/]+/).filter(Boolean)
  if (words.length === 4 && words.every((w) => tf(w) !== null)) return words.map((w) => tf(w))
  return null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseKeyTable(raw: any, cfg: PaperConfig): KeyTableItem[] {
  const unc = asArray(raw?.uncertain).map((u) => String(u))
  return asArray(raw?.keys).map((k0) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const k = k0 as any
    const maDe = String(k?.ma_de ?? '').trim()
    const parsed = parseAiRead({ p1: k?.p1, p2: k?.p2, p3: k?.p3 }, cfg)
    const flags = { ...parsed.flags }
    // Đối chiếu với đoạn chép nguyên văn
    const p1raw = parseP1Raw(String(k?.p1_raw ?? ''))
    if (Object.keys(p1raw).length >= Math.min(3, cfg.n1))
      for (let i = 0; i < cfg.n1; i++) {
        const r = p1raw[i + 1]
        if (r && r !== parsed.answers.p1[i]) flags[`1.${i + 1}`] = `Bảng ghi "${r}" nhưng AI điền "${parsed.answers.p1[i] || 'trống'}"`
      }
    const p2raw = asArray(k?.p2_raw)
    for (let i = 0; i < cfg.n2; i++) {
      const r = parseP2Raw(String(p2raw[i] ?? ''))
      if (!r) continue
      for (let j = 0; j < 4; j++)
        if (r[j] !== null && r[j] !== parsed.answers.p2[i][j])
          flags[`2.${i + 1}${TF_KEYS[j]}`] = `Bảng ghi "${String(p2raw[i])}" nhưng AI điền ${tfLabel(parsed.answers.p2[i][j]) || 'trống'} cho ý ${TF_KEYS[j]}`
    }
    for (const u of unc) {
      const [m, cell] = u.includes(':') ? u.split(':') : ['', u]
      if (m.trim() !== maDe && m.trim() !== '') continue
      const id = normalizeCellId(cell)
      if (id && !flags[id]) flags[id] = 'AI không chắc khi đọc bảng đáp án'
    }
    return { maDe, answers: parsed.answers, flags }
  })
}

function mergeKeyItems(list: KeyTableItem[], cfg: PaperConfig): KeyTableItem[] {
  const map = new Map<string, KeyTableItem>()
  for (const it of list) {
    const cur = map.get(it.maDe)
    if (!cur) {
      map.set(it.maDe, { maDe: it.maDe, answers: fitAnswers(it.answers, cfg), flags: { ...it.flags }, sources: [...(it.sources || [])] })
      continue
    }
    for (const src of it.sources || []) if (!cur.sources!.includes(src)) cur.sources!.push(src)
    // cùng mã đề xuất hiện ở nhiều trang: lấp chỗ trống, chỗ khác nhau thì đánh dấu
    const a = cur.answers,
      b = it.answers
    for (let i = 0; i < cfg.n1; i++) {
      if (!a.p1[i]) a.p1[i] = b.p1[i]
      else if (b.p1[i] && b.p1[i] !== a.p1[i]) cur.flags[`1.${i + 1}`] = `Hai chỗ trong file ghi khác nhau: ${a.p1[i]} / ${b.p1[i]}`
    }
    for (let i = 0; i < cfg.n2; i++)
      for (let j = 0; j < 4; j++) {
        if (a.p2[i][j] === null) a.p2[i][j] = b.p2[i]?.[j] ?? null
        else if (typeof b.p2[i]?.[j] === 'boolean' && b.p2[i][j] !== a.p2[i][j])
          cur.flags[`2.${i + 1}${TF_KEYS[j]}`] = 'Hai chỗ trong file ghi khác nhau'
      }
    for (let i = 0; i < cfg.n3; i++) {
      if (!a.p3[i]) a.p3[i] = b.p3[i]
      else if (b.p3[i] && !paperShortEqual(a.p3[i]!, b.p3[i]!)) cur.flags[`3.${i + 1}`] = `Hai chỗ trong file ghi khác nhau: ${a.p3[i]} / ${b.p3[i]}`
    }
    Object.assign(cur.flags, it.flags)
  }
  return [...map.values()]
}

/** Một lần gọi AI đọc bảng đáp án (2 model đối chiếu). body: image/text (1 trang) hoặc images/texts (nhiều trang) */
async function readKeyOnce(body: Record<string, unknown>, cfg: PaperConfig): Promise<KeyTableItem[]> {
  const [ra, rb] = await Promise.allSettled([callOmrRaw({ ...body, modelOffset: 0 }), callOmrRaw({ ...body, modelOffset: 1 })])
  const ok = [ra, rb].filter((x): x is PromiseFulfilledResult<{ data: unknown; model: string }> => x.status === 'fulfilled')
  if (!ok.length) throw new Error((ra as PromiseRejectedResult).reason?.message || 'AI lỗi')
  const A = parseKeyTable(ok[0].value.data, cfg)
  if (ok.length === 2 && ok[0].value.model !== ok[1].value.model) {
    const B = parseKeyTable(ok[1].value.data, cfg)
    for (const a of A) {
      const b = B.find((x) => x.maDe === a.maDe) || (A.length === 1 && B.length === 1 ? B[0] : undefined)
      if (!b) {
        a.flags['all'] = 'Lần đọc thứ hai không thấy mã đề này — hãy rà kĩ'
        continue
      }
      const c = crossCheck(
        { name: '', classLabel: '', maDe: a.maDe, answers: a.answers, flags: a.flags, note: '', model: '' },
        { name: '', classLabel: '', maDe: b.maDe, answers: fitAnswers(b.answers, cfg), flags: {}, note: '', model: '' },
        cfg,
      )
      delete c.flags['made']
      a.flags = { ...b.flags, ...c.flags }
    }
    if (B.length > A.length) for (const b of B) if (!A.some((x) => x.maDe === b.maDe)) A.push({ ...b, flags: { ...b.flags, all: 'Chỉ lần đọc thứ hai thấy mã đề này — hãy rà kĩ' } })
  } else {
    for (const a of A) a.flags['all'] = a.flags['all'] || 'Chỉ đọc được 1 lần (không có model thứ hai để đối chiếu) — hãy rà kĩ'
  }
  return A
}

/** Nén lại ảnh JPEG (cạnh dài ≤ maxSide) để vừa giới hạn dung lượng gửi lên máy chủ */
export async function shrinkJpeg(dataUrl: string, maxSide: number, quality: number): Promise<string> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image()
    el.onload = () => resolve(el)
    el.onerror = () => reject(new Error('Không mở được ảnh.'))
    el.src = dataUrl
  })
  return canvasToJpeg(img, img.naturalWidth, img.naturalHeight, maxSide, quality)
}

const strip64 = (d: string) => d.replace(/^data:image\/\w+;base64,/, '')
/** Vercel giới hạn thân yêu cầu ~4,5 MB */
const MAX_BODY = 3_800_000

/**
 * Đọc bảng đáp án từ các trang (ảnh + lớp chữ PDF nếu có).
 * NHIỀU TRANG: gửi tất cả các trang trong MỘT lần đọc để AI ghép bảng bị ngắt trang
 * (trang sau thường không lặp lại hàng tiêu đề mã đề). Quá dung lượng / lỗi -> đọc từng trang rồi ghép theo mã đề.
 * Mỗi lần đọc dùng 2 model và đối chiếu từng ô.
 */
export async function readKeyTable(pagesIn: (string | KeyPage)[], cfg: PaperConfig, onProgress?: (i: number) => void): Promise<KeyTableItem[]> {
  const pages: KeyPage[] = pagesIn.map((p) => (typeof p === 'string' ? { img: p } : p))
  const texts = pages.map((p) => (p.text || '').slice(0, 20000))
  const finalize = (list: KeyTableItem[]) => {
    const merged = mergeKeyItems(list, cfg)
    // Đáp án do AI đọc: luôn yêu cầu giáo viên đối chiếu với bảng gốc trước khi lưu
    for (const m of merged)
      if (!m.flags['all']) m.flags['all'] = 'Đáp án do AI đọc từ bảng — đối chiếu từng câu với ảnh bảng gốc bên cạnh rồi bấm "Đã rà xong"'
    return merged
  }
  let lastErr = ''
  if (pages.length > 1) {
    onProgress?.(0)
    let imgs = pages.map((p) => strip64(p.img))
    const size = () => imgs.reduce((t, x) => t + x.length, 0) + texts.reduce((t, x) => t + x.length * 3, 0)
    if (size() > MAX_BODY) imgs = (await Promise.all(pages.map((p) => shrinkJpeg(p.img, 2200, 0.8)))).map(strip64)
    if (size() > MAX_BODY) imgs = (await Promise.all(pages.map((p) => shrinkJpeg(p.img, 1700, 0.75)))).map(strip64)
    if (size() <= MAX_BODY) {
      try {
        const A = await readKeyOnce({ images: imgs, texts, mode: 'keytable', n1: cfg.n1, n2: cfg.n2, n3: cfg.n3 }, cfg)
        if (A.length) {
          for (const a of A) a.sources = pages.map((p) => p.img)
          return finalize(A)
        }
      } catch (e) {
        lastErr = (e as Error).message
      }
    }
  }
  const all: KeyTableItem[] = []
  for (let p = 0; p < pages.length; p++) {
    onProgress?.(p + 1)
    try {
      const A = await readKeyOnce({ image: strip64(pages[p].img), text: texts[p], mode: 'keytable', n1: cfg.n1, n2: cfg.n2, n3: cfg.n3 }, cfg)
      for (const a of A) {
        a.sources = [pages[p].img]
        // trang không ghi mã đề (bảng bị ngắt trang) -> không tự ghép, bắt giáo viên rà
        if (!a.maDe && pages.length > 1) a.flags['all'] = `Trang ${p + 1} không ghi mã đề (bảng bị ngắt trang?) — nhập mã đề và đối chiếu kĩ`
      }
      all.push(...A)
    } catch (e) {
      lastErr = (e as Error).message
    }
  }
  if (!all.length) throw new Error(lastErr || 'Không tìm thấy bảng đáp án trong file.')
  return finalize(all)
}
