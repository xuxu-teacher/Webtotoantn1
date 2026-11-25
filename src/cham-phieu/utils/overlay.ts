/**
 * LỚP ĐÁNH DẤU KẾT QUẢ CHẤM TRÊN ẢNH PHIẾU (đã nắn thẳng)
 *  - Câu/ý làm ĐÚNG: vòng XANH LÁ quanh ô học sinh tô + dấu ✓.
 *  - Câu/ý làm SAI: vòng ĐỎ quanh ô học sinh tô + dấu ✗; ô ĐÁP ÁN ĐÚNG khoanh nét đứt đỏ.
 *  - Bỏ trống: chỉ khoanh nét đứt đỏ ô đáp án đúng + dấu ✗.
 *  - Hàng máy chưa chắc (ô vàng chưa rà): vòng CAM quanh cả hàng.
 *  - Chưa có đáp án (chưa chọn mã đề): vòng XANH DƯƠNG = ô máy đọc được.
 *  - Phần III lưới tô: câu đúng -> vòng xanh quanh mọi ô học sinh tô; câu sai -> vòng đỏ quanh ô học sinh tô,
 *    vòng đỏ nét đứt ở ô của đáp án đúng (cột học sinh tô sai), nhãn "ĐA: …" ngay trên khối câu.
 * Vẽ theo bài làm HIỆN TẠI (kể cả ô giáo viên đã sửa tay), nên luôn khớp với bảng kết quả.
 */
import type { CellId, OverlayGeo, PaperAnswers, PaperConfig } from './omr'
import { paperShortEqual } from './omr'
import { p3Canon, p3Placement } from './sheetTemplates'

export const MARK = {
  ok: '#16a34a',
  bad: '#dc2626',
  warn: '#f59e0b',
  read: '#2563eb',
}

/** Chỉ số ô học sinh chọn / ô đáp án trong một hàng: Phần I 0..3 (A..D), Phần II 0 = Đúng, 1 = Sai; -1 = trống */
function rowIndex(id: CellId, a: PaperAnswers | undefined): number {
  if (!a) return -1
  if (id.startsWith('1.')) {
    const v = a.p1[Number(id.slice(2)) - 1]
    return v ? 'ABCD'.indexOf(v) : -1
  }
  const m = /^2\.(\d+)([abcd])$/.exec(id)
  if (!m) return -1
  const v = a.p2[Number(m[1]) - 1]?.['abcd'.indexOf(m[2])]
  return v === true ? 0 : v === false ? 1 : -1
}

function ring(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, w: number, dashed = false) {
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = w
  if (dashed) ctx.setLineDash([w * 1.6, w * 1.1])
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()
}

function tick(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, ok: boolean) {
  ctx.save()
  ctx.strokeStyle = ok ? MARK.ok : MARK.bad
  ctx.lineWidth = Math.max(2, s * 0.22)
  ctx.lineCap = 'round'
  ctx.beginPath()
  if (ok) {
    ctx.moveTo(x - s * 0.45, y)
    ctx.lineTo(x - s * 0.1, y + s * 0.35)
    ctx.lineTo(x + s * 0.5, y - s * 0.4)
  } else {
    ctx.moveTo(x - s * 0.38, y - s * 0.38)
    ctx.lineTo(x + s * 0.38, y + s * 0.38)
    ctx.moveTo(x + s * 0.38, y - s * 0.38)
    ctx.lineTo(x - s * 0.38, y + s * 0.38)
  }
  ctx.stroke()
  ctx.restore()
}

/**
 * Vẽ lớp đánh dấu lên ctx (ảnh nền đã vẽ sẵn ở kích thước geo.w × geo.h).
 * key = undefined: chưa có đáp án -> chỉ vẽ ô máy đọc + hàng cần rà.
 */
export function drawGrades(
  ctx: CanvasRenderingContext2D,
  geo: OverlayGeo,
  answers: PaperAnswers,
  key: PaperAnswers | undefined,
  flags: Record<CellId, string>,
  cfg: PaperConfig,
) {
  for (const row of geo.rows) {
    if (row.part === 3) continue // Phần III lưới tô vẽ riêng bên dưới
    const R = row.r
    const lw = Math.max(2, R * 0.28)
    const stu = rowIndex(row.id, answers)
    const flagged = !!flags[row.id]
    if (flagged) row.centers.forEach((p) => ring(ctx, p.x, p.y, R * 1.6, MARK.warn, lw))
    const right = Math.max(...row.centers.map((p) => p.x)) + R * 2.3
    const cy = row.centers.reduce((t, p) => t + p.y, 0) / row.centers.length
    if (!key) {
      if (stu >= 0 && row.centers[stu]) ring(ctx, row.centers[stu].x, row.centers[stu].y, R * 1.3, MARK.read, lw)
      continue
    }
    const k = rowIndex(row.id, key)
    if (stu >= 0 && stu === k) {
      ring(ctx, row.centers[stu].x, row.centers[stu].y, R * 1.3, MARK.ok, lw)
      tick(ctx, right, cy, R * 1.5, true)
    } else {
      if (stu >= 0 && row.centers[stu]) ring(ctx, row.centers[stu].x, row.centers[stu].y, R * 1.3, MARK.bad, lw)
      if (k >= 0 && row.centers[k]) ring(ctx, row.centers[k].x, row.centers[k].y, R * 1.3, MARK.bad, lw, true)
      tick(ctx, right, cy, R * 1.5, false)
    }
  }
  if (geo.p3Mode === 'grid') {
    drawP3Grid(ctx, geo, answers, key, flags, cfg)
    return
  }
  // Phần III (phiếu lớp có ô ghi đáp số)
  if (key && cfg.n3 > 0)
    for (const b of geo.p3) {
      if (b.q > cfg.n3) continue
      const a = answers.p3[b.q - 1] || ''
      const kv = key.p3[b.q - 1] || ''
      const ok = !!a && paperShortEqual(a, kv)
      const lw = Math.max(2, b.h * 0.06)
      ctx.save()
      ctx.strokeStyle = ok ? MARK.ok : MARK.bad
      ctx.lineWidth = lw
      ctx.strokeRect(b.x - lw, b.y - lw, b.w + 2 * lw, b.h + 2 * lw)
      const s = b.h * 0.42
      tick(ctx, b.x + b.w - s * 0.7, b.y + s * 0.7, s, ok)
      if (!ok && kv) {
        ctx.fillStyle = MARK.bad
        ctx.font = `bold ${Math.round(b.h * 0.3)}px system-ui, sans-serif`
        ctx.textBaseline = 'top'
        ctx.fillText(`ĐA: ${kv}`, b.x + 3, b.y + b.h + lw * 1.5)
      }
      ctx.restore()
    }
}

/** Nhãn chữ trên nền trắng (để đọc rõ trên ảnh chụp) */
function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, color: string, align: 'left' | 'right') {
  ctx.save()
  ctx.font = `bold ${Math.round(size)}px system-ui, sans-serif`
  ctx.textBaseline = 'middle'
  const w = ctx.measureText(text).width
  const pad = size * 0.25
  const x0 = align === 'right' ? x - w - pad * 2 : x
  ctx.fillStyle = 'rgba(255,255,255,0.92)'
  ctx.fillRect(x0, y - size * 0.62, w + pad * 2, size * 1.24)
  ctx.strokeStyle = color
  ctx.lineWidth = Math.max(1, size * 0.08)
  ctx.strokeRect(x0, y - size * 0.62, w + pad * 2, size * 1.24)
  ctx.fillStyle = color
  ctx.fillText(text, x0 + pad, y)
  ctx.restore()
}

/** Phần III lưới tô (phiếu lớp mới): đánh dấu theo từng câu trên chính các ô tô */
function drawP3Grid(
  ctx: CanvasRenderingContext2D,
  geo: OverlayGeo,
  answers: PaperAnswers,
  key: PaperAnswers | undefined,
  flags: Record<CellId, string>,
  cfg: PaperConfig,
) {
  for (const b of geo.p3) {
    if (b.q > cfg.n3) continue
    const id = `3.${b.q}`
    const cols = geo.rows.filter((r) => r.part === 3 && r.id === id).sort((x, y) => (x.col ?? 0) - (y.col ?? 0))
    if (!cols.length) continue
    const R = cols[0].r
    const lw = Math.max(2, R * 0.28)
    const a = answers.p3[b.q - 1] || ''
    // các ô máy đọc chỉ còn đúng khi giáo viên CHƯA sửa tay đáp số của câu này
    const machine = (geo.p3Read?.[b.q - 1] || '') === a
    const marked = machine ? cols.flatMap((c) => (c.marks || []).map((i) => ({ c, i }))) : []
    const lblSize = Math.max(12, R * 1.5)
    if (flags[id]) {
      ctx.save()
      ctx.strokeStyle = MARK.warn
      ctx.lineWidth = lw
      ctx.strokeRect(b.x - lw, b.y - lw, b.w + 2 * lw, b.h + 2 * lw)
      ctx.restore()
    }
    if (!key) {
      for (const m of marked) ring(ctx, m.c.centers[m.i].x, m.c.centers[m.i].y, R * 1.3, MARK.read, lw)
      if (!machine && a) label(ctx, a, b.x + b.w - 2, b.y + lblSize * 0.8, lblSize, MARK.read, 'right')
      continue
    }
    const kv = key.p3[b.q - 1] || ''
    const ok = !!a && paperShortEqual(a, kv)
    const color = ok ? MARK.ok : MARK.bad
    for (const m of marked) ring(ctx, m.c.centers[m.i].x, m.c.centers[m.i].y, R * 1.3, color, lw)
    ctx.save()
    ctx.strokeStyle = color
    ctx.lineWidth = lw
    ctx.strokeRect(b.x - lw * 0.5, b.y - lw * 0.5, b.w + lw, b.h + lw)
    ctx.restore()
    tick(ctx, b.x + b.w - R * 1.4, b.y + b.h - R * 1.4, R * 1.8, ok)
    if (ok || !kv) continue
    // ô của đáp án đúng: đặt các ký tự đáp án vào đúng các cột học sinh đã dùng (nếu cùng số ký tự), không thì từ cột 1
    const kc = p3Canon(kv)
    let place = p3Placement(kc)
    const used = machine ? cols.filter((c) => c.chosen !== null && c.chosen !== undefined).map((c) => c.col ?? 0) : []
    if (place && used.length === kc.length && [...kc].every((ch, i) => cols[used[i]]?.chars?.includes(ch))) place = used
    if (place)
      [...kc].forEach((ch, i) => {
        const c = cols.find((cc) => (cc.col ?? 0) === place![i])
        const j = c?.chars?.indexOf(ch) ?? -1
        if (!c || j < 0) return
        if (machine && c.chosen === j) return // cột này học sinh tô đúng ký tự
        ring(ctx, c.centers[j].x, c.centers[j].y, R * 1.3, MARK.bad, lw, true)
      })
    label(ctx, `ĐA: ${kc.replace(/-/g, '−')}`, b.x + b.w - 2, b.y + lblSize * 0.8, lblSize, MARK.bad, 'right')
    if (!machine && a) label(ctx, `HS: ${a}`, b.x + 2, b.y + lblSize * 2.1, lblSize * 0.9, MARK.bad, 'left')
  }
}

const imgCache = new Map<string, Promise<HTMLImageElement>>()

export function loadImage(src: string): Promise<HTMLImageElement> {
  let p = imgCache.get(src)
  if (!p) {
    p = new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('Không mở được ảnh phiếu.'))
      el.src = src
    })
    imgCache.set(src, p)
    // giữ bộ nhớ đệm nhỏ (ảnh data URL khá nặng)
    if (imgCache.size > 40) imgCache.delete(imgCache.keys().next().value as string)
  }
  return p
}

/** Ảnh JPEG đã vẽ lớp chấm (để lưu vào Google Drive kèm phiếu) */
export async function renderGradedOverlay(
  base: string,
  geo: OverlayGeo,
  answers: PaperAnswers,
  key: PaperAnswers | undefined,
  flags: Record<CellId, string>,
  cfg: PaperConfig,
): Promise<string> {
  const img = await loadImage(base)
  const c = document.createElement('canvas')
  c.width = geo.w
  c.height = geo.h
  const ctx = c.getContext('2d')!
  ctx.drawImage(img, 0, 0, geo.w, geo.h)
  drawGrades(ctx, geo, answers, key, flags, cfg)
  return c.toDataURL('image/jpeg', 0.85)
}
