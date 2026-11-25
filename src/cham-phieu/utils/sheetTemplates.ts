/**
 * MẪU PHIẾU TRẢ LỜI
 *  - 'school': phiếu in sẵn của trường (Phần I 40 câu, Phần II 6 câu, Phần III 8 câu viết tay,
 *    có 6 ô vuông đen ■ quanh Phần I). Toạ độ đo từ phiếu thật, đơn vị: mốc trên-trái (0,0),
 *    mốc trên-phải (1000,0). Phiếu chỉ cần chụp — không cần in đúng kích cỡ.
 *  - 'class': phiếu do web tạo cho bài kiểm tra tại lớp, đúng số câu của đề. Đơn vị: mm trên giấy.
 *    Khổ: nửa trang A4 (2 phiếu/tờ) hoặc 1 trang A4 (ô tô lớn) — giáo viên chọn khi tạo đợt.
 */
import type { BubbleRow, Pt, SheetTemplate } from './bubbleOmr'

// ======================================================================
// PHIẾU TRƯỜNG
// ======================================================================

const SCHOOL_P1_X = [
  [79, 120.75, 164, 207],
  [335.5, 375.5, 416.75, 457.5],
  [580.5, 622, 664.75, 706.75],
  [831.25, 871.25, 913.75, 955.25],
]
const SCHOOL_P1_Y = [105, 143.25, 179.75, 216, 253, 289.5, 326, 362.75, 399, 435.5]
const SCHOOL_P2_X = [
  [40.5, 95],
  [195.5, 251.25],
  [352.25, 405.5],
  [506, 561],
  [664.25, 719],
  [823, 878.5],
]
const SCHOOL_P2_Y = [588.5, 618, 644.25, 671]

export const SCHOOL_LIMITS = { n1: 40, n2: 6, n3: 8 }

export function schoolTemplate(): SheetTemplate {
  const rows: BubbleRow[] = []
  SCHOOL_P1_X.forEach((xs, g) =>
    SCHOOL_P1_Y.forEach((y, r) => rows.push({ part: 1, q: g * 10 + r + 1, block: `p1g${g}`, r: 12, opts: xs.map((x) => ({ x, y })) })),
  )
  SCHOOL_P2_X.forEach((xs, q) =>
    SCHOOL_P2_Y.forEach((y, s) => rows.push({ part: 2, q: q + 1, sub: s, block: `p2q${q}`, r: 7.5, opts: xs.map((x) => ({ x, y })) })),
  )
  return {
    kind: 'school',
    corners: [
      { x: 0, y: 0 },
      { x: 1000, y: 0 },
      { x: 0, y: 480 },
      { x: 1000, y: 480 },
    ],
    extraMarkers: [
      { x: 642, y: 3 },
      { x: 641, y: 484.5 },
    ],
    markerSize: 16,
    bubbleR: 12,
    rows,
    crops: [
      { id: 'header', x: -45, y: -140, w: 1100, h: 125 },
      { id: 'p3', x: -45, y: 700, w: 1100, h: 105 },
    ],
    frame: { x: -50, y: -150, w: 1110, h: 960 },
  }
}

// ======================================================================
// PHIẾU LỚP (web tạo) — mọi kích thước tính bằng mm
// ======================================================================

export type PaperSize = 'A4' | 'A5'

export interface ClassCounts {
  n1: number
  n2: number
  n3: number
  /**
   * Kiểu Phần III: 'bubble' = lưới tô ô chuẩn Bộ GD&ĐT (4 cột/câu: dấu −, dấu phẩy, chữ số 0–9) — máy đọc bằng xử lý ảnh;
   * 'write' / không có = ô viết tay (đợt chấm cũ, AI đọc chữ viết).
   */
  p3Mode?: 'bubble' | 'write'
}

/** Phiếu lớp có Phần III dạng lưới tô ô? */
export function p3IsGrid(c: ClassCounts): boolean {
  return c.p3Mode === 'bubble' && c.n3 > 0
}

// ---------------- LƯỚI TÔ PHẦN III (chuẩn phiếu Bộ GD&ĐT) ----------------

/** Số câu Phần III tối đa của phiếu lưới tô (2 hàng × 6 câu trên 1 trang A4) */
export const P3_GRID_MAX = 12
/** Ký tự của 12 hàng (từ trên xuống): dấu trừ, dấu phẩy, chữ số 0..9 */
export const P3_ROW_CHARS = ['-', ',', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9']
/** Ký tự có ô tô ở từng cột: cột 1 có dấu −, cột 2 và 3 có dấu phẩy, cột 4 chỉ có chữ số */
export const P3_COL_CHARS: string[][] = [
  ['-', ...P3_ROW_CHARS.slice(2)],
  [',', ...P3_ROW_CHARS.slice(2)],
  [',', ...P3_ROW_CHARS.slice(2)],
  [...P3_ROW_CHARS.slice(2)],
]

/** Chuẩn hoá đáp số để tô/so: bỏ khoảng trắng, dấu chấm thập phân -> dấu phẩy, các kiểu gạch ngang -> "-" */
export function p3Canon(s: string): string {
  return (s || '').replace(/[−–—]/g, '-').replace(/\s+/g, '').replace(/\./g, ',')
}

/**
 * Vị trí cột (0..3) của từng ký tự khi tô đáp số s lên lưới 4 cột (ghép từ trái sang, cột chưa dùng có thể để không).
 * Gán tham lam vào cột hợp lệ sớm nhất -> tìm được cách tô nếu có. Không tô được -> null.
 */
export function p3Placement(s: string): number[] | null {
  const t = p3Canon(s)
  if (!t || t.length > 4) return null
  const out: number[] = []
  let col = 0
  for (const ch of t) {
    while (col < 4 && !P3_COL_CHARS[col].includes(ch)) col++
    if (col >= 4) return null
    out.push(col++)
  }
  return out
}

/** Đáp số có tô được trên lưới Phần III không (số nguyên / thập phân, tối đa 4 ký tự, đúng cột dấu) */
export function p3Fillable(s: string): boolean {
  const t = p3Canon(s)
  return /^-?\d+(,\d+)?$/.test(t) && p3Placement(t) !== null
}

/** Phần tử vẽ của phiếu lớp (để xuất SVG in ra giấy) */
export type Draw =
  | { t: 'rect'; x: number; y: number; w: number; h: number; fill?: boolean; sw?: number; r?: number }
  | { t: 'circle'; x: number; y: number; r: number; sw?: number }
  | {
      t: 'text'
      x: number
      y: number
      s: string
      size: number
      bold?: boolean
      anchor?: 'start' | 'middle' | 'end'
      /** màu chữ (mặc định đen) — chữ số trong ô Phần III in xám nhạt */
      fill?: string
      sans?: boolean
    }
  | { t: 'line'; x1: number; y1: number; x2: number; y2: number; sw?: number; dash?: boolean }

/**
 * Kiểu bố cục: 'std' = chuẩn (như các phiếu đã in trước đây), 'big' = ô to (1 trang A4),
 * 'xl' = ô rất to (đề ngắn, 1 trang A4), 'compact' = gọn (đề rất dài)
 */
export type ClassStyle = 'std' | 'big' | 'xl' | 'compact'

export interface ClassLayout {
  size: PaperSize
  style: ClassStyle
  width: number
  height: number
  template: SheetTemplate
  draws: Draw[]
  contentBottom: number
}

const PAGE_W = 210
const M = 9 // lề tới tâm mốc
const MK = 5 // cạnh mốc

/**
 * Hệ số phóng lưới Phần III theo kiểu bố cục (số đo gốc r = 2,0 / bước hàng 4,8 / bước cột 5,6 mm).
 * Kiểu ô lớn (big, xl) vẫn giữ lưới gốc: phóng to thì 1 hàng không còn đủ 6 câu -> lưới phải xuống 2 hàng, không vừa trang.
 */
const P3K: Record<ClassStyle, number> = { std: 1, big: 1, xl: 1, compact: 0.9 }

interface Dims {
  BR: number // bán kính ô tô
  DX: number // khoảng cách ngang giữa các ô A-B-C-D
  DY: number // khoảng cách hàng
  LBL: number // bề rộng nhãn số câu Phần I
  P2W: number // bề rộng khung một câu Phần II
  xD: number // vị trí ô Đúng trong khung Phần II
  xS: number // vị trí ô Sai
  P3H: number // chiều cao ô ghi đáp số Phần III
  P3STEP: number // khoảng cách hàng ô Phần III
  BOXH: number // chiều cao khung thông tin
  fs: number // hệ số cỡ chữ
}

/** 'std' giữ NGUYÊN số đo cũ để các phiếu đã in trước đây vẫn quét được */
const DIMS: Record<ClassStyle, Dims> = {
  std: { BR: 2.2, DX: 6.2, DY: 5.6, LBL: 8, P2W: 23.5, xD: 10.2, xS: 17.6, P3H: 10, P3STEP: 17, BOXH: 13, fs: 1 },
  big: { BR: 2.6, DX: 7.3, DY: 6.7, LBL: 9, P2W: 27.5, xD: 11.8, xS: 20.4, P3H: 12, P3STEP: 19.5, BOXH: 15, fs: 1.13 },
  xl: { BR: 3.0, DX: 8.6, DY: 7.9, LBL: 10.5, P2W: 32, xD: 13.8, xS: 23.8, P3H: 14, P3STEP: 22.5, BOXH: 17, fs: 1.3 },
  compact: { BR: 2.0, DX: 5.6, DY: 4.9, LBL: 7.5, P2W: 21.5, xD: 9.4, xS: 16, P3H: 9, P3STEP: 14.5, BOXH: 12, fs: 0.95 },
}

/** Toạ độ y lớn nhất nội dung được phép chạm tới (chừa mốc ■ dưới) */
const bottomLimit = (pageH: number) => pageH - M - MK / 2 - 3

/** Chia Phần I thành các cột (tối đa 10 câu/cột, tối đa 5 cột/dải) */
function p1Columns(n1: number): number[][] {
  if (!n1) return []
  const cols = Math.ceil(n1 / 10)
  const per = Math.ceil(n1 / cols)
  const out: number[][] = []
  for (let c = 0; c < cols; c++) {
    const qs: number[] = []
    for (let q = c * per + 1; q <= Math.min(n1, (c + 1) * per); q++) qs.push(q)
    if (qs.length) out.push(qs)
  }
  return out
}

/** Phiếu (bố cục chuẩn) có vừa nửa trang A4 (in 2 phiếu/tờ) không */
export function fitsHalfA4(c: ClassCounts): boolean {
  return buildClassLayout(c, 'A5', 'std').contentBottom <= bottomLimit(148.5)
}

/** Phiếu có vừa 1 trang A4 không (kể cả bố cục gọn) — đề quá dài thì không in được */
export function fitsA4(c: ClassCounts): boolean {
  return buildClassLayout(c, 'A4', 'compact').contentBottom <= bottomLimit(297)
}

/** Tự chọn khổ (đợt chấm cũ chưa lưu khổ): vừa nửa trang thì in 2 phiếu/tờ */
export function autoPaperSize(c: ClassCounts): PaperSize {
  return fitsHalfA4(c) ? 'A5' : 'A4'
}

/**
 * Khổ + kiểu bố cục THỰC SỰ dùng cho một đợt chấm. Dùng chung cho lúc in và lúc quét nên phiếu in ra luôn khớp mẫu quét.
 *  - paper 'A5' (nửa trang): chỉ khi vừa; không vừa -> 1 trang A4.
 *  - paper 'A4' + big: ô to nếu vừa trang, không vừa -> chuẩn -> gọn.
 *  - không lưu paper (đợt chấm cũ): tự chọn như trước.
 */
export function resolveClassPaper(c: ClassCounts, paper?: PaperSize, big?: boolean): { size: PaperSize; style: ClassStyle } {
  const half = fitsHalfA4(c)
  if ((paper === 'A5' || paper === undefined) && half) return { size: 'A5', style: 'std' }
  const lim = bottomLimit(297)
  // 1 trang A4: ô càng to càng tốt, miễn vừa trang
  if (big && buildClassLayout(c, 'A4', 'xl').contentBottom <= lim) return { size: 'A4', style: 'xl' }
  if (big && buildClassLayout(c, 'A4', 'big').contentBottom <= lim) return { size: 'A4', style: 'big' }
  if (buildClassLayout(c, 'A4', 'std').contentBottom <= lim) return { size: 'A4', style: 'std' }
  return { size: 'A4', style: 'compact' }
}

export function classLayout(c: ClassCounts, size?: PaperSize, big?: boolean): ClassLayout {
  const r = resolveClassPaper(c, size, big)
  return buildClassLayout(c, r.size, r.style)
}

/** Bố cục theo đúng khổ + kiểu chỉ định (không tự đổi) — dùng để nhận ra phiếu in nhầm khổ */
export function buildClassLayoutFor(c: ClassCounts, size: PaperSize, style: ClassStyle): ClassLayout {
  return buildClassLayout(c, size, style)
}

function buildClassLayout(c: ClassCounts, size: PaperSize, style: ClassStyle): ClassLayout {
  const D = DIMS[style]
  const { BR, DX, DY, fs } = D
  const W = PAGE_W
  const Hh = size === 'A5' ? 148.5 : 297
  const draws: Draw[] = []
  const rows: BubbleRow[] = []
  const crops: SheetTemplate['crops'] = []
  const p3Boxes: NonNullable<SheetTemplate['p3Boxes']> = []

  // 4 mốc góc + 1 mốc phụ cạnh mốc trên-trái (xác định chiều phiếu)
  const corners: [Pt, Pt, Pt, Pt] = [
    { x: M, y: M },
    { x: W - M, y: M },
    { x: M, y: Hh - M },
    { x: W - M, y: Hh - M },
  ]
  const extra: Pt[] = [{ x: M + 9, y: M }]
  for (const p of [...corners, ...extra]) draws.push({ t: 'rect', x: p.x - MK / 2, y: p.y - MK / 2, w: MK, h: MK, fill: true })

  // Mã cấu trúc 16 bit: n1 (6 bit) | n2 (4 bit) | n3 (5 bit) | bit chẵn lẻ
  // Phần III lưới tô: trường n3 = số câu + 16 (bit 4 bật) -> phiếu lưới tô và phiếu viết tay cùng số câu có mã KHÁC nhau,
  // quét nhầm loại phiếu sẽ bị phát hiện ngay.
  const grid = p3IsGrid(c)
  const n3Code = grid ? (c.n3 & 15) | 16 : c.n3 & 31
  const CODE_SZ = 3
  const raw = (c.n1 & 63) | ((c.n2 & 15) << 6) | (n3Code << 10)
  let par = 0
  for (let k = 0; k < 15; k++) par ^= (raw >> k) & 1
  const codeValue = raw | (par << 15)
  const codeBits: Pt[] = Array.from({ length: 16 }, (_, k) => ({ x: M + 17 + k * 4.2, y: M }))
  codeBits.forEach((p, k) =>
    draws.push({ t: 'rect', x: p.x - CODE_SZ / 2, y: p.y - CODE_SZ / 2, w: CODE_SZ, h: CODE_SZ, fill: !!((codeValue >> k) & 1), sw: 0.3 }),
  )

  const L = M + 6 // lề trái nội dung
  const R = W - M - 6
  let y = M + 6

  // chữ to hơn (fs > 1) thì hạ tiêu đề xuống để không sát dãy ô mã cấu trúc
  draws.push({ t: 'text', x: W / 2, y: y + 1 + (fs - 1) * 6, s: 'PHIẾU TRẢ LỜI TRẮC NGHIỆM', size: 4.6 * fs, bold: true, anchor: 'middle' })
  y += 6 + Math.max(0, fs - 1) * 6

  // Khung thông tin
  const boxH = D.BOXH
  const fields: { label: string; w: number }[] = [
    { label: 'Họ và tên:', w: 0.47 },
    { label: 'STT:', w: 0.13 },
    { label: 'Lớp:', w: 0.17 },
    { label: 'Mã đề:', w: 0.23 },
  ]
  let fx = L
  const fullW = R - L
  for (const f of fields) {
    const fw = fullW * f.w
    draws.push({ t: 'rect', x: fx, y, w: fw, h: boxH, sw: 0.3 })
    draws.push({ t: 'text', x: fx + 1.5, y: y + 3.6 * fs, s: f.label, size: 3 * fs, bold: true })
    fx += fw
  }
  crops.push({ id: 'header', x: L - 2, y: y - 1, w: fullW + 4, h: boxH + 2 })
  y += boxH + 4

  // PHẦN I & PHẦN II — đặt cạnh nhau nếu đủ chỗ (phiếu gọn, vừa nửa trang A4)
  const P1_COLW = D.LBL + 4 * DX + 1.5 // nhãn câu + 4 ô
  const P1_GAP = 3
  const P2_BOXW = D.P2W
  const HEAD = 6 * fs // dòng chữ A B C D đầu cột
  const cols = p1Columns(c.n1)
  const rowsPer = cols.length ? Math.max(...cols.map((q) => q.length)) : 0
  const p1PerBand = Math.max(1, Math.floor((fullW + P1_GAP) / (P1_COLW + P1_GAP)))
  const p1Bands: number[][][] = []
  for (let b = 0; b * p1PerBand < cols.length; b++) p1Bands.push(cols.slice(b * p1PerBand, (b + 1) * p1PerBand))
  const p1BandH = HEAD + rowsPer * DY + 1
  const p1W = p1Bands.length ? Math.max(...p1Bands.map((b) => b.length)) * (P1_COLW + P1_GAP) - P1_GAP : 0
  const p1H = p1Bands.length ? p1Bands.length * (p1BandH + 2) - 2 : 0
  const p2PerRow = Math.max(1, Math.floor((fullW + 1) / P2_BOXW))
  const P2HEAD = 8 * fs
  const p2BoxH = P2HEAD + 4 * DY + 1
  const p2Rows = Math.ceil(c.n2 / p2PerRow)
  const p2W = c.n2 ? Math.min(c.n2, p2PerRow) * P2_BOXW - 1 : 0
  const p2H = c.n2 ? p2Rows * (p2BoxH + 2) - 2 : 0
  const side = c.n1 > 0 && c.n2 > 0 && p1Bands.length === 1 && p2Rows === 1 && p1W + 6 + p2W <= fullW
  const T1 = 4.5 * fs // khoảng tiêu đề phần

  const drawP1 = (x0: number, y0: number) => {
    draws.push({ t: 'text', x: x0, y: y0 + 2 * fs, s: 'PHẦN I. Tô kín một ô A, B, C hoặc D', size: 3.2 * fs, bold: true })
    let by = y0 + T1
    p1Bands.forEach((band, b) => {
      band.forEach((qs, k) => {
        const gx = x0 + k * (P1_COLW + P1_GAP)
        draws.push({ t: 'rect', x: gx, y: by, w: P1_COLW, h: p1BandH, sw: 0.3 })
        ;['A', 'B', 'C', 'D'].forEach((s2, i) =>
          draws.push({ t: 'text', x: gx + D.LBL + i * DX + BR, y: by + 4 * fs, s: s2, size: 3.1 * fs, bold: true, anchor: 'middle' }),
        )
        qs.forEach((q, r) => {
          const cy = by + HEAD + r * DY + DY / 2
          draws.push({ t: 'text', x: gx + D.LBL - 2.4, y: cy + 1.1 * fs, s: String(q), size: 3.1 * fs, bold: true, anchor: 'end' })
          const opts: Pt[] = []
          for (let i = 0; i < 4; i++) {
            const cx = gx + D.LBL + i * DX + BR
            opts.push({ x: cx, y: cy })
            draws.push({ t: 'circle', x: cx, y: cy, r: BR })
          }
          rows.push({ part: 1, q, block: `p1b${b}c${k}`, opts })
        })
      })
      by += p1BandH + 2
    })
  }
  const drawP2 = (x0: number, y0: number) => {
    draws.push({ t: 'text', x: x0, y: y0 + 2 * fs, s: 'PHẦN II. Mỗi ý tô một ô Đúng hoặc Sai', size: 3.2 * fs, bold: true })
    for (let b = 0; b < p2Rows; b++) {
      const top = y0 + T1 + b * (p2BoxH + 2)
      for (let k = 0; k < p2PerRow && b * p2PerRow + k < c.n2; k++) {
        const q = b * p2PerRow + k + 1
        const bx = x0 + k * P2_BOXW
        draws.push({ t: 'rect', x: bx, y: top, w: P2_BOXW - 1, h: p2BoxH, sw: 0.3 })
        draws.push({ t: 'text', x: bx + 1.2, y: top + 3.2 * fs, s: `Câu ${q}`, size: 2.9 * fs, bold: true })
        const xD = bx + D.xD,
          xS = bx + D.xS
        draws.push({ t: 'text', x: xD, y: top + 7 * fs, s: 'Đúng', size: 2.4 * fs, anchor: 'middle' })
        draws.push({ t: 'text', x: xS, y: top + 7 * fs, s: 'Sai', size: 2.4 * fs, anchor: 'middle' })
        for (let s2 = 0; s2 < 4; s2++) {
          const cy = top + P2HEAD + s2 * DY + DY / 2
          draws.push({ t: 'text', x: bx + 1.8, y: cy + 1 * fs, s: `${'abcd'[s2]})`, size: 2.9 * fs })
          draws.push({ t: 'circle', x: xD, y: cy, r: BR })
          draws.push({ t: 'circle', x: xS, y: cy, r: BR })
          rows.push({ part: 2, q, sub: s2, block: `p2q${q}`, opts: [{ x: xD, y: cy }, { x: xS, y: cy }] })
        }
      }
    }
  }
  if (side) {
    drawP1(L, y)
    drawP2(R - p2W, y)
    y += T1 + Math.max(p1H, p2H) + 4
  } else {
    if (c.n1) {
      drawP1(L, y)
      y += T1 + p1H + 4
    }
    if (c.n2) {
      drawP2(L, y)
      y += T1 + p2H + 4
    }
  }

  // PHẦN III
  if (c.n3 && grid) {
    // ---- LƯỚI TÔ Ô chuẩn Bộ GD&ĐT (số đo kiểu 'std', các kiểu khác nhân hệ số P3K) ----
    //  Mỗi câu 1 khối rộng BW: cột nhãn (− , 0..9) + 4 cột tô, bước cột CX; 12 hàng bước RY; ô tròn bán kính BR3.
    //  Gốc khối (bx, yT): "Câu k" | ô ghi nháp yT+4,4 → yT+9,4 | tâm hàng 0 (dấu −) yT+13,0 | tâm hàng 11 (số 9) yT+65,8 | đáy yT+69,2
    const k = P3K[style]
    const BR3 = 2.0 * k
    const CX = 5.6 * k
    const RY = 4.8 * k
    const LBLW = 4.5 * k
    const BW = LBLW + 4 * CX + 1.5 * k
    const GAP = 1.6 * k
    const DRAFT_Y = 4.4 * k
    const DRAFT_H = 5 * k
    const ROW0 = DRAFT_Y + DRAFT_H + 1.2 * k + RY / 2
    const BH = ROW0 + 11 * RY + BR3 + 1.4 * k
    draws.push({
      t: 'text',
      x: L,
      y: y + 2 * fs,
      s: 'PHẦN III. Mỗi cột tô đúng một ô (dấu −, dấu phẩy hoặc chữ số); ô vuông trên cùng chỉ để ghi nháp',
      size: 3.1 * fs,
      bold: true,
    })
    y += 5 * fs
    const perRow = Math.max(1, Math.min(6, Math.floor((fullW + GAP) / (BW + GAP))))
    const gridTop = y
    for (let b = 0; b * perRow < c.n3; b++) {
      const yT = y
      for (let kk = 0; kk < perRow && b * perRow + kk < c.n3; kk++) {
        const q = b * perRow + kk + 1
        const bx = L + kk * (BW + GAP)
        draws.push({ t: 'rect', x: bx, y: yT, w: BW, h: BH, sw: 0.35 })
        draws.push({ t: 'text', x: bx + 1.2 * k, y: yT + 3.3 * k, s: `Câu ${q}`, size: 2.9 * k, bold: true })
        const colX = (j: number) => bx + LBLW + CX / 2 + j * CX
        const rowY = (r: number) => yT + ROW0 + r * RY
        // ô ghi nháp (không đọc)
        for (let j = 0; j < 4; j++) draws.push({ t: 'rect', x: colX(j) - (CX - 1 * k) / 2, y: yT + DRAFT_Y, w: CX - 1 * k, h: DRAFT_H, sw: 0.3 })
        // nhãn hàng bên trái + vạch ngăn giữa hàng dấu và hàng chữ số
        P3_ROW_CHARS.forEach((ch, r) =>
          draws.push({ t: 'text', x: bx + LBLW * 0.5, y: rowY(r) + 0.95 * k, s: ch === '-' ? '−' : ch, size: 2.7 * k, bold: true, anchor: 'middle' }),
        )
        const sepY = rowY(1) + RY / 2
        draws.push({ t: 'line', x1: bx + 0.8 * k, y1: sepY, x2: bx + BW - 0.8 * k, y2: sepY, sw: 0.2 })
        // ô tô: viền đen đậm, ký tự in xám nhạt bên trong (giống phiếu Bộ)
        for (let j = 0; j < 4; j++) {
          const chars = P3_COL_CHARS[j]
          const opts: Pt[] = chars.map((ch) => ({ x: colX(j), y: rowY(P3_ROW_CHARS.indexOf(ch)) }))
          opts.forEach((o, i) => {
            draws.push({ t: 'circle', x: o.x, y: o.y, r: BR3, sw: 0.4 })
            const ch = chars[i]
            draws.push({
              t: 'text',
              x: o.x,
              y: o.y + (ch === ',' ? 0.35 : ch === '-' ? 0.75 : 0.78) * k,
              s: ch === '-' ? '−' : ch,
              size: (ch === ',' ? 3.2 : 2.2) * k,
              anchor: 'middle',
              fill: '#a6a6a6',
              sans: true,
            })
          })
          rows.push({ part: 3, q, col: j, chars, block: `p3q${q}`, r: BR3, opts })
        }
        p3Boxes.push({ q, x: bx, y: yT, w: BW, h: BH })
      }
      y += BH + 2
    }
    // 2 mốc ■ phụ ở mép trái/phải, ngang tâm lưới Phần III: bám vị trí chắc hơn ở nửa dưới tờ giấy
    const yMid = (gridTop + y - 2) / 2
    for (const p of [
      { x: M, y: yMid },
      { x: W - M, y: yMid },
    ]) {
      extra.push(p)
      draws.push({ t: 'rect', x: p.x - MK / 2, y: p.y - MK / 2, w: MK, h: MK, fill: true })
    }
    y += 2
  } else if (c.n3) {
    // ---- Ô VIẾT TAY (đợt chấm cũ — giữ nguyên để phiếu đã in vẫn quét được) ----
    draws.push({ t: 'text', x: L, y: y + 2 * fs, s: 'PHẦN III. Ghi đáp số vào ô (số nguyên hoặc số thập phân, dùng dấu phẩy)', size: 3.3 * fs, bold: true })
    y += 5 * fs
    const perRow = 8
    const top0 = y
    for (let b = 0; b * perRow < c.n3; b++) {
      const boxW = fullW / perRow
      for (let k = 0; k < perRow && b * perRow + k < c.n3; k++) {
        const q = b * perRow + k + 1
        const bx = L + k * boxW
        draws.push({ t: 'text', x: bx + 1, y: y + 3 * fs, s: `Câu ${q}`, size: 2.9 * fs, bold: true })
        draws.push({ t: 'rect', x: bx, y: y + 4.2 * fs, w: boxW - 1.5, h: D.P3H, sw: 0.35 })
        p3Boxes.push({ q, x: bx, y: y + 4.2 * fs, w: boxW - 1.5, h: D.P3H })
      }
      y += D.P3STEP
    }
    crops.push({ id: 'p3', x: L - 2, y: top0 - 1, w: fullW + 4, h: y - top0 + 1 })
  }

  const template: SheetTemplate = {
    kind: 'class',
    corners,
    extraMarkers: extra,
    code: {
      bits: codeBits,
      size: CODE_SZ,
      value: codeValue,
      describe: (v) => {
        const r = v & 0x7fff
        let p = 0
        for (let k = 0; k < 15; k++) p ^= (r >> k) & 1
        if (p !== (v >> 15)) return 'mẫu phiếu khác (không đọc được mã cấu trúc)'
        const n3c = (r >> 10) & 31
        // n3 ≥ 16: Phần III lưới tô (phiếu viết tay cũ chỉ tới 20 câu Phần III nên rất hiếm khi trùng)
        return n3c >= 16
          ? `đề ${r & 63}–${(r >> 6) & 15}–${n3c & 15} câu (Phần III tô ô)`
          : `đề ${r & 63}–${(r >> 6) & 15}–${n3c} câu${n3c ? ' (Phần III viết tay)' : ''}`
      },
    },
    markerSize: MK,
    bubbleR: BR,
    rows,
    crops,
    p3Boxes,
    p3Grid: grid,
    frame: { x: 0, y: 0, w: W, h: Hh },
  }
  return { size, style, width: W, height: Hh, template, draws, contentBottom: y }
}

/** Mô tả khổ phiếu để hiện cho giáo viên */
export function describeClassPaper(c: ClassCounts, paper?: PaperSize, big?: boolean): string {
  const r = resolveClassPaper(c, paper, big)
  const g = p3IsGrid(c) ? ' · Phần III tô ô' : ''
  if (r.size === 'A5') return 'Nửa trang A4 (2 phiếu/tờ, cắt đôi)'
  return (r.style === 'xl' || r.style === 'big' ? '1 trang A4 – ô tô lớn' : r.style === 'compact' ? '1 trang A4 – bố cục gọn (đề dài)' : '1 trang A4') + g
}

/** SVG một phiếu (đơn vị mm) */
export function layoutToSvg(l: ClassLayout, title = ''): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const parts: string[] = []
  for (const d of l.draws) {
    if (d.t === 'rect')
      parts.push(
        `<rect x="${d.x}" y="${d.y}" width="${d.w}" height="${d.h}" ${d.fill ? 'fill="#000"' : `fill="none" stroke="#000" stroke-width="${d.sw ?? 0.3}"`}/>`,
      )
    else if (d.t === 'circle') parts.push(`<circle cx="${d.x}" cy="${d.y}" r="${d.r}" fill="none" stroke="#000" stroke-width="${d.sw ?? 0.32}"/>`)
    else if (d.t === 'line')
      parts.push(`<line x1="${d.x1}" y1="${d.y1}" x2="${d.x2}" y2="${d.y2}" stroke="#000" stroke-width="${d.sw ?? 0.3}"${d.dash ? ' stroke-dasharray="1 1"' : ''}/>`)
    else
      parts.push(
        `<text x="${d.x}" y="${d.y}" font-size="${d.size}" font-family="${d.sans ? 'Arial, Helvetica, sans-serif' : 'Times New Roman, serif'}"${d.bold ? ' font-weight="bold"' : ''}${d.anchor ? ` text-anchor="${d.anchor}"` : ''}${d.fill ? ` fill="${d.fill}"` : ''}>${esc(d.s)}</text>`,
      )
  }
  if (title)
    parts.push(
      `<text x="${l.width - M - 6}" y="${M + 1.2}" font-size="2.6" text-anchor="end" font-family="Times New Roman, serif" fill="#444">${esc(title)}</text>`,
    )
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${l.width}mm" height="${l.height}mm" viewBox="0 0 ${l.width} ${l.height}">${parts.join('')}</svg>`
}

// ======================================================================
// PHIẾU 35 CÂU A–D KHÔNG CÓ Ô VUÔNG ĐỊNH VỊ (VD phiếu kiểm tra tiếng Anh: 4 cột 10–10–10–5 câu)
//   Đơn vị: 10 = khoảng cách 2 ô cạnh nhau (A→B). Máy tự tìm lưới ô tròn, không cần mốc ■.
// ======================================================================

const G35_UNIT = 10
const G35_GAP = 5.04 // khoảng cách từ ô A cột này tới ô A cột kế (theo số ô)
const G35_ROW = 0.9 // khoảng cách hàng (theo số ô)
export const GRID35_LIMITS = { n1: 35, n2: 0, n3: 0 }

export function grid35Template(): SheetTemplate {
  const rows: BubbleRow[] = []
  const X = (g: number, o: number) => G35_UNIT * (g * G35_GAP + o)
  const Y = (r: number) => G35_UNIT * G35_ROW * r
  for (let q = 1; q <= 35; q++) {
    const g = Math.floor((q - 1) / 10),
      r = (q - 1) % 10
    rows.push({ part: 1, q, block: `p1g${g}`, opts: [0, 1, 2, 3].map((o) => ({ x: X(g, o), y: Y(r) })) })
  }
  return {
    kind: 'grid',
    gridSpec: { groups: [10, 10, 10, 5], groupGap: G35_GAP, rowStep: G35_ROW, unit: G35_UNIT },
    corners: [
      { x: X(0, 0), y: Y(0) },
      { x: X(3, 3), y: Y(0) },
      { x: X(0, 0), y: Y(9) },
      { x: X(2, 3), y: Y(9) },
    ],
    extraMarkers: [],
    markerSize: 3,
    bubbleR: 2.3,
    rows,
    crops: [{ id: 'header', x: -70, y: -62, w: 285, h: 40 }],
    frame: { x: -28, y: -14, w: 238, h: 108 },
  }
}
