export type ContentLine =
  | { type: 'table'; rows: string[][] } // rows[0] = dòng tiêu đề (header)
  | { type: 'bullet'; text: string }
  | { type: 'para'; text: string };

/** Tách một dòng bảng Markdown "| a | b |" thành mảng ô, có bỏ escape "\|". */
function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);

  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
      continue;
    }
    if (s[i] === '|') {
      cells.push(cur.trim());
      cur = '';
      continue;
    }
    cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

/** Nhận diện dòng phân cách của bảng Markdown, kiểu "| --- | --- |" hoặc "|---|---|". */
function isSeparatorRow(line: string): boolean {
  return /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?$/.test(line.trim());
}

/**
 * Phân tích một khối văn bản (nội dung một cột GOC/SO/KT) thành danh sách các
 * đoạn: bảng (nếu AI tái tạo lại bảng gốc bằng cú pháp Markdown theo hướng dẫn
 * trong prompt), gạch đầu dòng, hoặc đoạn văn thường — dùng chung cho bản xem
 * trước (LessonPlanPreview) và bản xuất Word (exportDocx), để bảng nhiều cột
 * trong file gốc không bị "làm phẳng" thành đoạn văn nối tiếp.
 */
export function parseContentLines(text: string): ContentLine[] {
  const lines = text.split('\n');
  const result: ContentLine[] = [];
  let i = 0;

  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (!trimmed) {
      i++;
      continue;
    }

    if (trimmed.startsWith('|') && i + 1 < lines.length && isSeparatorRow(lines[i + 1])) {
      const rows: string[][] = [splitTableRow(trimmed)];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      result.push({ type: 'table', rows });
      continue;
    }

    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      result.push({ type: 'bullet', text: trimmed.slice(2) });
      i++;
      continue;
    }

    result.push({ type: 'para', text: trimmed });
    i++;
  }

  return result;
}
