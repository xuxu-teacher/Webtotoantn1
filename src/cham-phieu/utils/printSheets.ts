/**
 * In mẫu phiếu trả lời tô ô cho bài kiểm tra tại lớp (đúng số câu của đợt chấm).
 * Mở cửa sổ in của trình duyệt: in thẳng ra giấy hoặc chọn "Lưu dưới dạng PDF".
 * Phiếu khổ A5 được xếp 2 phiếu trên một tờ A4 (có đường cắt).
 */
import { classLayout, layoutToSvg } from './sheetTemplates'
import type { PaperConfig } from './omr'

export function openPrintSheets(cfg: PaperConfig, title: string) {
  const l = classLayout({ n1: cfg.n1, n2: cfg.n2, n3: cfg.n3 }, cfg.paper)
  const svg = layoutToSvg(l, title)
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const page =
    l.size === 'A5'
      ? `<div class="page">${svg}<div class="cut">✂ - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -</div>${svg}</div>`
      : `<div class="page">${svg}</div>`
  const html = `<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>Phiếu trả lời – ${esc(title)}</title>
<style>
@page { size: A4 portrait; margin: 0 }
html, body { margin: 0; padding: 0; background: #888 }
.page { width: 210mm; height: 297mm; background: #fff; position: relative; margin: 8mm auto; overflow: hidden }
.page svg { display: block }
.cut { position: absolute; left: 0; right: 0; top: 148.5mm; transform: translateY(-50%); font-size: 9pt; color: #999; white-space: nowrap; overflow: hidden; text-align: center }
.note { width: 210mm; margin: 8mm auto 0; font: 14px/1.5 system-ui, sans-serif; color: #fff }
@media print { html, body { background: #fff } .page { margin: 0; page-break-after: always } .note { display: none } }
</style></head><body>
<div class="note">Khi in: khổ giấy A4, tỉ lệ 100% (Actual size / Không co giãn), lề = Không. Có thể chọn máy in "Lưu dưới dạng PDF" để giữ file và photo.
${l.size === 'A5' ? 'Mỗi tờ A4 có 2 phiếu — cắt theo đường kẻ ✂.' : ''} Giữ nguyên các ô vuông đen ở góc phiếu.</div>
${page}
<script>window.onload = () => setTimeout(() => window.print(), 300)</script>
</body></html>`
  const w = window.open('', '_blank')
  if (!w) {
    alert('Trình duyệt chặn cửa sổ mới. Hãy cho phép cửa sổ bật lên (pop-up) cho trang này rồi bấm lại.')
    return
  }
  w.document.open()
  w.document.write(html)
  w.document.close()
}
