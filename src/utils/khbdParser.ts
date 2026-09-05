import { wrapBareLatex } from './latexToMathNode';

export type KhbdBlock =
  | { type: 'heading'; level: 1 | 2 | 3; text: string }
  | { type: 'section'; goc: string; so: string; kt: string }
  | { type: 'text'; text: string };

const MARKERS = ['<<<GOC', 'GOC>>>', '<<<SO', 'SO>>>', '<<<KT', 'KT>>>'];
const MARKER_RE = /<<<GOC|GOC>>>|<<<SO|SO>>>|<<<KT|KT>>>/g;

/**
 * Đảm bảo mỗi marker <<<GOC/GOC>>>/<<<SO/SO>>>/<<<KT/KT>>> luôn nằm TRÊN MỘT
 * DÒNG RIÊNG, dù AI có lỡ viết dính liền với văn bản xung quanh trên cùng một
 * dòng hay không (giống lỗi "làm phẳng" từng gặp với bảng Markdown — dưới áp
 * lực nội dung quá dài/phức tạp, mô hình đôi khi bỏ dấu xuống dòng quanh
 * marker). Nếu không chuẩn hoá, bộ phân tích bên dưới (dựa vào so khớp CẢ
 * DÒNG đúng bằng marker) sẽ không nhận ra marker đóng/mở, khiến cả khối SO/KT
 * bị nuốt lẫn vào GOC và marker hiện ra thành chữ thô "<<<SO..." ngay trong
 * bài — lỗi nặng hơn nhiều so với chỉ mất định dạng bảng.
 */
function normalizeMarkers(markdown: string): string {
  return markdown.replace(MARKER_RE, (m) => `\n${m}\n`);
}

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
  const lines = normalizeMarkers(markdown).split('\n');
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
      // Bỏ qua dòng trống xen giữa (ví dụ do normalizeMarkers chèn thêm khi
      // tách các marker viết dính liền nhau) trước khi kiểm tra marker kế tiếp.
      const skipBlankLines = () => {
        while (i < lines.length && lines[i].trim() === '') i++;
      };
      // SO/KT có thể xuất hiện theo thứ tự bất kỳ, mỗi loại tối đa một lần.
      for (let guard = 0; guard < 2; guard++) {
        skipBlankLines();
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
    } else if (MARKERS.includes(trimmed)) {
      // Marker mồ côi (ví dụ "SO>>>" đóng không khớp khối mở nào, do AI viết
      // sai cấu trúc) — bỏ qua thay vì hiện chữ thô ra bài.
      i++;
    } else if (trimmed) {
      // Gộp các dòng liên tiếp (không phải heading/<<<GOC) thành MỘT khối
      // 'text' duy nhất, giữ nguyên dấu xuống dòng giữa chúng — thay vì tách
      // mỗi dòng thành một khối riêng như trước đây. Quan trọng với trường
      // hợp AI lỡ viết một bảng Markdown (nhiều dòng "|...|") nằm NGOÀI khối
      // <<<GOC>>>: nếu tách theo từng dòng, mỗi dòng bảng biến thành một khối
      // 'text' riêng lẻ, khiến parseContentLines (ở nơi hiển thị/xuất) không
      // còn thấy đủ 2 dòng liên tiếp (tiêu đề + "|---|---|") để nhận diện
      // đúng là một bảng — bảng bị "vỡ" thành các đoạn văn rời rạc.
      const collected: string[] = [lines[i]];
      i++;
      while (i < lines.length) {
        const next = lines[i].trim();
        if (!next || next.startsWith('#') || MARKERS.includes(next)) break;
        collected.push(lines[i]);
        i++;
      }
      blocks.push({ type: 'text', text: wrapBareLatex(collected.join('\n').trim()) });
    } else {
      i++;
    }
  }

  return blocks;
}
