import { mathNodeToLinearText } from './mathToLinearText';
import type { ParsedDocument } from '../types';

/**
 * Trước đây AI chỉ thấy placeholder [[EQ:CTx]] trần trụi — không biết công thức
 * nói gì nên khó viết "Nội dung/Sản phẩm" của hoạt động cho sát. Giờ mỗi
 * placeholder được kèm một gợi ý ngắn (ct: ...) lấy từ:
 *   1) Công thức Word gốc (OMML) -> tuyến tính hoá
 *   2) Hoặc LaTeX đã chuyển đổi qua máy chủ MathType→LaTeX riêng (nếu đã chạy)
 * AI được yêu cầu CHỈ dùng gợi ý này để hiểu ngữ cảnh, KHÔNG chép lại vào bài —
 * khi viết KHBD chỉ được xuất lại placeholder trần [[EQ:CTx]] (xem lessonPlanTemplate.ts).
 */
export function buildAiSourceText(doc: ParsedDocument): string {
  return doc.sourceTextWithPlaceholders.replace(/\[\[EQ:([^\]]+)\]\]/g, (full, id: string) => {
    const entry = doc.equations[id];
    if (!entry) return full;

    let hint = '';
    if (entry.convertible && entry.node) {
      hint = mathNodeToLinearText(entry.node);
    } else if (entry.latexFromExternalConverter) {
      hint = entry.latexFromExternalConverter;
    }

    return hint ? `${full}(ct: ${hint})` : full;
  });
}
