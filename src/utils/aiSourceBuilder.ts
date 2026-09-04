import { mathNodeToLinearText } from './mathToLinearText';
import type { ParsedDocument } from '../types';

/**
 * Trước đây mỗi placeholder được kèm NGAY một gợi ý ngắn dạng
 * "[[EQ:CT1]](ct: y=f(x)=x^3-3x^2+2x+1)" nằm LẪN trong đúng câu văn AI phải
 * chép nguyên văn (khối GOC) — điều này khiến AI đôi khi nhầm lẫn, chép luôn
 * cả phần gợi ý (ct: ...) ra làm nội dung thật thay vì chỉ giữ lại placeholder
 * trần, gây ra lỗi hiện chữ LaTeX thô trong bài (vd "y=f\\left(x\\right)=...").
 *
 * Giờ tách hẳn làm hai phần riêng biệt gửi cho AI:
 *   1) bodyText: y hệt văn bản gốc, CHỈ chứa placeholder trần [[EQ:CTx]], không
 *      có bất kỳ chú thích nào chen vào — đây là phần AI phải chép verbatim.
 *   2) equationLegend: bảng chú thích RIÊNG, liệt kê từng placeholder với nội
 *      dung công thức tương ứng, gửi kèm nhưng tách biệt hẳn khỏi bodyText, để
 *      AI hiểu ngữ cảnh khi viết khối SO/KT mà không có gì để "chép nhầm" vào
 *      khối GOC nữa.
 */
export function buildAiSourceText(doc: ParsedDocument): { bodyText: string; equationLegend: string } {
  const legendLines: string[] = [];

  const bodyText = doc.sourceTextWithPlaceholders.replace(/\[\[EQ:([^\]]+)\]\]/g, (full, id: string) => {
    const entry = doc.equations[id];
    if (!entry) return full;

    let hint = '';
    if (entry.convertible && entry.node) {
      hint = mathNodeToLinearText(entry.node);
    } else if (entry.latexFromExternalConverter) {
      hint = entry.latexFromExternalConverter;
    }

    if (hint) legendLines.push(`${full}: ${hint}`);
    return full; // bodyText CHỈ giữ lại placeholder trần, không chèn gì thêm
  });

  return { bodyText, equationLegend: legendLines.join('\n') };
}
