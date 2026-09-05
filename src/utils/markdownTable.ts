export type ContentLine =
  | { type: 'table'; rows: string[][] } // rows[0] = dòng tiêu đề (header)
  | { type: 'bullet'; text: string }
  | { type: 'para'; text: string };

/**
 * Sửa bảng Markdown bị AI "làm phẳng" thành một dòng liền khi sao chép ngữ
 * liệu gốc — thường xảy ra với bảng có ô quá dài (ví dụ cột "HOẠT ĐỘNG CỦA GV
 * VÀ HS" nhiều bước): thay vì giữ 3+ dòng riêng "tiêu đề" / "|---|---|" / "dữ
 * liệu", mô hình đôi khi thay hết dấu xuống dòng bằng dấu cách, khiến cả bảng
 * hiện ra thành một đoạn văn có dấu "|" lộ liễu thay vì một bảng thật.
 *
 * Vì mọi dấu "|" thật NẰM TRONG nội dung ô đã được escape thành "\|" ngay từ
 * lúc trích xuất (xem docxParser.renderTableAsMarkdown), nên MỌI dấu "|" trần
 * còn sót lại chắc chắn là ranh giới cột/dòng của bảng — dựa vào đó, hàm này
 * tìm dòng phân cách kiểu "|---|---|" Ở BẤT KỲ ĐÂU trong văn bản (không cần
 * đứng riêng một dòng) để suy ra số cột, rồi chèn lại dấu xuống dòng đúng chỗ
 * trước khi giao cho vòng lặp phân tích theo dòng bên dưới xử lý như bình
 * thường. Nếu không tìm được dòng tiêu đề hợp lệ ngay trước dòng phân cách,
 * giữ nguyên văn bản (an toàn hơn là đoán sai và làm hỏng nội dung).
 */
function repairFlattenedTables(text: string): string {
  const sepRe = /\|(?:\s*:?-{2,}:?\s*\|){1,}/g;
  let result = '';
  let cursor = 0;
  let m: RegExpExecArray | null;

  while ((m = sepRe.exec(text))) {
    const sepStart = m.index;
    const sepEnd = sepRe.lastIndex;
    const colCount = (m[0].match(/-{2,}/g) || []).length;
    if (colCount < 1) {
      result += text.slice(cursor, sepEnd);
      cursor = sepEnd;
      continue;
    }

    const before = text.slice(cursor, sepStart);
    const headerRe = new RegExp('\\|(?:[^|\\n]*\\|){' + colCount + '}\\s*$');
    const headerMatch = before.match(headerRe);
    if (!headerMatch || headerMatch.index === undefined) {
      // Không tìm được dòng tiêu đề hợp lệ ngay trước -> chắc không phải bảng
      // bị làm phẳng (có thể chỉ là dấu "-" trùng hợp) -> giữ nguyên.
      result += text.slice(cursor, sepEnd);
      cursor = sepEnd;
      continue;
    }

    result += before.slice(0, headerMatch.index);
    result += '\n' + before.slice(headerMatch.index).trimEnd() + '\n' + m[0].trim();

    // Đọc tiếp các dòng dữ liệu ngay sau dòng phân cách, mỗi dòng đúng colCount ô.
    let dataCursor = sepEnd;
    const rowRe = new RegExp('^\\s*(\\|(?:[^|\\n]*\\|){' + colCount + '})');
    while (true) {
      const rowMatch = rowRe.exec(text.slice(dataCursor));
      if (!rowMatch) break;
      result += '\n' + rowMatch[1].trim();
      dataCursor += rowMatch[0].length;
    }
    result += '\n';
    cursor = dataCursor;
  }
  result += text.slice(cursor);
  return result;
}

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
  const lines = repairFlattenedTables(text).split('\n');
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

export interface MergedSection {
  /** Nội dung GOC trước bảng (ví dụ phần a) Mục tiêu, b) Nội dung... nếu có) — giữ nguyên, không gộp. */
  beforeTable: ContentLine[];
  /** Tiêu đề + dữ liệu của bảng gốc (chưa gồm cột Năng lực số/Hòa nhập mới). */
  headers: string[];
  rows: string[][];
  /** Nội dung Năng lực số — hiện dạng một ô gộp dọc (rowSpan) suốt chiều cao bảng, vì đây là một đoạn văn cho cả mục chứ không tách theo từng dòng của bảng gốc. */
  soText: string | null;
  ktText: string | null;
}

/**
 * Khi ngữ liệu gốc của một mục vốn đã là BẢNG THẬT (ví dụ "HOẠT ĐỘNG CỦA GV VÀ
 * HS | SẢN PHẨM DỰ KIẾN | NLS"), giáo viên muốn cột Năng lực số/Hòa nhập được
 * GẮN THÊM VÀO CHÍNH BẢNG ĐÓ (thêm cột), giống cách file gốc đã làm với cột
 * NLS — chứ không tách thành khối riêng nằm cạnh bảng. Hàm này phát hiện
 * trường hợp đó (khối GOC kết thúc bằng một bảng) và trả về cấu trúc đã gộp
 * sẵn để bên hiển thị/xuất Word chỉ việc build ra bảng nhiều cột hơn.
 * Trả về null nếu GOC không kết thúc bằng bảng, hoặc không có SO/KT nào cần gắn
 * — khi đó nơi gọi nên dùng cách hiển thị 3 cột cạnh nhau như cũ (an toàn hơn
 * cho nội dung dạng văn xuôi, không có gì để gộp).
 */
export function trySectionMerge(goc: string, so: string, kt: string): MergedSection | null {
  const hasSo = so.trim().length > 0;
  const hasKt = kt.trim().length > 0;
  if (!hasSo && !hasKt) return null;

  const gocLines = parseContentLines(goc);
  if (gocLines.length === 0) return null;
  const last = gocLines[gocLines.length - 1];
  if (last.type !== 'table') return null;

  const [headers, ...rows] = last.rows;
  if (!headers || rows.length === 0) return null;

  return {
    beforeTable: gocLines.slice(0, -1),
    headers,
    rows,
    soText: hasSo ? so.trim() : null,
    ktText: hasKt ? kt.trim() : null,
  };
}
