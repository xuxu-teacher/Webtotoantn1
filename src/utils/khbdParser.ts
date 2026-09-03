export type KhbdBlock =
  | { type: 'heading'; level: 1 | 2 | 3; text: string }
  | { type: 'section'; left: string; right: string }
  | { type: 'text'; text: string };

/**
 * Phân tích định dạng KHBD tuỳ biến do AI trả về: heading Markdown thường, theo
 * sau bởi cặp khối <<<TRAI ... TRAI>>> / <<<PHAI ... PHAI>>>. Dùng chung cho cả
 * bản xem trước (React) và bản xuất Word (bảng 2 cột thật).
 */
export function parseKhbd(markdown: string): KhbdBlock[] {
  const lines = markdown.split('\n');
  const blocks: KhbdBlock[] = [];
  let i = 0;

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
    } else if (trimmed === '<<<TRAI') {
      const leftLines: string[] = [];
      i++;
      while (i < lines.length && lines[i].trim() !== 'TRAI>>>') {
        leftLines.push(lines[i]);
        i++;
      }
      i++;
      let rightLines: string[] = [];
      if (lines[i]?.trim() === '<<<PHAI') {
        i++;
        while (i < lines.length && lines[i].trim() !== 'PHAI>>>') {
          rightLines.push(lines[i]);
          i++;
        }
        i++;
      }
      blocks.push({ type: 'section', left: leftLines.join('\n').trim(), right: rightLines.join('\n').trim() });
    } else if (trimmed) {
      blocks.push({ type: 'text', text: trimmed });
      i++;
    } else {
      i++;
    }
  }

  return blocks;
}
