/**
 * ĐỌC Ô TÔ (bubble) TRÊN PHIẾU TRẢ LỜI BẰNG XỬ LÝ ẢNH — KHÔNG DÙNG AI
 *
 * Phần I (A/B/C/D) và Phần II (Đúng/Sai) được đọc bằng toạ độ điểm ảnh nên kết quả
 * ổn định, không "đoán". Các bước:
 *   1. Ảnh -> ảnh xám (lấy kênh tối nhất để mực xanh cũng thành đậm), thu nhỏ hợp lí.
 *   2. Nhị phân hoá cục bộ -> tìm các ô vuông đen ■ (mốc định vị).
 *   3. Tìm khung phiếu: thử 4 mốc góc; mốc bị che / dính đường kẻ / mờ thì chỉ cần 3 mốc góc + 1 mốc phụ
 *      (phân biệt mốc VUÔNG với ô tròn đã tô), thử thêm ở độ phân giải thấp hơn; đúng cả khi ảnh xoay.
 *   4. Nắn phẳng (phép biến đổi phối cảnh) về hệ toạ độ chuẩn của mẫu phiếu.
 *   5. Từng khối ô: dò lại tâm ô thật (giấy cong, in lệch vẫn bám đúng).
 *   6. Đo độ đậm lòng mỗi ô, so với nền giấy tại chỗ -> chọn đáp án;
 *      tô nhiều ô / ô mờ / vết tẩy -> đánh dấu để giáo viên quyết.
 *
 * File này chỉ chứa thuật toán thuần (không dùng DOM) để chạy được cả trong trình duyệt lẫn khi kiểm thử.
 */

// ---------------- KIỂU DỮ LIỆU ----------------

/** Ảnh xám: d[y*w+x] = độ sáng 0..255 */
export interface Gray {
  w: number
  h: number
  d: Uint8Array | Uint8ClampedArray | Float32Array
}

export interface Pt {
  x: number
  y: number
}

/** Một hàng lựa chọn: Phần I = 4 ô A..D, Phần II = 2 ô Đúng/Sai */
export interface BubbleRow {
  part: 1 | 2
  q: number // số thứ tự câu (bắt đầu 1)
  sub?: number // Phần II: ý 0..3 (a..d)
  block: string // các hàng cùng khối được căn chỉnh chung
  r?: number // bán kính ô (tâm nét viền), mặc định = template.bubbleR
  opts: Pt[] // tâm các ô (toạ độ mẫu)
}

export interface SheetTemplate {
  /** 'grid' = phiếu KHÔNG có ô vuông định vị: máy tự tìm lưới ô tròn (VD phiếu 35 câu A–D) */
  kind: 'school' | 'class' | 'grid'
  /** Phiếu 'grid': khoảng cách nhóm cột (đơn vị = khoảng cách 2 ô A–B) */
  gridSpec?: { groups: number[]; groupGap: number; rowStep: number; unit: number }
  /** 4 mốc góc theo thứ tự: trên-trái, trên-phải, dưới-trái, dưới-phải (toạ độ mẫu) */
  corners: [Pt, Pt, Pt, Pt]
  /** Các mốc phụ (để xác nhận đúng phiếu và đúng chiều) */
  extraMarkers: Pt[]
  markerSize: number // cạnh ô mốc (đơn vị mẫu)
  bubbleR: number // bán kính ô tô (đơn vị mẫu)
  rows: BubbleRow[]
  /** Vùng chữ viết tay gửi cho AI đọc (đơn vị mẫu) */
  crops: { id: 'header' | 'p3'; x: number; y: number; w: number; h: number }[]
  /** Mã cấu trúc in trên phiếu (ô vuông đặc = 1, ô rỗng = 0) để chống dùng nhầm phiếu của đề khác */
  code?: { bits: Pt[]; size: number; value: number; describe: (v: number) => string }
  /** Khung bao toàn phiếu (đơn vị mẫu) — để vẽ ảnh đối chiếu */
  frame: { x: number; y: number; w: number; h: number }
}

export interface BubbleRead {
  /** Phần I: chỉ số câu (0-based) -> 'A'..'D' | null */
  p1: (string | null)[]
  /** Phần II: [câu][ý] -> true/false/null */
  p2: (boolean | null)[][]
  flags: Record<string, string>
  /** Điểm đậm từng ô theo hàng (để vẽ ảnh đối chiếu, gỡ lỗi) */
  detail: { row: BubbleRow; centers: Pt[]; scores: number[]; rings: number[]; chosen: number | null; flagged: boolean }[]
  /** Ma trận đồng nhất: toạ độ mẫu -> toạ độ ảnh gốc */
  H: number[]
  quality: number // 0..1: độ khớp mẫu
  inkLevel: number
}

export class OmrError extends Error {}

// ---------------- ẢNH XÁM ----------------

/**
 * RGBA -> ảnh xám. Lấy min(R,G,B) để mực xanh/tím, bút chì, bút đen đều thành "đậm",
 * nền giấy trắng/ngà vẫn sáng. Thu nhỏ để cạnh dài ≤ maxSide.
 * Cân bằng trắng trước: ảnh chụp dưới đèn vàng (buổi tối) làm kênh xanh lam tối hẳn -> min(R,G,B) của giấy trắng
 * cũng tối, ô trống bị coi như "tô mờ". Mỗi kênh được nhân hệ số để màu giấy (phân vị 92%) trở về trung tính.
 */
export function rgbaToGray(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, maxSide = 2000): Gray {
  const s = Math.min(1, maxSide / Math.max(w, h))
  const W = Math.max(1, Math.round(w * s))
  const Hh = Math.max(1, Math.round(h * s))
  const out = new Uint8Array(W * Hh)
  // --- cân bằng trắng theo màu giấy ---
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)]
  const stepPx = Math.max(1, Math.floor((w * h) / 200000))
  let cnt = 0
  for (let i = 0; i < w * h; i += stepPx) {
    const j = i * 4
    hist[0][rgba[j]]++
    hist[1][rgba[j + 1]]++
    hist[2][rgba[j + 2]]++
    cnt++
  }
  const pct = (hh: Uint32Array) => {
    let acc = 0
    for (let v = 0; v < 256; v++) {
      acc += hh[v]
      if (acc >= cnt * 0.92) return Math.max(1, v)
    }
    return 255
  }
  const P = hist.map(pct)
  const top = Math.max(...P)
  const luts = P.map((p) => {
    const gain = Math.min(2.5, top / p)
    const lut = new Uint8Array(256)
    for (let v = 0; v < 256; v++) lut[v] = Math.min(255, Math.round(v * gain))
    return lut
  })
  const [LR, LG, LB] = luts
  const px = (j: number) => {
    const r = LR[rgba[j]],
      g = LG[rgba[j + 1]],
      b = LB[rgba[j + 2]]
    return r < g ? (r < b ? r : b) : g < b ? g : b
  }
  if (s === 1) {
    for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = px(j)
    return { w: W, h: Hh, d: out }
  }
  // thu nhỏ bằng trung bình ô (box filter)
  const inv = 1 / s
  for (let y = 0; y < Hh; y++) {
    const y0 = Math.floor(y * inv),
      y1 = Math.min(h, Math.max(y0 + 1, Math.floor((y + 1) * inv)))
    for (let x = 0; x < W; x++) {
      const x0 = Math.floor(x * inv),
        x1 = Math.min(w, Math.max(x0 + 1, Math.floor((x + 1) * inv)))
      let sum = 0,
        n = 0
      for (let yy = y0; yy < y1; yy++)
        for (let xx = x0; xx < x1; xx++) {
          sum += px((yy * w + xx) * 4)
          n++
        }
      out[y * W + x] = sum / n
    }
  }
  return { w: W, h: Hh, d: out }
}

/** Nhị phân hoá theo trung bình cục bộ (ảnh tích phân): 1 = đậm */
export function adaptiveBinarize(g: Gray, win: number, c: number): Uint8Array {
  const { w, h, d } = g
  const W1 = w + 1
  const I = new Float64Array(W1 * (h + 1))
  for (let y = 0; y < h; y++) {
    let row = 0
    for (let x = 0; x < w; x++) {
      row += d[y * w + x]
      I[(y + 1) * W1 + x + 1] = I[y * W1 + x + 1] + row
    }
  }
  const r = Math.max(2, Math.floor(win / 2))
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const ya = Math.max(0, y - r),
      yb = Math.min(h, y + r + 1)
    for (let x = 0; x < w; x++) {
      const xa = Math.max(0, x - r),
        xb = Math.min(w, x + r + 1)
      const sum = I[yb * W1 + xb] - I[ya * W1 + xb] - I[yb * W1 + xa] + I[ya * W1 + xa]
      const mean = sum / ((yb - ya) * (xb - xa))
      out[y * w + x] = d[y * w + x] < mean - c ? 1 : 0
    }
  }
  return out
}

interface Blob {
  x0: number
  y0: number
  x1: number
  y1: number
  area: number
  cx: number
  cy: number
  vxx: number // phương sai toạ độ (bất biến khi xoay: vxx + vyy)
  vyy: number
  vxy: number
}

/** Tìm các vùng liên thông (8 hướng) của ảnh nhị phân */
export function components(bin: Uint8Array, w: number, h: number, maxSide: number): Blob[] {
  const lab = new Int32Array(w * h)
  const out: Blob[] = []
  const stack = new Int32Array(w * h)
  let id = 0
  for (let p = 0; p < w * h; p++) {
    if (!bin[p] || lab[p]) continue
    id++
    let sp = 0
    stack[sp++] = p
    lab[p] = id
    let x0 = w,
      y0 = h,
      x1 = 0,
      y1 = 0,
      area = 0,
      sx = 0,
      sy = 0,
      sxx = 0,
      syy = 0,
      sxy = 0,
      big = false
    while (sp) {
      const q = stack[--sp]
      const qx = q % w,
        qy = (q - qx) / w
      area++
      sx += qx
      sy += qy
      sxx += qx * qx
      syy += qy * qy
      sxy += qx * qy
      if (qx < x0) x0 = qx
      if (qx > x1) x1 = qx
      if (qy < y0) y0 = qy
      if (qy > y1) y1 = qy
      if (x1 - x0 > maxSide || y1 - y0 > maxSide) big = true
      for (let dy = -1; dy <= 1; dy++) {
        const ny = qy + dy
        if (ny < 0 || ny >= h) continue
        for (let dx = -1; dx <= 1; dx++) {
          const nx = qx + dx
          if (nx < 0 || nx >= w) continue
          const n = ny * w + nx
          if (bin[n] && !lab[n]) {
            lab[n] = id
            stack[sp++] = n
          }
        }
      }
    }
    if (!big) {
      const cx = sx / area,
        cy = sy / area
      out.push({ x0, y0, x1, y1, area, cx, cy, vxx: sxx / area - cx * cx, vyy: syy / area - cy * cy, vxy: sxy / area - cx * cy })
    }
  }
  return out
}

// ---------------- PHÉP BIẾN ĐỔI PHỐI CẢNH ----------------

/** Giải hệ Ax=b (Gauss, chọn trụ) */
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length
  const M = A.map((r, i) => [...r, b[i]])
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r
    if (Math.abs(M[p][c]) < 1e-12) return null
    ;[M[c], M[p]] = [M[p], M[c]]
    for (let r = 0; r < n; r++) {
      if (r === c) continue
      const f = M[r][c] / M[c][c]
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]
    }
  }
  return M.map((r, i) => r[n] / r[i])
}

/** Ma trận H (3x3, h33 = 1) biến src[i] -> dst[i] (4 cặp điểm) */
export function homography(src: Pt[], dst: Pt[]): number[] | null {
  const A: number[][] = []
  const b: number[] = []
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i]
    const { x: u, y: v } = dst[i]
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y])
    b.push(u)
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y])
    b.push(v)
  }
  const s = solve(A, b)
  return s ? [...s, 1] : null
}

export function applyH(H: number[], p: Pt): Pt {
  const z = H[6] * p.x + H[7] * p.y + H[8]
  return { x: (H[0] * p.x + H[1] * p.y + H[2]) / z, y: (H[3] * p.x + H[4] * p.y + H[5]) / z }
}

/** Lấy mẫu độ sáng tại (x,y) bằng nội suy song tuyến; ngoài ảnh = 255 */
export function sampleGray(g: Gray, x: number, y: number): number {
  if (x < 0 || y < 0 || x > g.w - 1 || y > g.h - 1) return 255
  const x0 = Math.floor(x),
    y0 = Math.floor(y)
  const x1 = Math.min(g.w - 1, x0 + 1),
    y1 = Math.min(g.h - 1, y0 + 1)
  const fx = x - x0,
    fy = y - y0
  const d = g.d
  const a = d[y0 * g.w + x0] * (1 - fx) + d[y0 * g.w + x1] * fx
  const b = d[y1 * g.w + x0] * (1 - fx) + d[y1 * g.w + x1] * fx
  return a * (1 - fy) + b * fy
}

/**
 * Nắn phẳng: tạo ảnh xám trong hệ toạ độ mẫu, vùng [x0, x0+w] × [y0, y0+h], tỉ lệ `scale` px / đơn vị mẫu.
 */
export function warp(g: Gray, H: number[], x0: number, y0: number, w: number, h: number, scale: number): Gray {
  const W = Math.round(w * scale),
    Hh = Math.round(h * scale)
  const out = new Float32Array(W * Hh)
  for (let j = 0; j < Hh; j++)
    for (let i = 0; i < W; i++) {
      const p = applyH(H, { x: x0 + (i + 0.5) / scale, y: y0 + (j + 0.5) / scale })
      out[j * W + i] = sampleGray(g, p.x, p.y)
    }
  return { w: W, h: Hh, d: out }
}

// ---------------- TÌM MỐC ■ ----------------

interface Cand extends Pt {
  side: number
  fill: number
}

function markerCandidates(g: Gray): Cand[] {
  const long = Math.max(g.w, g.h)
  const win = Math.max(15, Math.round(long / 25)) | 1
  const bin = adaptiveBinarize(g, win, 12)
  const maxSide = Math.round(long * 0.06)
  const minSide = Math.max(4, Math.round(long * 0.005))
  const out: Cand[] = []
  for (const b of components(bin, g.w, g.h, maxSide)) {
    const bw = b.x1 - b.x0 + 1,
      bh = b.y1 - b.y0 + 1
    if (bw < minSide || bh < minSide) continue
    // Hình đặc, gọn (vuông/tròn đặc) — không phụ thuộc góc xoay:
    // vuông đặc: diện tích / (vxx+vyy) = 6; tròn đặc: 2π ≈ 6.28; hình rỗng/chữ: nhỏ hơn nhiều
    const tr = b.vxx + b.vyy + 1 / 6
    const k = b.area / tr
    if (k < 4.9 || k > 7) continue
    const det = Math.sqrt(Math.max(0, ((b.vxx - b.vyy) / 2) ** 2 + b.vxy * b.vxy))
    const l1 = (b.vxx + b.vyy) / 2 + det,
      l2 = (b.vxx + b.vyy) / 2 - det
    if (l2 <= 0 || l1 / l2 > 2.2) continue // kéo dài -> không phải ô vuông
    out.push({ x: b.cx, y: b.cy, side: Math.sqrt(b.area), fill: k })
  }
  // giữ các vùng lớn nhất (mốc thường to hơn chữ, chấm bẩn)
  out.sort((a, b) => b.side - a.side)
  return out.slice(0, 90)
}

/** Phép affine (6 hệ số) biến 3 điểm mẫu -> 3 điểm ảnh: x' = a x + b y + c, y' = d x + e y + f */
function affine3(src: Pt[], dst: Pt[]): number[] | null {
  const A = src.map((p) => [p.x, p.y, 1])
  const sx = solve(A, dst.map((q) => q.x))
  const sy = solve(A, dst.map((q) => q.y))
  return sx && sy ? [...sx, ...sy] : null
}

/** Ma trận đồng nhất từ n ≥ 4 cặp điểm (bình phương tối thiểu, có chuẩn hoá toạ độ cho ổn định số) */
export function homographyLS(src: Pt[], dst: Pt[]): number[] | null {
  if (src.length < 4) return null
  if (src.length === 4) return homography(src, dst)
  const norm = (ps: Pt[]) => {
    const mx = ps.reduce((s, p) => s + p.x, 0) / ps.length
    const my = ps.reduce((s, p) => s + p.y, 0) / ps.length
    const d = ps.reduce((s, p) => s + Math.hypot(p.x - mx, p.y - my), 0) / ps.length || 1
    const k = Math.SQRT2 / d
    return { k, mx, my, pts: ps.map((p) => ({ x: (p.x - mx) * k, y: (p.y - my) * k })) }
  }
  const S = norm(src),
    D = norm(dst)
  const AtA = Array.from({ length: 8 }, () => new Array(8).fill(0))
  const Atb = new Array(8).fill(0)
  const add = (row: number[], v: number) => {
    for (let i = 0; i < 8; i++) {
      Atb[i] += row[i] * v
      for (let j = 0; j < 8; j++) AtA[i][j] += row[i] * row[j]
    }
  }
  S.pts.forEach((p, i) => {
    const q = D.pts[i]
    add([p.x, p.y, 1, 0, 0, 0, -q.x * p.x, -q.x * p.y], q.x)
    add([0, 0, 0, p.x, p.y, 1, -q.y * p.x, -q.y * p.y], q.y)
  })
  const h = solve(AtA, Atb)
  if (!h) return null
  // H = Td^-1 · Hn · Ts
  const Hn = [...h, 1]
  const Ts = [S.k, 0, -S.k * S.mx, 0, S.k, -S.k * S.my, 0, 0, 1]
  const Tdi = [1 / D.k, 0, D.mx, 0, 1 / D.k, D.my, 0, 0, 1]
  const mul = (X: number[], Y: number[]) => {
    const R = new Array(9).fill(0)
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) R[i * 3 + j] += X[i * 3 + k] * Y[k * 3 + j]
    return R
  }
  const Hm = mul(Tdi, mul(Hn, Ts))
  return Hm.map((v) => v / Hm[8])
}

/**
 * Chọn bộ mốc khớp mẫu tốt nhất.
 * Phiếu có nhiều mốc (phiếu trường: 6 ô ■). Chỉ cần thấy 3 mốc góc bất kì + ít nhất 1 mốc nữa là định vị được —
 * mốc bị ngón tay che, dính vào đường kẻ khung, mờ… vẫn chấm được. Thử mọi cách gán 3 mốc ảnh cho 3 mốc góc,
 * dự đoán vị trí các mốc còn lại, rồi tính H bằng bình phương tối thiểu trên mọi mốc khớp.
 * Điểm chọn: độ rõ vòng tròn ô tô ở đúng chỗ (chính), số mốc khớp (phụ).
 */
function locateRobust(g: Gray, t: SheetTemplate, squareOnly = false): { H: number[]; quality: number } {
  // squareOnly: chỉ xét hình VUÔNG đặc (mốc ■), bỏ ô tròn đã tô — tròn đặc có tỉ số diện tích/phương sai ≈ 6,28, vuông ≈ 6,0
  const all = markerCandidates(g)
  const cands = squareOnly ? all.filter((c) => c.fill < 6.17) : all
  if (cands.length < 4) throw new OmrError('Không tìm thấy đủ các ô vuông đen định vị (■) trên ảnh.')
  const allMarks: Pt[] = [...t.corners, ...t.extraMarkers]
  const roleSets = [
    [0, 1, 2],
    [0, 1, 3],
    [0, 2, 3],
    [1, 2, 3],
  ]
  const probeRows = t.rows.filter((_, i) => i % 3 === 0).slice(0, 40)
  const longSide = Math.max(g.w, g.h)
  const n = cands.length
  const tried = new Set<string>()
  const hyps: { H: number[]; matched: number }[] = []

  for (const roles of roleSets) {
    const [P, Q, R] = roles.map((i) => t.corners[i])
    const tPQ = Math.hypot(Q.x - P.x, Q.y - P.y)
    const tPR = Math.hypot(R.x - P.x, R.y - P.y)
    for (let a = 0; a < n; a++)
      for (let b = 0; b < n; b++) {
        if (b === a) continue
        const A = cands[a],
          B = cands[b]
        const dAB = Math.hypot(B.x - A.x, B.y - A.y)
        if (dAB < longSide * 0.15) continue
        for (let c = 0; c < n; c++) {
          if (c === a || c === b) continue
          const C = cands[c]
          const dAC = Math.hypot(C.x - A.x, C.y - A.y)
          const rr = dAB / dAC / (tPQ / tPR)
          if (rr < 0.6 || rr > 1.65) continue
          const M = affine3([P, Q, R], [A, B, C])
          if (!M) continue
          const [ma, mb, , md, me] = M
          const det = ma * me - mb * md
          if (det <= 0) continue // ảnh lật gương -> sai
          const sx = Math.hypot(ma, md),
            sy = Math.hypot(mb, me)
          if (sx / sy < 0.6 || sx / sy > 1.65) continue
          if (Math.abs(ma * mb + md * me) / (sx * sy) > 0.35) continue // lệch góc quá nhiều
          const unit = Math.sqrt(det)
          const expSide = t.markerSize * unit
          // ghép các mốc còn lại theo dự đoán affine
          const src: Pt[] = [P, Q, R]
          const dst: Pt[] = [A, B, C]
          const used = new Set([a, b, c])
          // dung sai nhỏ: giấy cong lệch vài mm vẫn khớp, nhưng không "bắt nhầm" ô tô đậm gần đó
          const tol = Math.max(expSide * 1.6, 0.035 * Math.min(sx, sy) * 1000)
          const triSide = (A.side + B.side + C.side) / 3
          for (const m of allMarks) {
            if (m === P || m === Q || m === R) continue
            const px = M[0] * m.x + M[1] * m.y + M[2],
              py = M[3] * m.x + M[4] * m.y + M[5]
            let bi = -1,
              bd = Infinity
            for (let k = 0; k < n; k++) {
              if (used.has(k)) continue
              const e = Math.hypot(cands[k].x - px, cands[k].y - py)
              if (e < bd) {
                bd = e
                bi = k
              }
            }
            if (bi >= 0 && bd < tol && cands[bi].side > triSide * 0.65 && cands[bi].side < triSide * 1.5) {
              used.add(bi)
              src.push(m)
              dst.push(cands[bi])
            }
          }
          if (src.length < 4) continue
          const sides = [...used].map((k) => cands[k].side)
          const sMax = Math.max(...sides),
            sMin = Math.min(...sides)
          if (sMax > sMin * 1.9) continue
          const avgSide = sides.reduce((s2, v) => s2 + v, 0) / sides.length
          if (avgSide < expSide * 0.45 || avgSide > expSide * 2) continue
          // tính H; mốc nào lệch nhiều (ghép nhầm) thì bỏ rồi tính lại, miễn còn ≥ 4 mốc
          const errLim = Math.max(expSide * 1.5, longSide * 0.012)
          let H: number[] | null = null
          while (src.length >= 4) {
            H = homographyLS(src, dst)
            if (!H) break
            let wi = -1,
              we = 0
            src.forEach((p, i) => {
              const q = applyH(H!, p)
              const e = Math.hypot(q.x - dst[i].x, q.y - dst[i].y)
              if (e > we) {
                we = e
                wi = i
              }
            })
            if (we <= errLim) break
            if (wi < 3 || src.length === 4) {
              H = null // một trong 3 mốc gốc lệch -> bộ này sai
              break
            }
            src.splice(wi, 1)
            dst.splice(wi, 1)
          }
          if (!H) continue
          // cùng một cách ghép mốc có thể gặp lại qua bộ 3 khác -> bỏ trùng
          const key = src
            .map((p, i) => `${p.x},${p.y}>${Math.round(dst[i].x)},${Math.round(dst[i].y)}`)
            .sort()
            .join('|')
          if (tried.has(key)) continue
          tried.add(key)
          hyps.push({ H, matched: src.length })
        }
      }
  }
  if (!hyps.length)
    throw new OmrError(
      'Không xác định được khung phiếu: chưa thấy đủ các ô vuông đen ■ (cần ít nhất 4 ô, trong đó 3 ô ở góc). Hãy chụp thẳng, rõ, lọt trọn cả vùng trả lời trắc nghiệm.',
    )
  // chỉ chấm độ rõ vòng tròn cho các giả thuyết khớp nhiều mốc nhất (tiết kiệm thời gian)
  // Lọc nhanh bằng vài hàng ô, rồi chấm kĩ các giả thuyết tốt nhất trên nhiều hàng hơn
  const maxM = Math.max(...hyps.map((h) => h.matched))
  const quickRows = t.rows.filter((_, i) => i % 7 === 0).slice(0, 14)
  const pool = hyps
    .filter((h) => h.matched >= Math.max(4, maxM - 2))
    .sort((x, y) => y.matched - x.matched)
    .slice(0, 400)
    .map((h) => ({ ...h, q: ringEvidence(g, h.H, t, quickRows) + 0.02 * h.matched }))
    .sort((x, y) => y.q - x.q)
    .slice(0, 8)
  let best: { H: number[]; score: number } | null = null
  for (const h of pool) {
    const score = ringEvidence(g, h.H, t, probeRows) + 0.02 * h.matched
    if (!best || score > best.score) best = { H: h.H, score }
  }
  return { H: best!.H, quality: ringEvidence(g, best!.H, t, t.rows) }
}

/** Thu nhỏ ảnh xám (trung bình ô) */
function downscale(g: Gray, f: number): Gray {
  const W = Math.max(1, Math.round(g.w * f)),
    Hh = Math.max(1, Math.round(g.h * f))
  const out = new Float32Array(W * Hh)
  const inv = 1 / f
  for (let y = 0; y < Hh; y++) {
    const y0 = Math.floor(y * inv),
      y1 = Math.min(g.h, Math.max(y0 + 1, Math.floor((y + 1) * inv)))
    for (let x = 0; x < W; x++) {
      const x0 = Math.floor(x * inv),
        x1 = Math.min(g.w, Math.max(x0 + 1, Math.floor((x + 1) * inv)))
      let s = 0,
        c = 0
      for (let yy = y0; yy < y1; yy++)
        for (let xx = x0; xx < x1; xx++) {
          s += g.d[yy * g.w + xx]
          c++
        }
      out[y * W + x] = s / c
    }
  }
  return { w: W, h: Hh, d: out }
}

/** Đường nhanh: thấy đủ 4 mốc góc + mọi mốc phụ (ảnh chụp tốt — đa số trường hợp) */
function locateFast(g: Gray, t: SheetTemplate): { H: number[]; quality: number } {
  const cands = markerCandidates(g)
  if (cands.length < 4) throw new OmrError('Không tìm thấy đủ 4 ô vuông đen định vị (■) trên ảnh.')
  const [TL, TR, BL, BR] = t.corners
  const tw = Math.hypot(TR.x - TL.x, TR.y - TL.y)
  const th = Math.hypot(BL.x - TL.x, BL.y - TL.y)
  const ratio = tw / th
  // vài hàng ô mẫu để kiểm tra (ô trống phải có vòng tròn)
  const probeRows = t.rows.filter((_, i) => i % 3 === 0).slice(0, 40)
  let best: { H: number[]; score: number; quality: number } | null = null
  const n = cands.length
  for (let a = 0; a < n; a++)
    for (let b = 0; b < n; b++) {
      if (b === a) continue
      const A = cands[a],
        B = cands[b]
      const dAB = Math.hypot(B.x - A.x, B.y - A.y)
      if (dAB < Math.max(g.w, g.h) * 0.2) continue
      for (let c = 0; c < n; c++) {
        if (c === a || c === b) continue
        const C = cands[c]
        const dAC = Math.hypot(C.x - A.x, C.y - A.y)
        const r = dAB / dAC
        if (r < ratio * 0.7 || r > ratio * 1.4) continue
        // AB ⟂ AC (gần vuông góc) và chiều quay đúng (B ở "bên phải" của A khi nhìn theo AC xuống)
        const cos = ((B.x - A.x) * (C.x - A.x) + (B.y - A.y) * (C.y - A.y)) / (dAB * dAC)
        if (Math.abs(cos) > 0.35) continue
        const cross = (B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x)
        if (cross <= 0) continue
        const pred = { x: B.x + C.x - A.x, y: B.y + C.y - A.y }
        let D: Cand | null = null
        let dd = Infinity
        for (let k = 0; k < n; k++) {
          if (k === a || k === b || k === c) continue
          const e = Math.hypot(cands[k].x - pred.x, cands[k].y - pred.y)
          if (e < dd) {
            dd = e
            D = cands[k]
          }
        }
        if (!D || dd > 0.25 * Math.min(dAB, dAC)) continue
        const sides = [A.side, B.side, C.side, D.side]
        const sMax = Math.max(...sides),
          sMin = Math.min(...sides)
        if (sMax > sMin * 1.8) continue
        const H = homography([TL, TR, BL, BR], [A, B, C, D])
        if (!H) continue
        // kích thước mốc phải khớp mẫu
        const unit = dAB / tw
        const expSide = t.markerSize * unit
        const avgSide = sides.reduce((s, v) => s + v, 0) / 4
        if (avgSide < expSide * 0.5 || avgSide > expSide * 1.9) continue
        let score = 0
        let missing = 0
        // mốc phụ: phải có đủ (xác định đúng phiếu, đúng chiều)
        for (const m of t.extraMarkers) if (!markerAt(g, H, m, t.markerSize)) missing++
        if (missing) continue
        // vòng tròn ô tô
        const ring = ringEvidence(g, H, t, probeRows)
        score += ring * 10
        if (!best || score > best.score) best = { H, score, quality: ring }
      }
    }
  if (!best) throw new OmrError('Không xác định được khung phiếu: chưa thấy đủ các ô vuông đen ■ đúng vị trí. Hãy chụp thẳng, rõ, lọt trọn cả tờ phiếu (đủ 4 góc).')
  // kiểm tra lại trên toàn bộ ô của mẫu
  best.quality = ringEvidence(g, best.H, t, t.rows)
  return { H: best.H, quality: best.quality }
}

/**
 * Định vị phiếu, theo thứ tự:
 *  1. Đường nhanh (đủ 4 mốc góc + mốc phụ) — ảnh chụp tốt.
 *  2. Đường bền: chỉ cần 3 mốc góc + 1 mốc bất kì (mốc bị che, dính đường kẻ, mờ).
 *  3. Lặp lại ở độ phân giải thấp hơn (ảnh lớn đôi khi làm mốc ■ vỡ nét / dính chữ bên cạnh).
 * Lấy kết quả có vòng tròn ô tô hiện rõ nhất; đổi H về toạ độ ảnh gốc.
 */
function locateMulti(g: Gray, t: SheetTemplate): { H: number[]; quality: number } {
  const OK = 0.9
  let best: { H: number[]; quality: number } | null = null
  let firstErr: Error | null = null
  const consider = (r: { H: number[]; quality: number }, f: number) => {
    const H = f === 1 ? r.H : r.H.map((v, i) => (i < 6 ? v / f : v))
    if (!best || r.quality > best.quality) best = { H, quality: r.quality }
  }
  const attempt = (fn: (x: Gray, tt: SheetTemplate) => { H: number[]; quality: number }, img: Gray, f: number) => {
    try {
      consider(fn(img, t), f)
    } catch (e) {
      if (!firstErr) firstErr = e as Error
    }
    return !!best && (best as { quality: number }).quality >= OK
  }
  if (attempt(locateFast, g, 1)) return best!
  const robustSq = (x: Gray, tt: SheetTemplate) => locateRobust(x, tt, true)
  if (attempt(robustSq, g, 1)) return best!
  if (attempt(locateRobust, g, 1)) return best!
  const long = Math.max(g.w, g.h)
  for (const side of [1400, 1000]) {
    if (side >= long * 0.85) continue
    const f = side / long
    const small = downscale(g, f)
    if (attempt(locateFast, small, f)) return best!
    if (attempt(robustSq, small, f)) return best!
    if (attempt(locateRobust, small, f)) return best!
  }
  if (best && (best as { quality: number }).quality >= 0.8) return best
  if (best)
    throw new OmrError('Ảnh không khớp mẫu phiếu đã chọn (không thấy rõ các ô tròn ở vị trí cần). Kiểm tra lại loại phiếu, hoặc chụp lại gần hơn, thẳng hơn, đủ sáng.')
  throw firstErr || new OmrError('Không định vị được phiếu.')
}

// ---------------- PHIẾU KHÔNG CÓ MỐC ■: TÌM LƯỚI Ô TRÒN ----------------

interface Dot extends Pt {
  size: number
  fill: number
}

/** Các ô tròn (rỗng có chữ A/B/C/D bên trong, hoặc đã tô đặc) cùng cỡ phổ biến nhất trên ảnh */
function bubbleCandidates(g: Gray): { dots: Dot[]; size: number } {
  const long = Math.max(g.w, g.h)
  const win = Math.max(15, Math.round(long / 40)) | 1
  const bin = adaptiveBinarize(g, win, 12)
  const all: Dot[] = []
  for (const b of components(bin, g.w, g.h, Math.round(long * 0.045))) {
    const bw = b.x1 - b.x0 + 1,
      bh = b.y1 - b.y0 + 1
    if (bw < long * 0.006 || bh < long * 0.006) continue
    if (bw / bh < 0.75 || bw / bh > 1.33) continue
    const fill = b.area / (bw * bh)
    if (fill < 0.15) continue
    all.push({ x: b.cx, y: b.cy, size: (bw + bh) / 2, fill })
  }
  // cỡ ô = cỡ phổ biến nhất của các VÒNG RỖNG (chữ in đậm, số thứ tự không phải vòng rỗng)
  const bins = new Map<number, number>()
  for (const d of all)
    if (d.fill < 0.5) {
      const k = Math.round(d.size / 1.5)
      bins.set(k, (bins.get(k) || 0) + 1)
    }
  let bestK = -1,
    bestN = 0
  for (const [k] of bins) {
    const n = (bins.get(k - 1) || 0) + (bins.get(k) || 0) + (bins.get(k + 1) || 0)
    if (n > bestN) {
      bestN = n
      bestK = k
    }
  }
  if (bestK < 0) return { dots: [], size: 0 }
  const size = bestK * 1.5
  return { dots: all.filter((d) => Math.abs(d.size - size) < size * 0.3), size }
}

/**
 * Định vị phiếu 'grid':
 *  1. Tìm các ô tròn cùng cỡ; ước lượng 2 véc-tơ lưới (ô kế bên h, hàng kế dưới v) từ láng giềng gần nhất.
 *  2. Đổi toạ độ ảnh -> toạ độ lưới; thử mọi ô làm "ô gốc" + khoảng cách nhóm cột, chọn cách khớp nhiều ô nhất.
 *  3. Tính H (bình phương tối thiểu) từ các cặp khớp, chiếu lại, ghép lại theo khoảng cách điểm ảnh, lặp 3 lần.
 */
function locateGrid(g: Gray, t: SheetTemplate): { H: number[]; quality: number } {
  const spec = t.gridSpec!
  const { dots, size } = bubbleCandidates(g)
  if (dots.length < 12) throw new OmrError('Không tìm thấy lưới ô tròn trên ảnh. Hãy chụp thẳng, rõ, lọt trọn phần trắc nghiệm.')
  // 1. véc-tơ lưới
  const hs: Pt[] = [],
    vs: Pt[] = []
  for (let i = 0; i < dots.length; i++) {
    const near = dots
      .map((d, j) => ({ j, dd: Math.hypot(d.x - dots[i].x, d.y - dots[i].y) }))
      .filter((o) => o.j !== i && o.dd < size * 3.2)
      .sort((a, b) => a.dd - b.dd)
      .slice(0, 4)
    for (const o of near) {
      let vx = dots[o.j].x - dots[i].x,
        vy = dots[o.j].y - dots[i].y
      if (Math.abs(vx) > Math.abs(vy)) {
        if (vx < 0) {
          vx = -vx
          vy = -vy
        }
        hs.push({ x: vx, y: vy })
      } else {
        if (vy < 0) {
          vx = -vx
          vy = -vy
        }
        vs.push({ x: vx, y: vy })
      }
    }
  }
  if (hs.length < 6 || vs.length < 6) throw new OmrError('Không nhận ra lưới ô tròn (quá ít ô). Hãy chụp gần hơn, rõ hơn.')
  const medv = (a: number[]) => {
    const s2 = [...a].sort((x, y) => x - y)
    return s2[Math.floor(s2.length / 2)]
  }
  // chỉ lấy các véc-tơ ngắn nhất (ô kề nhau), bỏ bước nhảy qua khoảng trống
  const hLen = medv(hs.map((p) => Math.hypot(p.x, p.y)))
  const vLen = medv(vs.map((p) => Math.hypot(p.x, p.y)))
  const hk = hs.filter((p) => Math.hypot(p.x, p.y) < hLen * 1.3)
  const vk = vs.filter((p) => Math.hypot(p.x, p.y) < vLen * 1.3)
  const h = { x: medv(hk.map((p) => p.x)), y: medv(hk.map((p) => p.y)) }
  const v = { x: medv(vk.map((p) => p.x)), y: medv(vk.map((p) => p.y)) }
  const det = h.x * v.y - h.y * v.x
  if (Math.abs(det) < 1e-6) throw new OmrError('Không nhận ra lưới ô tròn.')
  const toUV = (p: Pt) => ({ x: (v.y * p.x - v.x * p.y) / det, y: (-h.y * p.x + h.x * p.y) / det })
  const uv = dots.map(toUV)
  // bảng băm dạng mảng theo ô 0,5 đơn vị lưới (nhanh hơn Map chuỗi ~20 lần)
  let mnx = Infinity,
    mny = Infinity,
    mxx = -Infinity,
    mxy = -Infinity
  for (const p of uv) {
    mnx = Math.min(mnx, p.x)
    mny = Math.min(mny, p.y)
    mxx = Math.max(mxx, p.x)
    mxy = Math.max(mxy, p.y)
  }
  const CW = Math.floor((mxx - mnx) * 2) + 1,
    CH = Math.floor((mxy - mny) * 2) + 1
  if (CW * CH > 4e6) throw new OmrError('Không nhận ra lưới ô tròn.')
  const cellOf = (x: number, y: number) => Math.floor((x - mnx) * 2) + Math.floor((y - mny) * 2) * CW
  const cnt = new Int32Array(CW * CH + 1)
  uv.forEach((p) => cnt[cellOf(p.x, p.y) + 1]++)
  for (let i = 1; i <= CW * CH; i++) cnt[i] += cnt[i - 1]
  const fillPos = cnt.slice(0, CW * CH)
  const items = new Int32Array(uv.length)
  uv.forEach((p, i) => (items[fillPos[cellOf(p.x, p.y)]++] = i))
  const nearest = (x: number, y: number, tol: number) => {
    let bi = -1,
      bd = tol
    const cx = Math.floor((x - mnx) * 2),
      cy = Math.floor((y - mny) * 2)
    for (let dy = -1; dy <= 1; dy++) {
      const yy = cy + dy
      if (yy < 0 || yy >= CH) continue
      for (let dx = -1; dx <= 1; dx++) {
        const xx = cx + dx
        if (xx < 0 || xx >= CW) continue
        const c = xx + yy * CW
        for (let k = cnt[c]; k < cnt[c + 1]; k++) {
          const i = items[k]
          const d = Math.hypot(uv[i].x - x, uv[i].y - y)
          if (d < bd) {
            bd = d
            bi = i
          }
        }
      }
    }
    return bi
  }
  // toạ độ lưới của từng ô mẫu theo khoảng cách nhóm G: (cột trong nhóm + nhóm·G, hàng)
  const unit = spec.unit
  const all = t.rows.flatMap((r) => r.opts)
  const G0 = spec.groupGap
  const parts = all.map((o) => {
    const xu = o.x / unit
    const gi = Math.floor(xu / G0 + 1e-6)
    return { gi, oi: xu - gi * G0, row: o.y / (unit * spec.rowStep) }
  })
  const lat = (G: number) => parts.map((p) => ({ x: p.gi * G + p.oi, y: p.row }))
  const anchorsTmpl = [0, 1, 2, 3, 4, 5, 6, 7].filter((k) => k < all.length)
  let best: { m: number; G: number; ai: number; k: number } | null = null
  const tryG = (G: number) => {
    const L = lat(G)
    for (let ai = 0; ai < uv.length; ai++)
      for (const k of anchorsTmpl) {
        const ox = uv[ai].x - L[k].x,
          oy = uv[ai].y - L[k].y
        let m = 0,
          left = L.length
        const need = best ? best.m : 0
        for (const p of L) {
          if (nearest(p.x + ox, p.y + oy, 0.3) >= 0) m++
          left--
          if (m + left <= need) break // không thể vượt cách khớp tốt nhất -> bỏ sớm
        }
        if (!best || m > best.m) best = { m, G, ai, k }
      }
  }
  for (let G = spec.groupGap - 0.5; G <= spec.groupGap + 0.5 + 1e-9; G += 0.05) tryG(G)
  const g0 = best!.G
  for (let G = g0 - 0.04; G <= g0 + 0.04 + 1e-9; G += 0.01) tryG(G)
  const b = best!
  if (b.m < all.length * 0.4) throw new OmrError('Ảnh không khớp mẫu phiếu đã chọn (không thấy đủ lưới ô tròn). Kiểm tra lại loại phiếu hoặc chụp lại.')
  // 2. cặp khớp ban đầu
  const L = lat(b.G)
  const ox = uv[b.ai].x - L[b.k].x,
    oy = uv[b.ai].y - L[b.k].y
  let src: Pt[] = [],
    dst: Pt[] = []
  L.forEach((p, i) => {
    const j = nearest(p.x + ox, p.y + oy, 0.3)
    if (j >= 0) {
      src.push(all[i])
      dst.push(dots[j])
    }
  })
  // 3. tinh chỉnh bằng phép chiếu phối cảnh
  let H = homographyLS(src, dst)
  if (!H) throw new OmrError('Không định vị được lưới ô tròn.')
  const step = Math.hypot(h.x, h.y)
  for (let it = 0; it < 3; it++) {
    src = []
    dst = []
    const used = new Set<number>()
    for (const o of all) {
      const q = applyH(H, o)
      let bi = -1,
        bd = step * 0.35
      dots.forEach((d, j) => {
        const dd = Math.hypot(d.x - q.x, d.y - q.y)
        if (dd < bd && !used.has(j)) {
          bd = dd
          bi = j
        }
      })
      if (bi >= 0) {
        used.add(bi)
        src.push(o)
        dst.push(dots[bi])
      }
    }
    const H2 = homographyLS(src, dst)
    if (!H2) break
    H = H2
  }
  return { H, quality: src.length / all.length }
}

function locateGridMulti(g: Gray, t: SheetTemplate): { H: number[]; quality: number } {
  let best: { H: number[]; quality: number } | null = null
  let firstErr: Error | null = null
  const long = Math.max(g.w, g.h)
  const tries: number[] = [1, ...[1600, 1100].filter((s2) => s2 < long * 0.85).map((s2) => s2 / long)]
  for (const f of tries) {
    try {
      const r = locateGrid(f === 1 ? g : downscale(g, f), t)
      const H = f === 1 ? r.H : r.H.map((v, i) => (i < 6 ? v / f : v))
      if (!best || r.quality > best.quality) best = { H, quality: r.quality }
      if (r.quality >= 0.85) break
    } catch (e) {
      if (!firstErr) firstErr = e as Error
    }
  }
  // phiếu đúng loại: gần như mọi ô của lưới đều khớp (ảnh thật ≥ 0,97). Phiếu khác loại có lưới ô gần giống
  // (VD phiếu trường 40 câu) chỉ khớp được ~0,8 -> từ chối, không đọc bừa.
  if (best && best.quality >= 0.93) return best
  if (best)
    throw new OmrError(
      'Ảnh không khớp mẫu phiếu 35 câu (lưới ô tròn không đúng 4 cột 10 – 10 – 10 – 5 câu, hoặc bị che / mờ một phần). Kiểm tra lại loại phiếu, hoặc chụp lại thẳng, rõ, lọt trọn phần trắc nghiệm.',
    )
  throw firstErr || new OmrError('Không định vị được phiếu.')
}

/** Đọc dãy bit: ô vuông nhỏ đặc = 1, rỗng = 0 (so độ sáng lòng ô với nền quanh) */
function readCode(g: Gray, H: number[], bits: Pt[], size: number): number {
  let v = 0
  const lum = (x: number, y: number) => {
    const p = applyH(H, { x, y })
    return sampleGray(g, p.x, p.y)
  }
  bits.forEach((b, i) => {
    let inside = 0,
      n = 0
    for (let dy = -size * 0.22; dy <= size * 0.22 + 1e-9; dy += size * 0.11)
      for (let dx = -size * 0.22; dx <= size * 0.22 + 1e-9; dx += size * 0.11) {
        inside += lum(b.x + dx, b.y + dy)
        n++
      }
    inside /= n
    const out = (lum(b.x, b.y - size * 1.1) + lum(b.x, b.y + size * 1.1)) / 2
    if (inside < out * 0.6) v |= 1 << i
  })
  return v
}

/** Có ô vuông đen tại toạ độ mẫu m? (lòng đậm, xung quanh sáng; cho phép lệch nửa cạnh) */
function markerAt(g: Gray, H: number[], m: Pt, side: number): boolean {
  const avg = (cx: number, cy: number, half: number) => {
    let s = 0,
      n = 0
    for (let dy = -half; dy <= half + 1e-9; dy += half / 3)
      for (let dx = -half; dx <= half + 1e-9; dx += half / 3) {
        const p = applyH(H, { x: cx + dx, y: cy + dy })
        s += sampleGray(g, p.x, p.y)
        n++
      }
    return s / n
  }
  let best = 255
  for (let dy = -side * 0.5; dy <= side * 0.5 + 1e-9; dy += side / 4)
    for (let dx = -side * 0.5; dx <= side * 0.5 + 1e-9; dx += side / 4) best = Math.min(best, avg(m.x + dx, m.y + dy, side * 0.3))
  // nền: trung vị vòng ngoài
  const ring: number[] = []
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2
    const p = applyH(H, { x: m.x + Math.cos(a) * side * 1.6, y: m.y + Math.sin(a) * side * 1.6 })
    ring.push(sampleGray(g, p.x, p.y))
  }
  ring.sort((a, b) => a - b)
  const bg = ring[8]
  return bg - best > 60 && best < bg * 0.6
}

/** Tỉ lệ ô (trong các hàng thử) có viền tròn/đậm rõ ở đúng chỗ, cho phép lệch nhỏ */
function ringEvidence(g: Gray, H: number[], t: SheetTemplate, rows: BubbleRow[]): number {
  let ok = 0,
    tot = 0
  for (const row of rows) {
    const R = row.r ?? t.bubbleR
    for (const o of row.opts) {
      tot++
      let bestv = 0
      for (let dy = -R * 0.6; dy <= R * 0.6; dy += R * 0.3)
        for (let dx = -R * 0.6; dx <= R * 0.6; dx += R * 0.3) {
          const v = ringContrast(g, H, o.x + dx, o.y + dy, R)
          if (v > bestv) bestv = v
        }
      if (bestv > 18) ok++
    }
  }
  return tot ? ok / tot : 0
}

/** Độ tối trên vòng bán kính R trừ độ tối ở vòng ngoài 1.55R (đơn vị mức xám) */
function ringContrast(g: Gray, H: number[], cx: number, cy: number, R: number): number {
  let on = 0,
    off = 0
  const N = 16
  for (let k = 0; k < N; k++) {
    const a = (k / N) * Math.PI * 2
    const c = Math.cos(a),
      s = Math.sin(a)
    let p = applyH(H, { x: cx + c * R, y: cy + s * R })
    on += sampleGray(g, p.x, p.y)
    p = applyH(H, { x: cx + c * R * 1.55, y: cy + s * R * 1.55 })
    off += sampleGray(g, p.x, p.y)
  }
  return (off - on) / N
}

// ---------------- ĐO ĐỘ ĐẬM TỪNG Ô ----------------

/** Ảnh nắn phẳng của một khối + hàm đổi toạ độ */
interface Patch {
  img: Gray
  x0: number
  y0: number
  scale: number
}

function patchFor(g: Gray, H: number[], rows: BubbleRow[], R: number, scale: number): Patch {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity
  for (const r of rows)
    for (const o of r.opts) {
      x0 = Math.min(x0, o.x)
      y0 = Math.min(y0, o.y)
      x1 = Math.max(x1, o.x)
      y1 = Math.max(y1, o.y)
    }
  const m = R * 3.2
  x0 -= m
  y0 -= m
  x1 += m
  y1 += m
  return { img: warp(g, H, x0, y0, x1 - x0, y1 - y0, scale), x0, y0, scale }
}

function pv(p: Patch, x: number, y: number): number {
  return sampleGray(p.img, (x - p.x0) * p.scale - 0.5, (y - p.y0) * p.scale - 0.5)
}

/** Độ tương phản "vòng tròn" tại tâm (cx,cy) trên patch */
function ringOnPatch(p: Patch, cx: number, cy: number, R: number): number {
  let on = 0,
    off = 0,
    inside = 0
  const N = 20
  for (let k = 0; k < N; k++) {
    const a = (k / N) * Math.PI * 2
    const c = Math.cos(a),
      s = Math.sin(a)
    on += pv(p, cx + c * R, cy + s * R)
    off += pv(p, cx + c * R * 1.5, cy + s * R * 1.5)
    inside += pv(p, cx + c * R * 0.45, cy + s * R * 0.45)
  }
  // ô trống: viền tối hơn ngoài; ô tô: lòng + viền tối hơn ngoài -> cả hai đều cho giá trị dương
  return (off - on) / N + Math.max(0, (off - inside) / N) * 0.5
}

/**
 * Dò lại tâm ô thật trong khối: tìm độ lệch tốt nhất cho từng ô rồi khớp phép affine
 * (bền với ngoại lai) cho cả khối — giấy cong / in lệch vài mm vẫn bám đúng.
 */
function refineBlock(p: Patch, rows: BubbleRow[], R: number, spacing: number): (row: BubbleRow, i: number) => Pt {
  const lim = Math.min(spacing * 0.45, R * 1.4)
  const st = Math.max(0.5, R / 10)
  const samples: { x: number; y: number; dx: number; dy: number; v: number }[] = []
  for (const r of rows)
    for (const o of r.opts) {
      let bv = -Infinity,
        bx = 0,
        by = 0
      for (let dy = -lim; dy <= lim; dy += st)
        for (let dx = -lim; dx <= lim; dx += st) {
          const v = ringOnPatch(p, o.x + dx, o.y + dy, R)
          if (v > bv) {
            bv = v
            bx = dx
            by = dy
          }
        }
      samples.push({ x: o.x, y: o.y, dx: bx, dy: by, v: bv })
    }
  // bỏ ô có tín hiệu yếu, rồi bỏ ngoại lai so với trung vị
  const strong = samples.filter((s) => s.v > 12)
  const use0 = strong.length >= 3 ? strong : samples
  const med = (a: number[]) => {
    const s = [...a].sort((x, y) => x - y)
    return s.length ? s[Math.floor(s.length / 2)] : 0
  }
  const mdx = med(use0.map((s) => s.dx)),
    mdy = med(use0.map((s) => s.dy))
  const use = use0.filter((s) => Math.hypot(s.dx - mdx, s.dy - mdy) < R * 0.7)
  // khớp dx = a + b x + c y (và dy tương tự); ít điểm thì chỉ tịnh tiến
  let fx = (_x: number, _y: number) => mdx
  let fy = (_x: number, _y: number) => mdy
  if (use.length >= 6) {
    const cx = use.reduce((s, u) => s + u.x, 0) / use.length
    const cy = use.reduce((s, u) => s + u.y, 0) / use.length
    const fit = (key: 'dx' | 'dy') => {
      let sxx = 0,
        sxy = 0,
        syy = 0,
        sxv = 0,
        syv = 0,
        sv = 0
      for (const u of use) {
        const X = u.x - cx,
          Y = u.y - cy,
          V = u[key]
        sxx += X * X
        sxy += X * Y
        syy += Y * Y
        sxv += X * V
        syv += Y * V
        sv += V
      }
      const det = sxx * syy - sxy * sxy
      const a0 = sv / use.length
      if (Math.abs(det) < 1e-6) return (_x: number, _y: number) => a0
      const b = (sxv * syy - syv * sxy) / det
      const c = (syv * sxx - sxv * sxy) / det
      return (x: number, y: number) => a0 + b * (x - cx) + c * (y - cy)
    }
    fx = fit('dx')
    fy = fit('dy')
  }
  return (row, i) => {
    const o = row.opts[i]
    return { x: o.x + fx(o.x, o.y), y: o.y + fy(o.x, o.y) }
  }
}

/**
 * Độ đậm lòng ô: trung bình (1 - sáng/nền) trong hình tròn bán kính 0.62R.
 * Nền giấy = phân vị 90% độ sáng trong vùng quanh ô (tự thích nghi bóng đổ, ánh sáng lệch).
 */
function fillScore(p: Patch, c: Pt, R: number): number {
  const ring: number[] = []
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2
    ring.push(pv(p, c.x + Math.cos(a) * R * 1.9, c.y + Math.sin(a) * R * 1.9))
  }
  ring.sort((a, b) => a - b)
  const paper = Math.max(60, ring[Math.floor(ring.length * 0.85)])
  let sum = 0,
    n = 0
  const rr = R * 0.62
  const st = rr / 4
  for (let dy = -rr; dy <= rr + 1e-9; dy += st)
    for (let dx = -rr; dx <= rr + 1e-9; dx += st) {
      if (dx * dx + dy * dy > rr * rr) continue
      const v = pv(p, c.x + dx, c.y + dy)
      sum += Math.max(0, Math.min(1, 1 - v / paper))
      n++
    }
  return n ? sum / n : 0
}

/**
 * Độ phủ lòng ô cho phiếu có CHỮ IN TRONG Ô (Ⓐ Ⓑ Ⓒ Ⓓ, không có ô vuông đen).
 * Ô trống: nét chữ in sẫm nhưng phần sáng nhất của lòng ô vẫn là màu giấy.
 * Ô tô (kể cả bút chì nhạt, bị loá): phần sáng nhất của lòng ô cũng đã sẫm hơn giấy.
 * -> dùng mức sáng ở phân vị 85% trong hình tròn 0,72R (bỏ qua nét chữ in); nền giấy đo sát ngoài viền (1,4R). Có thể âm (lòng ô sáng hơn nền quanh ô).
 */
function coverScore(p: Patch, c: Pt, R: number): number {
  const ring: number[] = []
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2
    ring.push(pv(p, c.x + Math.cos(a) * R * 1.4, c.y + Math.sin(a) * R * 1.4))
  }
  ring.sort((a, b) => a - b)
  const paper = Math.max(60, ring[Math.floor(ring.length * 0.85)])
  const vals: number[] = []
  const rr = R * 0.72
  const st = rr / 6
  for (let dy = -rr; dy <= rr + 1e-9; dy += st)
    for (let dx = -rr; dx <= rr + 1e-9; dx += st) {
      if (dx * dx + dy * dy > rr * rr) continue
      vals.push(pv(p, c.x + dx, c.y + dy))
    }
  if (!vals.length) return 0
  vals.sort((a, b) => a - b)
  return 1 - vals[Math.floor(vals.length * 0.85)] / paper
}

// ---------------- ĐỌC CẢ PHIẾU ----------------

export interface ReadBubblesOptions {
  n1: number
  n2: number
}

export function readBubbles(g: Gray, t: SheetTemplate, opt: ReadBubblesOptions): BubbleRead {
  const { H, quality } = t.kind === 'grid' ? locateGridMulti(g, t) : locateMulti(g, t)
  if (t.code) {
    const v = readCode(g, H, t.code.bits, t.code.size)
    if (v === 0)
      throw new OmrError(
        'Ảnh này không có dãy ô mã của phiếu lớp (do web in) — có thể là PHIẾU CỦA TRƯỜNG. Nếu đúng vậy, bấm "Đổi sang phiếu của trường" ở đầu trang rồi bấm Đọc lại.',
      )
    if (v !== t.code.value)
      throw new OmrError(
        `Phiếu này in cho ${t.code.describe(v)}, không khớp đợt chấm (${t.code.describe(t.code.value)}). Hãy dùng đúng mẫu phiếu tải từ đợt chấm này.`,
      )
  }
  const R0 = t.bubbleR
  // tỉ lệ nắn: ~12 px cho mỗi bán kính ô, nhưng không vượt độ phân giải ảnh gốc quá 1.5 lần
  const [TL, TR] = t.corners
  const q0 = applyH(H, TL),
    q1 = applyH(H, TR)
  const pxPerUnit = Math.hypot(q1.x - q0.x, q1.y - q0.y) / Math.hypot(TR.x - TL.x, TR.y - TL.y)
  const scale = t.kind === 'grid' ? pxPerUnit : Math.min(12 / Math.min(R0, ...t.rows.map((r) => r.r ?? R0)), pxPerUnit * 1.5)

  const used = t.rows.filter((r) => (r.part === 1 ? r.q <= opt.n1 : r.q <= opt.n2))
  const blocks = new Map<string, BubbleRow[]>()
  for (const r of t.rows) {
    if (!blocks.has(r.block)) blocks.set(r.block, [])
    blocks.get(r.block)!.push(r)
  }

  type Det = BubbleRead['detail'][number]
  const detail: Det[] = []
  for (const [, rows] of blocks) {
    const mine = rows.filter((r) => used.includes(r))
    if (!mine.length) continue
    const R = rows[0].r ?? R0
    const patch = patchFor(g, H, rows, R, scale)
    const sp = spacingOf(rows)
    // căn chỉnh dùng cả khối (kể cả câu không dùng) để có nhiều điểm tựa
    const pos = refineBlock(patch, rows, R, sp)
    for (const row of mine) {
      const centers = row.opts.map((_, i) => pos(row, i))
      const scores = centers.map((c) => (t.kind === 'grid' ? coverScore(patch, c, R) : fillScore(patch, c, R)))
      const rings = centers.map((c) => ringOnPatch(patch, c.x, c.y, R))
      detail.push({ row, centers, scores, rings, chosen: null, flagged: false })
    }
  }

  if (t.kind === 'grid') return decideGrid(detail, opt, H, quality)

  // Bù mức mực in sẵn trong từng loại ô: ô có chữ in bên trong (Ⓐ Ⓑ Ⓒ Ⓓ) — chữ B nhiều nét hơn A, C, D nên ô B trống
  // vẫn hơi sẫm. Mức nền của từng phương án = phân vị 25% điểm của phương án đó qua các câu Phần I (đa số là ô trống).
  const p1d = detail.filter((d) => d.row.part === 1)
  if (p1d.length >= 8) {
    const nOpt = Math.max(...p1d.map((d) => d.scores.length))
    const optBase: number[] = []
    for (let i = 0; i < nOpt; i++) {
      const v = p1d
        .map((d) => d.scores[i])
        .filter((x) => x !== undefined)
        .sort((a, b) => a - b)
      optBase.push(v[Math.floor(v.length * 0.25)])
    }
    const common = Math.min(...optBase)
    for (const d of p1d) d.scores = d.scores.map((v, i) => Math.max(0, v - (optBase[i] - common)))
  }

  // Ngưỡng thích nghi theo cả phiếu: mức mực = trung vị các ô tô rõ
  const all = detail.flatMap((d) => d.scores)
  const marked = all.filter((v) => v >= 0.3).sort((a, b) => a - b)
  const inkLevel = marked.length ? marked[Math.floor(marked.length / 2)] : 0.6
  const hiGlobal = Math.max(0.24, Math.min(0.42, inkLevel * 0.5))

  // Mức "ô trống" theo VÙNG: ảnh chụp dưới đèn, bóng tay, góc tối, nhoè làm ô trống ở vùng đó hơi sẫm.
  // Lấy các ô không phải ô đậm nhất của mỗi hàng (gần như chắc là ô trống) ở ~12 hàng gần nhất -> trung vị + độ phân tán.
  const rowPos = detail.map((d) => {
    const n = d.row.opts.length
    return { x: d.row.opts.reduce((t, o) => t + o.x, 0) / n, y: d.row.opts.reduce((t, o) => t + o.y, 0) / n }
  })
  const rowEmpties = detail.map((d) => {
    const mx = Math.max(...d.scores)
    let skipped = false
    return d.scores.filter((v) => (!skipped && v === mx ? ((skipped = true), false) : true))
  })
  const med = (a: number[]) => {
    const t = [...a].sort((x, y) => x - y)
    return t.length ? t[Math.floor(t.length / 2)] : 0
  }
  const baseOf = detail.map((_, k) => {
    const near = detail
      .map((__, j) => ({ j, dist: Math.hypot(rowPos[j].x - rowPos[k].x, rowPos[j].y - rowPos[k].y) }))
      .sort((p, q) => p.dist - q.dist)
      .slice(0, 12)
    const vals = near.flatMap((n) => rowEmpties[n.j])
    const b = med(vals)
    const spread = Math.max(0.015, med(vals.map((v) => Math.abs(v - b))) * 1.4826)
    return { b, spread }
  })
  const lo0 = 0.13
  const emptyMed = med(rowEmpties.flat())

  // Mức tô CỦA CHÍNH PHIẾU NÀY: học sinh tô bút chì nhạt thì ô tô chỉ sẫm ~0,12–0,25 (bút mực ~0,6–0,9).
  // Lấy trung vị độ chênh (ô đậm nhất − mức ô trống) của các hàng có ô tô rõ hơn hẳn nhiễu
  // -> ngưỡng "tô rõ" tỉ lệ theo mức tô của học sinh, không dùng một ngưỡng cố định cho mọi phiếu.
  const rowRise = detail.map((d, k) => {
    const mx = Math.max(...d.scores)
    const mn = Math.min(...d.scores)
    return mx - Math.min(baseOf[k].b, mn)
  })
  const clearRises = rowRise.filter((r, k) => r >= Math.max(0.07, 6 * Math.min(0.05, baseOf[k].spread))).sort((a, b) => a - b)
  // phân vị 25%: phiếu vừa tô bút mực vừa tô bút chì thì lấy theo mức bút chì
  const sheetRise = clearRises.length >= 3 ? clearRises[Math.floor(clearRises.length * 0.25)] : 0.5

  // Độ rõ viền ô trống ở vị trí đã dò (căn đúng: viền rõ; lệch hàng/cột: gần như mất viền)
  const emptyRings = detail
    .flatMap((d, k) => d.scores.map((v, i) => (v < Math.max(lo0, baseOf[k].b + 0.07) ? d.rings[i] : NaN)))
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b)
  const ringRef = emptyRings.length ? emptyRings[Math.floor(emptyRings.length / 2)] : 0

  const p1: (string | null)[] = Array.from({ length: opt.n1 }, () => null)
  const p2: (boolean | null)[][] = Array.from({ length: opt.n2 }, () => [null, null, null, null])
  const flags: Record<string, string> = {}
  const LET = ['A', 'B', 'C', 'D']
  detail.forEach((d, k) => {
    const { row, scores } = d
    const name = (i: number) => (row.part === 1 ? LET[i] : i === 0 ? 'Đúng' : 'Sai')
    const order = scores.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v)
    const top = order[0],
      second = order[1]
    const rowMin = order[order.length - 1].v
    // mức ô trống: lấy thấp hơn giữa mức vùng và ô nhạt nhất của chính hàng (vùng có thể lẫn chỗ tối/sáng khác nhau)
    const base = Math.min(baseOf[k].b, rowMin)
    const spread = Math.min(0.05, baseOf[k].spread)
    // Quyết định dựa trên ĐỘ CHÊNH: ô được chọn phải sẫm hẳn so với mức ô trống của vùng (base)
    // và sẫm hẳn so với ô đứng thứ hai trong hàng. Ngưỡng tự giãn khi ảnh nhiễu (spread lớn).
    const rise = top.v - base
    // tô rõ: (a) mức bút mực/bút chì đậm như trước, hoặc (b) mức tô nhạt nhưng vẫn ≥ 45% mức tô của chính phiếu này
    // và cao hơn hẳn nhiễu ô trống (≥ 6 lần độ phân tán, ≥ 0,08)
    const strongInk = rise >= Math.max(0.15, 4 * spread) && top.v >= hiGlobal * 0.75
    const strongLight = rise >= Math.max(0.08, 6 * spread, 0.45 * sheetRise)
    const strong = strongInk || strongLight
    const minGap = strongInk ? Math.max(0.12, 0.35 * rise) : Math.max(0.06, 0.5 * rise)
    const gap = top.v - second.v
    const secondRise = second.v - base
    let chosen: number | null = null
    let why = ''
    if (strong && gap >= minGap) {
      chosen = top.i
      if (secondRise >= Math.max(0.1, 4 * spread) && second.v > top.v * 0.45)
        why = `Ô ${name(top.i)} tô đậm nhưng ô ${name(second.i)} có vết mờ (tẩy chưa sạch?)`
    } else if (strong) {
      const many = order.filter((o) => o.v - base >= Math.min(Math.max(0.15, 4 * spread), Math.max(0.08, 6 * spread, 0.45 * sheetRise)) && top.v - o.v < minGap)
      why =
        many.length >= 2
          ? `Tô ${many.length} ô (${many.map((o) => name(o.i)).join(', ')})`
          : `Ô ${name(top.i)} và ô ${name(second.i)} đậm gần như nhau — kiểm tra lại`
    } else if (rise >= Math.max(0.06, 2.5 * spread)) {
      why = `Ô ${name(top.i)} tô mờ / có vết tẩy — chưa chắc học sinh chọn`
    } else if (rowMin - baseOf[k].b >= 0.15 && rowMin >= hiGlobal * 0.75) {
      why = 'Tất cả các ô của hàng đều sẫm (tô hết?) — kiểm tra lại'
    } else if (top.v >= Math.max(0.11, emptyMed + 0.07)) {
      // không chọn được ô nào nhưng hàng sẫm hơn hẳn ô trống thông thường của phiếu (vùng tối / nhoè / tô nhạt cả hai ô)
      // -> không bao giờ để trống mà không báo
      why = 'Hàng này sẫm bất thường (bóng tối / nhoè / tô nhạt) — máy không chắc ô nào được tô, kiểm tra lại'
    }
    // Vị trí ô không khớp chắc (giấy cong / nhoè / che khuất) -> không đoán, để giáo viên xem
    if (!why && ringRef > 20) {
      const er = scores.map((v, i) => (v < Math.max(lo0, base + 0.07) ? d.rings[i] : NaN)).filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
      const weak = er.length > 0 && er[Math.floor((er.length - 1) / 2)] < ringRef * 0.3
      if (weak) why = chosen === null ? 'Không thấy rõ các ô của hàng này (ảnh mờ / giấy cong / bị che) — kiểm tra lại' : 'Vị trí ô hàng này chưa khớp chắc — kiểm tra lại'
    }
    d.chosen = chosen
    const id = row.part === 1 ? `1.${row.q}` : `2.${row.q}${'abcd'[row.sub ?? 0]}`
    if (why) {
      d.flagged = true
      flags[id] = why
    }
    if (row.part === 1) p1[row.q - 1] = chosen === null ? null : LET[chosen]
    else p2[row.q - 1][row.sub ?? 0] = chosen === null ? null : chosen === 0
  })
  return { p1, p2, flags, detail, H, quality, inkLevel }
}

/**
 * Quyết định cho phiếu chữ-trong-ô (chỉ Phần I). Điểm coverScore của ô trống phụ thuộc chữ in (B nhiều nét hơn)
 * và độ nét/ánh sáng từng vùng -> mức nền tính RIÊNG cho từng phương án, theo 8 câu gần nhất
 * (lấy trung vị 4 giá trị thấp nhất: đúng kể cả khi 4/8 câu gần đó cùng tô phương án này),
 * chặn trên bởi trung vị toàn phiếu + 0,05 (đề phòng cả cột tô cùng một phương án).
 */
function decideGrid(detail: BubbleRead['detail'], opt: ReadBubblesOptions, H: number[], quality: number): BubbleRead {
  const LET = ['A', 'B', 'C', 'D']
  const p1: (string | null)[] = Array.from({ length: opt.n1 }, () => null)
  const p2: (boolean | null)[][] = []
  const flags: Record<string, string> = {}
  const pos = detail.map((d) => {
    const n = d.row.opts.length
    return { x: d.row.opts.reduce((t, o) => t + o.x, 0) / n, y: d.row.opts.reduce((t, o) => t + o.y, 0) / n }
  })
  const med = (a: number[]) => {
    const t = [...a].sort((x, y) => x - y)
    return t.length ? (t.length % 2 ? t[(t.length - 1) / 2] : (t[t.length / 2 - 1] + t[t.length / 2]) / 2) : 0
  }
  const nOpt = Math.max(...detail.map((d) => d.scores.length))
  const globalBase = Array.from({ length: nOpt }, (_, i) => med(detail.map((d) => d.scores[i]).filter((v) => v !== undefined)))
  const K = Math.min(8, detail.length - 1)
  const raw = detail.map((d) => [...d.scores])
  detail.forEach((d, k) => {
    const near = detail
      .map((_, j) => ({ j, dist: j === k ? Infinity : Math.hypot(pos[j].x - pos[k].x, pos[j].y - pos[k].y) }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, K)
    d.scores = raw[k].map((v, i) => {
      const vals = near.map((n) => raw[n.j][i]).filter((x) => x !== undefined).sort((a, b) => a - b)
      const local = vals.length >= 3 ? med(vals.slice(0, Math.max(2, Math.ceil(vals.length / 2)))) : globalBase[i]
      return v - Math.min(local, globalBase[i] + 0.05)
    })
  })
  // ngưỡng (đo trên ảnh chụp thật): ô tô (kể cả bút chì loá) >= 0,115; ô trống <= 0,085 kể cả ảnh nhoè/bóng đổ;
  // vùng giữa (0,06–0,095) luôn tô vàng để giáo viên xem
  const CHOOSE = 0.095,
    GAP = 0.05,
    FAINT = 0.06,
    SURE = 0.16
  detail.forEach((d) => {
    const order = d.scores.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v)
    const top = order[0],
      second = order[1]
    let chosen: number | null = null
    let why = ''
    if (top.v >= CHOOSE && top.v - second.v >= Math.max(GAP, 0.4 * top.v)) {
      chosen = top.i
      if (second.v >= FAINT + 0.02) why = `Ô ${LET[top.i]} tô đậm nhưng ô ${LET[second.i]} có vết mờ (tẩy chưa sạch?)`
      // tô nhạt (bút chì nhạt, bị loá) gần mức chữ in nhoè của ô trống -> vẫn điền sẵn nhưng tô vàng
      else if (top.v < SURE) why = `Ô ${LET[top.i]} tô nhạt — kiểm tra lại`
    } else if (top.v >= CHOOSE) {
      const many = order.filter((o) => o.v >= CHOOSE && top.v - o.v < Math.max(GAP, 0.4 * top.v))
      why = many.length >= 2 ? `Tô ${many.length} ô (${many.map((o) => LET[o.i]).join(', ')})` : `Ô ${LET[top.i]} và ô ${LET[second.i]} đậm gần như nhau — kiểm tra lại`
    } else if (top.v >= FAINT) {
      why = `Ô ${LET[top.i]} tô mờ / có vết tẩy — chưa chắc học sinh chọn`
    } else {
      // phiếu chữ-trong-ô: ô tô nhạt/loá có thể lẫn với ô trống khi ảnh nhoè -> câu bỏ trống luôn để giáo viên xem
      why = 'Không thấy ô nào được tô — kiểm tra lại'
    }
    d.chosen = chosen
    if (why) {
      d.flagged = true
      flags[`1.${d.row.q}`] = why
    }
    if (d.row.q <= opt.n1) p1[d.row.q - 1] = chosen === null ? null : LET[chosen]
  })
  const marked = detail.filter((d) => d.chosen !== null).map((d) => d.scores[d.chosen!]).sort((a, b) => a - b)
  const inkLevel = marked.length ? marked[Math.floor(marked.length / 2)] : 0
  return { p1, p2, flags, detail, H, quality, inkLevel }
}

function spacingOf(rows: BubbleRow[]): number {
  let best = Infinity
  const pts = rows.flatMap((r) => r.opts)
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++) {
      const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y)
      if (d > 1e-6 && d < best) best = d
    }
  return Number.isFinite(best) ? best : 30
}

/** Ảnh nắn phẳng một vùng (để cắt phần viết tay gửi AI, hoặc vẽ ảnh đối chiếu) */
export function warpRegion(g: Gray, H: number[], r: { x: number; y: number; w: number; h: number }, scale: number): Gray {
  return warp(g, H, r.x, r.y, r.w, r.h, scale)
}

