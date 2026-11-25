/**
 * In / tải mẫu phiếu trả lời tô ô cho bài kiểm tra tại lớp (đúng số câu của đợt chấm).
 *  - openPrintSheets: mở cửa sổ in của trình duyệt (in thẳng ra giấy hoặc "Lưu dưới dạng PDF").
 *  - downloadSheetPdf: tạo và tải về ngay một FILE PDF khổ A4 (không cần hộp thoại in) — tiện gửi đi photo.
 * Phiếu nửa trang được xếp 2 phiếu trên một tờ A4 (có đường cắt). Bố cục lấy từ cùng hàm với lúc quét
 * (classLayout) nên phiếu in ra luôn khớp mẫu đọc.
 */
import { classLayout, layoutToSvg } from './sheetTemplates'
import type { ClassLayout } from './sheetTemplates'
import type { PaperConfig } from './omr'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')

function layoutOf(cfg: PaperConfig): ClassLayout {
  return classLayout({ n1: cfg.n1, n2: cfg.n2, n3: cfg.n3 }, cfg.paper, cfg.bigBubbles)
}

/** Ruột SVG của một phiếu (bỏ thẻ <svg> ngoài) để ghép nhiều phiếu lên một trang */
function innerSvg(svg: string): string {
  return svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '')
}

/** SVG cả tờ A4 (210 × 297 mm): 1 phiếu, hoặc 2 phiếu nửa trang + đường cắt */
export function sheetPageSvg(cfg: PaperConfig, title: string): string {
  const l = layoutOf(cfg)
  const one = innerSvg(layoutToSvg(l, title))
  const body =
    l.size === 'A5'
      ? `<g>${one}</g><g transform="translate(0 148.5)">${one}</g>` +
        `<line x1="4" y1="148.5" x2="206" y2="148.5" stroke="#999" stroke-width="0.25" stroke-dasharray="2 1.5"/>` +
        `<text x="6" y="147.6" font-size="3" fill="#999" font-family="Arial, sans-serif">✂ cắt theo đường này</text>`
      : one
  return `<svg xmlns="http://www.w3.org/2000/svg" width="210mm" height="297mm" viewBox="0 0 210 297"><rect x="0" y="0" width="210" height="297" fill="#fff"/>${body}</svg>`
}

/** SVG xem trước một phiếu (co giãn theo khung chứa) */
export function sheetPreviewSvg(cfg: PaperConfig): string {
  const l = layoutOf(cfg)
  return layoutToSvg(l).replace(/width="[\d.]+mm" height="[\d.]+mm"/, 'width="100%" preserveAspectRatio="xMidYMin meet"')
}

/** Tên file an toàn từ tên đợt chấm */
function fileBase(title: string): string {
  const s = (title || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
  return s || 'phieu_tra_loi'
}

export function openPrintSheets(cfg: PaperConfig, title: string) {
  const l = layoutOf(cfg)
  const page = sheetPageSvg(cfg, title)
  const html = `<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>Phiếu trả lời – ${esc(title)}</title>
<style>
@page { size: A4 portrait; margin: 0 }
html, body { margin: 0; padding: 0; background: #6b7280 }
.page { width: 210mm; height: 297mm; background: #fff; margin: 8mm auto; overflow: hidden; box-shadow: 0 6px 24px rgba(0,0,0,.25) }
.page svg { display: block; width: 210mm; height: 297mm }
.note { width: 210mm; max-width: calc(100% - 16px); margin: 8mm auto 0; font: 14px/1.55 system-ui, sans-serif; color: #fff }
@media print { html, body { background: #fff } .page { margin: 0; box-shadow: none; page-break-after: always } .note { display: none } }
</style></head><body>
<div class="note"><b>Khi in:</b> khổ giấy A4, tỉ lệ 100% (Actual size / Không co giãn), lề = Không. Có thể chọn máy in "Lưu dưới dạng PDF" để giữ file và photo.
${l.size === 'A5' ? 'Mỗi tờ A4 có 2 phiếu — cắt theo đường kẻ ✂.' : ''} Giữ nguyên các ô vuông đen ở góc phiếu (máy dùng để định vị khi quét).</div>
<div class="page">${page}</div>
<script>window.onload = () => setTimeout(() => window.print(), 300)</script>
</body></html>`
  const w = window.open('', '_blank')
  if (!w) {
    alert('Trình duyệt chặn cửa sổ mới. Hãy cho phép cửa sổ bật lên (pop-up) cho trang này rồi bấm lại, hoặc bấm "Tải PDF".')
    return
  }
  w.document.open()
  w.document.write(html)
  w.document.close()
}

// ---------------- TẠO FILE PDF (không cần thư viện) ----------------

/** Vẽ SVG ra canvas ở độ phân giải dpi */
async function svgToJpeg(svg: string, dpi: number): Promise<{ bytes: Uint8Array; w: number; h: number }> {
  const W = Math.round((210 / 25.4) * dpi),
    H = Math.round((297 / 25.4) * dpi)
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }))
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('Không dựng được hình phiếu.'))
      el.src = url
    })
    const c = document.createElement('canvas')
    c.width = W
    c.height = H
    const ctx = c.getContext('2d')
    if (!ctx) throw new Error('Trình duyệt không hỗ trợ vẽ hình.')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, W, H)
    ctx.drawImage(img, 0, 0, W, H)
    const blob = await new Promise<Blob | null>((resolve) => c.toBlob(resolve, 'image/jpeg', 0.92))
    if (!blob) throw new Error('Không tạo được ảnh phiếu.')
    return { bytes: new Uint8Array(await blob.arrayBuffer()), w: W, h: H }
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** PDF 1 trang A4 chứa đúng 1 ảnh JPEG phủ kín trang */
function jpegToPdf(jpg: { bytes: Uint8Array; w: number; h: number }, title: string): Blob {
  const enc = new TextEncoder()
  const chunks: Uint8Array[] = []
  let len = 0
  const offsets: number[] = []
  const push = (x: string | Uint8Array) => {
    const b = typeof x === 'string' ? enc.encode(x) : x
    chunks.push(b)
    len += b.length
  }
  const obj = (n: number, body: string) => {
    offsets[n] = len
    push(`${n} 0 obj\n${body}\nendobj\n`)
  }
  const PW = 595.276,
    PH = 841.89
  // tiêu đề PDF: chỉ giữ kí tự ASCII
  const t = title.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').replace(/[^\x20-\x7e]/g, '').replace(/[()\\]/g, '')
  push('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>')
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`)
  offsets[4] = len
  push(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${jpg.w} /Height ${jpg.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.bytes.length} >>\nstream\n`)
  push(jpg.bytes)
  push('\nendstream\nendobj\n')
  const content = `q ${PW} 0 0 ${PH} 0 0 cm /Im0 Do Q`
  obj(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
  obj(6, `<< /Title (Phieu tra loi - ${t}) /Producer (Cham phieu - web to Toan) >>`)
  const xref = len
  let x = `xref\n0 7\n0000000000 65535 f \n`
  for (let i = 1; i <= 6; i++) x += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  push(x)
  push(`trailer\n<< /Size 7 /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
  return new Blob(chunks as BlobPart[], { type: 'application/pdf' })
}

/** Tạo và tải về file PDF mẫu phiếu (khổ A4, 300 dpi — in ra sắc nét, quét chính xác) */
export async function downloadSheetPdf(cfg: PaperConfig, title: string): Promise<void> {
  const svg = sheetPageSvg(cfg, title)
  // điện thoại yếu: thử lại ở độ phân giải thấp hơn nếu thiếu bộ nhớ
  let jpg: { bytes: Uint8Array; w: number; h: number } | null = null
  let err: unknown = null
  for (const dpi of [300, 200]) {
    try {
      jpg = await svgToJpeg(svg, dpi)
      break
    } catch (e) {
      err = e
    }
  }
  if (!jpg) throw err instanceof Error ? err : new Error('Không tạo được file PDF.')
  const blob = jpegToPdf(jpg, title)
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `Phieu_tra_loi_${fileBase(title)}.pdf`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 10000)
}
