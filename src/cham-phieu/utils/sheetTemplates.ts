/**
 * MẪU PHIẾU TRẢ LỜI
 *  - 'school': phiếu in sẵn của trường (Phần I 40 câu, Phần II 6 câu, Phần III 8 câu viết tay,
 *    có 6 ô vuông đen ■ quanh Phần I). Toạ độ đo từ phiếu thật, đơn vị: mốc trên-trái (0,0),
 *    mốc trên-phải (1000,0). Phiếu chỉ cần chụp — không cần in đúng kích cỡ.
 *  - 'class': phiếu do web tạo cho bài kiểm tra tại lớp, đúng số câu của đề. Đơn vị: mm trên giấy.
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
}

/** Phần tử vẽ của phiếu lớp (để xuất SVG in ra giấy) */
export type Draw =
  | { t: 'rect'; x: number; y: number; w: number; h: number; fill?: boolean; sw?: number; r?: number }
  | { t: 'circle'; x: number; y: number; r: number }
  | { t: 'text'; x: number; y: number; s: string; size: number; bold?: boolean; anchor?: 'start' | 'middle' | 'end' }
  | { t: 'line'; x1: number; y1: number; x2: number; y2: number; sw?: number; dash?: boolean }

export interface ClassLayout {
  size: PaperSize
  width: number
  height: number
  template: SheetTemplate
  draws: Draw[]
  contentBottom: number
}

const PAGE_W = 210
const M = 9 // lề tới tâm mốc
const MK = 5 // cạnh mốc
const BR = 2.2 // bán kính ô tô (đường kính 4.4 mm)
const DX = 6.2 // khoảng cách ngang giữa các ô A-B-C-D
const DY = 5.6 // khoảng cách hàng

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

/** Tự chọn khổ: phiếu vừa nửa trang A4 thì in 2 phiếu/tờ (khổ A5 ngang = nửa A4) */
export function autoPaperSize(c: ClassCounts): PaperSize {
  return classLayout(c, 'A4').contentBottom <= 148.5 - M - MK / 2 - 3 ? 'A5' : 'A4'
}

export function classLayout(c: ClassCounts, size?: PaperSize): ClassLayout {
  if (!size) size = autoPaperSize(c)
  const W = PAGE_W
  const Hh = size === 'A5' ? 148.5 : 297
  const draws: Draw[] = []
  const rows: BubbleRow[] = []
  const crops: SheetTemplate['crops'] = []

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
  const CODE_SZ = 3
  const raw = (c.n1 & 63) | ((c.n2 & 15) << 6) | ((c.n3 & 31) << 10)
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

  draws.push({ t: 'text', x: W / 2, y: y + 1, s: 'PHIẾU TRẢ LỜI TRẮC NGHIỆM', size: 4.6, bold: true, anchor: 'middle' })
  y += 6

  // Khung thông tin
  const boxH = 13
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
    draws.push({ t: 'text', x: fx + 1.5, y: y + 3.6, s: f.label, size: 3, bold: true })
    fx += fw
  }
  crops.push({ id: 'header', x: L - 2, y: y - 1, w: fullW + 4, h: boxH + 2 })
  y += boxH + 4

  // PHẦN I & PHẦN II — đặt cạnh nhau nếu đủ chỗ (phiếu gọn, vừa nửa trang A4)
  const P1_COLW = 8 + 4 * DX + 1.5 // nhãn câu + 4 ô
  const P1_GAP = 3
  const P2_BOXW = 23.5
  const cols = p1Columns(c.n1)
  const rowsPer = cols.length ? Math.max(...cols.map((q) => q.length)) : 0
  const p1PerBand = Math.max(1, Math.floor((fullW + P1_GAP) / (P1_COLW + P1_GAP)))
  const p1Bands: number[][][] = []
  for (let b = 0; b * p1PerBand < cols.length; b++) p1Bands.push(cols.slice(b * p1PerBand, (b + 1) * p1PerBand))
  const p1BandH = 6 + rowsPer * DY + 1
  const p1W = p1Bands.length ? Math.max(...p1Bands.map((b) => b.length)) * (P1_COLW + P1_GAP) - P1_GAP : 0
  const p1H = p1Bands.length ? p1Bands.length * (p1BandH + 2) - 2 : 0
  const p2PerRow = Math.max(1, Math.floor((fullW + 1) / P2_BOXW))
  const p2BoxH = 8 + 4 * DY + 1
  const p2Rows = Math.ceil(c.n2 / p2PerRow)
  const p2W = c.n2 ? Math.min(c.n2, p2PerRow) * P2_BOXW - 1 : 0
  const p2H = c.n2 ? p2Rows * (p2BoxH + 2) - 2 : 0
  const side = c.n1 > 0 && c.n2 > 0 && p1Bands.length === 1 && p2Rows === 1 && p1W + 6 + p2W <= fullW

  const drawP1 = (x0: number, y0: number) => {
    draws.push({ t: 'text', x: x0, y: y0 + 2, s: 'PHẦN I. Tô kín một ô A, B, C hoặc D', size: 3.2, bold: true })
    let by = y0 + 4.5
    p1Bands.forEach((band, b) => {
      band.forEach((qs, k) => {
        const gx = x0 + k * (P1_COLW + P1_GAP)
        draws.push({ t: 'rect', x: gx, y: by, w: P1_COLW, h: p1BandH, sw: 0.3 })
        ;['A', 'B', 'C', 'D'].forEach((s2, i) =>
          draws.push({ t: 'text', x: gx + 8 + i * DX + BR, y: by + 4, s: s2, size: 3.1, bold: true, anchor: 'middle' }),
        )
        qs.forEach((q, r) => {
          const cy = by + 6 + r * DY + DY / 2
          draws.push({ t: 'text', x: gx + 5.6, y: cy + 1.1, s: String(q), size: 3.1, bold: true, anchor: 'end' })
          const opts: Pt[] = []
          for (let i = 0; i < 4; i++) {
            const cx = gx + 8 + i * DX + BR
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
    draws.push({ t: 'text', x: x0, y: y0 + 2, s: 'PHẦN II. Mỗi ý tô một ô Đúng hoặc Sai', size: 3.2, bold: true })
    for (let b = 0; b < p2Rows; b++) {
      const top = y0 + 4.5 + b * (p2BoxH + 2)
      for (let k = 0; k < p2PerRow && b * p2PerRow + k < c.n2; k++) {
        const q = b * p2PerRow + k + 1
        const bx = x0 + k * P2_BOXW
        draws.push({ t: 'rect', x: bx, y: top, w: P2_BOXW - 1, h: p2BoxH, sw: 0.3 })
        draws.push({ t: 'text', x: bx + 1.2, y: top + 3.2, s: `Câu ${q}`, size: 2.9, bold: true })
        const xD = bx + 10.2,
          xS = bx + 17.6
        draws.push({ t: 'text', x: xD, y: top + 7, s: 'Đúng', size: 2.4, anchor: 'middle' })
        draws.push({ t: 'text', x: xS, y: top + 7, s: 'Sai', size: 2.4, anchor: 'middle' })
        for (let s2 = 0; s2 < 4; s2++) {
          const cy = top + 8 + s2 * DY + DY / 2
          draws.push({ t: 'text', x: bx + 1.8, y: cy + 1, s: `${'abcd'[s2]})`, size: 2.9 })
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
    y += 4.5 + Math.max(p1H, p2H) + 4
  } else {
    if (c.n1) {
      drawP1(L, y)
      y += 4.5 + p1H + 4
    }
    if (c.n2) {
      drawP2(L, y)
      y += 4.5 + p2H + 4
    }
  }

  // PHẦN III (viết tay)
  if (c.n3) {
    draws.push({ t: 'text', x: L, y: y + 2, s: 'PHẦN III. Ghi đáp số vào ô (số nguyên hoặc số thập phân, dùng dấu phẩy)', size: 3.3, bold: true })
    y += 5
    const perRow = 8
    const top0 = y
    for (let b = 0; b * perRow < c.n3; b++) {
      const boxW = fullW / perRow
      for (let k = 0; k < perRow && b * perRow + k < c.n3; k++) {
        const q = b * perRow + k + 1
        const bx = L + k * boxW
        draws.push({ t: 'text', x: bx + 1, y: y + 3, s: `Câu ${q}`, size: 2.9, bold: true })
        draws.push({ t: 'rect', x: bx, y: y + 4.2, w: boxW - 1.5, h: 10, sw: 0.35 })
      }
      y += 17
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
        return `đề ${r & 63}–${(r >> 6) & 15}–${(r >> 10) & 31} câu`
      },
    },
    markerSize: MK,
    bubbleR: BR,
    rows,
    crops,
    frame: { x: 0, y: 0, w: W, h: Hh },
  }
  return { size, width: W, height: Hh, template, draws, contentBottom: y }
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
    else if (d.t === 'circle') parts.push(`<circle cx="${d.x}" cy="${d.y}" r="${d.r}" fill="none" stroke="#000" stroke-width="0.32"/>`)
    else if (d.t === 'line')
      parts.push(`<line x1="${d.x1}" y1="${d.y1}" x2="${d.x2}" y2="${d.y2}" stroke="#000" stroke-width="${d.sw ?? 0.3}"${d.dash ? ' stroke-dasharray="1 1"' : ''}/>`)
    else
      parts.push(
        `<text x="${d.x}" y="${d.y}" font-size="${d.size}" font-family="Times New Roman, serif"${d.bold ? ' font-weight="bold"' : ''}${d.anchor ? ` text-anchor="${d.anchor}"` : ''}>${esc(d.s)}</text>`,
      )
  }
  if (title)
    parts.push(
      `<text x="${l.width - M - 6}" y="${M + 1.2}" font-size="2.6" text-anchor="end" font-family="Times New Roman, serif" fill="#444">${esc(title)}</text>`,
    )
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${l.width}mm" height="${l.height}mm" viewBox="0 0 ${l.width} ${l.height}">${parts.join('')}</svg>`
}
