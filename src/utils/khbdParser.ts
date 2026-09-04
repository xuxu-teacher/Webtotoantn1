import { wrapBareLatex } from './latexToMathNode';

export type KhbdBlock =
  | { type: 'heading'; level: 1 | 2 | 3; text: string }
  | { type: 'section'; goc: string; so: string; kt: string }
  | { type: 'text'; text: string };

/**
 * Phân tích định dạng KHBD tuỳ biến do AI trả về: heading Markdown thường, theo
 * sau bởi khối <<<GOC ... GOC>>> (bắt buộc — nguyên văn giáo án gốc), rồi tuỳ
 * chọn thêm <<<SO ... SO>>> (năng lực số) và/hoặc <<<KT ... KT>>> (giáo dục hòa
 * nhập), mỗi loại một cột RIÊNG — không gộp chung như định dạng TRAI/PHAI cũ.
 * SO và KT có thể xuất hiện theo thứ tự bất kỳ, hoặc vắng mặt hoàn toàn (mục đó
 * không có gì bổ sung). Dùng chung cho cả bản xem trước (React) và bản xuất
 * Word (bảng nhiều cột thật).
 */
export function parseKhbd(markdown: string): KhbdBlock[] {
  const lines = markdown.split('\n');
  const blocks: KhbdBlock[] = [];
  let i = 0;

  function collectUntil(endMarker: string): string {
    const collected: string[] = [];
    while (i < lines.length && lines[i].trim() !== endMarker) {
      collected.push(lines[i]);
      i++;
    }
    i++; // bỏ qua chính dòng endMarker
    return collected.join('\n').trim();
  }

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith('### ')) {
      blocks.push({ type: 'heading', level: 3, text: trimmed.slice(4) });
      i++;
    } else if (trimmed.startsWith('## ')) {
      blocks.push({ type: 'heading', level: 2, text: trimmed.slice(3) });
      i++;
    } else if (trimmed.startsWith('# ')) {
      blocks.push({ type: 'heading', level: 1, text: trimmed.slice(2) });
      i++;
    } else if (trimmed === '<<<GOC') {
      i++;
      const goc = collectUntil('GOC>>>');
      let so = '';
      let kt = '';
      // SO/KT có thể xuất hiện theo thứ tự bất kỳ, mỗi loại tối đa một lần.
      for (let guard = 0; guard < 2; guard++) {
        if (lines[i]?.trim() === '<<<SO') {
          i++;
          so = collectUntil('SO>>>');
        } else if (lines[i]?.trim() === '<<<KT') {
          i++;
          kt = collectUntil('KT>>>');
        } else {
          break;
        }
      }
      blocks.push({ type: 'section', goc: wrapBareLatex(goc), so: wrapBareLatex(so), kt: wrapBareLatex(kt) });
    } else if (trimmed) {
      blocks.push({ type: 'text', text: wrapBareLatex(trimmed) });
      i++;
    } else {
      i++;
    }
  }

  return blocks;
}
