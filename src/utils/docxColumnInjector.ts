/**
 * "Chế độ chỉ thêm cột" — thay vì bắt AI CHÉP LẠI toàn bộ giáo án dưới dạng
 * Markdown rồi dựng lại file Word từ đầu (cách làm cũ, dễ vỡ với nội dung dài
 * /phức tạp: bảng bị làm phẳng, marker rò rỉ, AI tự bịa bảng, bảng biến thiên
 * sai số liệu...), module này thao tác TRỰC TIẾP trên XML gốc của file .docx:
 * tìm các bảng "HOẠT ĐỘNG CỦA GV VÀ HS | SẢN PHẨM DỰ KIẾN" có sẵn, rồi CHÈN
 * THÊM cột "Năng lực số" / "Giáo dục hòa nhập (HSKT)" nếu chưa có — toàn bộ
 * phần còn lại của file (công thức, hình vẽ, bảng biến thiên, định dạng chữ)
 * GIỮ NGUYÊN TUYỆT ĐỐI, không đi qua bất kỳ bước "trích xuất rồi dựng lại"
 * nào. AI chỉ cần viết vài câu ngắn cho cột mới — rủi ro sai lệch giảm hẳn so
 * với việc bắt AI tái tạo nguyên văn công thức/bảng phức tạp.
 */

export interface ActivityTable {
  /** Vị trí (trong document.xml) của toàn bộ bảng, dùng để cắt/chèn XML. */
  start: number;
  end: number;
  /** Vị trí kết thúc thẻ </w:tblGrid> — nơi chèn thêm <w:gridCol> mới. */
  gridEnd: number;
  /** Vị trí bắt đầu/kết thúc dòng tiêu đề (row đầu tiên). */
  headerRow: { start: number; end: number };
  /** Dòng dữ liệu đầu tiên (nếu có) — các bảng hoạt động luôn chỉ có 1 dòng dữ liệu. */
  dataRow: { start: number; end: number } | null;
  headerTexts: string[];
  hasNls: boolean;
  hasKt: boolean;
  /** Kiểu w:tblW hiện tại, để biết có cần cộng thêm bề rộng khi thêm cột không. */
  tblWType: 'dxa' | 'pct' | 'auto' | null;
  tblWStart: number;
  tblWEnd: number;
  tblWValue: number;
  /** Tiêu đề hoạt động gần nhất phía trước bảng (để AI có ngữ cảnh). */
  heading: string;
  /** Văn bản thô của cột 1 (GV-HS) và cột 2 (Sản phẩm) từ dòng dữ liệu đầu tiên — để AI có ngữ cảnh, KHÔNG dùng để tái tạo lại. */
  gvHsText: string;
  sanPhamText: string;
}

/** Tìm các cặp thẻ CÙNG MỨC (không tính thẻ lồng bên trong cùng loại) —
 * dùng cho <w:tbl>...</w:tbl> và <w:tr ...>...</w:tr> vì cả hai đều có thể
 * lồng nhau (bảng lồng trong ô, hoặc — dù hiếm — dòng bên trong bảng lồng).
 * Đơn giản nhưng ĐÚNG: XML luôn cân bằng thẻ, nên đếm độ sâu theo thứ tự xuất
 * hiện của open/close là đủ, không cần phân biệt "thẻ này thuộc bảng lồng
 * nào" — khi độ sâu về 0 chính là lúc gặp đúng thẻ đóng khớp với thẻ mở đầu.
 */
function findBalancedSpans(
  xml: string,
  openRe: RegExp,
  closeStr: string,
  fromIndex = 0
): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  let i = fromIndex;
  const re = new RegExp(openRe.source, openRe.flags.includes('g') ? openRe.flags : openRe.flags + 'g');
  while (true) {
    re.lastIndex = i;
    const m = re.exec(xml);
    if (!m) break;
    const start = m.index;
    let pos = m.index + m[0].length;
    let depth = 1;
    while (depth > 0) {
      re.lastIndex = pos;
      const nextOpen = re.exec(xml);
      const nextClose = xml.indexOf(closeStr, pos);
      if (nextClose === -1) {
        pos = xml.length;
        depth = 0;
        break;
      }
      if (nextOpen && nextOpen.index < nextClose) {
        depth++;
        pos = nextOpen.index + nextOpen[0].length;
      } else {
        depth--;
        pos = nextClose + closeStr.length;
      }
    }
    spans.push({ start, end: pos });
    i = pos;
  }
  return spans;
}

function extractCellSpans(rowXml: string): { start: number; end: number }[] {
  return findBalancedSpans(rowXml, /<w:tc>/g, '</w:tc>');
}

function textOf(xml: string): string {
  const texts = [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]);
  return texts.join('').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
}

const ACTIVITY_HEADER_RE = /HOẠT\s*ĐỘNG\s*CỦA\s*GV/i;
const SAN_PHAM_HEADER_RE = /SẢN\s*PHẨM/i;
const NLS_HEADER_RE = /(^|\s)NLS(\s|$)|NĂNG\s*LỰC\s*SỐ/i;
const KT_HEADER_RE = /HÒA\s*NHẬP|HSKT|GIÁO\s*DỤC\s*ĐẶC\s*BIỆT/i;
const HEADING_STYLE_RE = /<w:pStyle w:val="Heading[123]"\s*\/>/;

/** Tìm tiêu đề hoạt động (đoạn văn có style Heading1/2/3) gần nhất TRƯỚC vị trí `pos`. */
function findPrecedingHeading(documentXml: string, pos: number): string {
  const paraSpans = findBalancedSpans(documentXml.slice(0, pos), /<w:p(?:\s[^>]*)?>/g, '</w:p>');
  for (let i = paraSpans.length - 1; i >= 0; i--) {
    const p = paraSpans[i];
    const xml = documentXml.slice(p.start, p.end);
    if (HEADING_STYLE_RE.test(xml)) {
      const t = textOf(xml).trim();
      if (t) return t;
    }
  }
  return '';
}

/** Quét toàn bộ document.xml, tìm các bảng "HOẠT ĐỘNG CỦA GV VÀ HS | SẢN PHẨM DỰ KIẾN [| NLS] [| GDHN]". */
export function findActivityTables(documentXml: string): ActivityTable[] {
  const tableSpans = findBalancedSpans(documentXml, /<w:tbl>/g, '</w:tbl>');
  const result: ActivityTable[] = [];

  for (const { start, end } of tableSpans) {
    const tableXml = documentXml.slice(start, end);
    const gridEndRel = tableXml.indexOf('</w:tblGrid>');
    if (gridEndRel === -1) continue;

    const rowSpansRel = findBalancedSpans(tableXml, /<w:tr(?:\s[^>]*)?>/g, '</w:tr>');
    if (rowSpansRel.length === 0) continue;
    const headerRowXml = tableXml.slice(rowSpansRel[0].start, rowSpansRel[0].end);
    const headerCellSpans = extractCellSpans(headerRowXml);
    const headerTexts = headerCellSpans.map((c) => textOf(headerRowXml.slice(c.start, c.end)).trim());

    const hasActivityHeader = headerTexts.some((t) => ACTIVITY_HEADER_RE.test(t));
    const hasSanPham = headerTexts.some((t) => SAN_PHAM_HEADER_RE.test(t));
    if (!hasActivityHeader || !hasSanPham) continue; // không phải bảng hoạt động GV-HS/Sản phẩm

    const hasNls = headerTexts.some((t) => NLS_HEADER_RE.test(t));
    const hasKt = headerTexts.some((t) => KT_HEADER_RE.test(t));

    const dataRowRel = rowSpansRel.length > 1 ? rowSpansRel[1] : null;
    let gvHsText = '';
    let sanPhamText = '';
    if (dataRowRel) {
      const dataRowXml = tableXml.slice(dataRowRel.start, dataRowRel.end);
      const cellSpans = extractCellSpans(dataRowXml);
      if (cellSpans[0]) gvHsText = textOf(dataRowXml.slice(cellSpans[0].start, cellSpans[0].end)).trim();
      if (cellSpans[1]) sanPhamText = textOf(dataRowXml.slice(cellSpans[1].start, cellSpans[1].end)).trim();
    }

    const tblWMatch = tableXml.match(/<w:tblW w:w="(\d+)" w:type="(dxa|pct|auto)"\s*\/>/);

    result.push({
      start,
      end,
      gridEnd: start + gridEndRel,
      headerRow: { start: start + rowSpansRel[0].start, end: start + rowSpansRel[0].end },
      dataRow: dataRowRel ? { start: start + dataRowRel.start, end: start + dataRowRel.end } : null,
      headerTexts,
      hasNls,
      hasKt,
      tblWType: tblWMatch ? (tblWMatch[2] as 'dxa' | 'pct' | 'auto') : null,
      tblWStart: tblWMatch ? start + (tblWMatch.index || 0) : -1,
      tblWEnd: tblWMatch ? start + (tblWMatch.index || 0) + tblWMatch[0].length : -1,
      tblWValue: tblWMatch ? parseInt(tblWMatch[1], 10) : 0,
      heading: findPrecedingHeading(documentXml, start),
      // Cắt bớt để giữ prompt AI nhỏ gọn — chỉ cần đủ ngữ cảnh, không cần toàn văn.
      gvHsText: gvHsText.slice(0, 2500),
      sanPhamText: sanPhamText.slice(0, 2500),
    });
  }

  return result;
}

function escapeXmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Chèn header tài liệu (tên trường/tổ/GV soạn...) và dòng "Tuần thực hiện/Số
 * tiết" vào NGAY ĐẦU văn bản (ngay sau <w:body>), dưới dạng đoạn văn MỚI HOÀN
 * TOÀN — không sửa/xoá bất kỳ đoạn nào có sẵn, đúng tinh thần "không chỉnh sửa
 * gì về tài liệu gốc" của chế độ chỉ-thêm-cột. Áp dụng SAU khi đã chèn xong
 * cột (injectAllColumns) — vì đây là một điểm neo cố định đứng TRƯỚC mọi bảng
 * (ngay đầu <w:body>), việc chèn ở đây không làm lệch vị trí các bảng đã tính
 * trước đó.
 */
export function injectHeaderAndWeek(
  documentXml: string,
  opts: { headerNote?: string; weekNumber?: string; durationPeriods?: number }
): string {
  const bodyOpenMatch = documentXml.match(/<w:body>/);
  if (!bodyOpenMatch || bodyOpenMatch.index === undefined) return documentXml;
  const insertPos = bodyOpenMatch.index + bodyOpenMatch[0].length;

  const rFonts = '<w:rFonts w:ascii="Times New Roman" w:eastAsia="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/>';
  const paras: string[] = [];

  const headerLines = (opts.headerNote || '').split('\n').map((l) => l.trim()).filter(Boolean);
  headerLines.forEach((line, i) => {
    const rPr = `${rFonts}${i === 0 ? '<w:b/>' : ''}<w:sz w:val="24"/><w:szCs w:val="24"/>`;
    paras.push(
      `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr>${rPr}</w:rPr><w:t xml:space="preserve">${escapeXmlText(
        line
      )}</w:t></w:r></w:p>`
    );
  });

  const weekParts: string[] = [];
  if (opts.weekNumber?.trim()) weekParts.push(`Tuần thực hiện: ${opts.weekNumber.trim()}`);
  if (opts.durationPeriods) weekParts.push(`Số tiết: ${opts.durationPeriods}`);
  if (weekParts.length > 0) {
    const rPr = `${rFonts}<w:i/><w:sz w:val="24"/><w:szCs w:val="24"/>`;
    paras.push(
      `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr>${rPr}</w:rPr><w:t xml:space="preserve">${escapeXmlText(
        weekParts.join('   —   ')
      )}</w:t></w:r></w:p>`
    );
  }

  if (paras.length === 0) return documentXml;
  paras.push('<w:p/>'); // dòng trống ngăn cách với nội dung gốc phía dưới

  return documentXml.slice(0, insertPos) + paras.join('') + documentXml.slice(insertPos);
}

/** Dựng XML cho MỘT ô mới (dùng cho cả ô tiêu đề và ô dữ liệu). Mỗi dòng của
 * `text` (phân theo \n) thành một đoạn <w:p> riêng. Dùng font Times New Roman
 * cỡ 13.5pt (sz=27, đơn vị half-point) — khớp với font phổ biến trong các
 * giáo án mẫu đã kiểm tra; nếu file gốc dùng font khác, ô mới có thể lệch font
 * đôi chút so với các ô khác (đánh đổi chấp nhận được để giữ toàn bộ phần còn
 * lại của file nguyên vẹn 100%, không đụng vào bất kỳ nội dung có sẵn nào). */
function buildCellXml(widthTwips: number, text: string, opts: { bold?: boolean; shadeHex?: string } = {}): string {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  const rPr = `<w:rFonts w:ascii="Times New Roman" w:eastAsia="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/>${
    opts.bold ? '<w:b/>' : ''
  }<w:sz w:val="27"/><w:szCs w:val="27"/>`;
  const paras =
    lines.length > 0
      ? lines
          .map(
            (line) =>
              `<w:p><w:pPr><w:spacing w:line="360" w:lineRule="auto"/></w:pPr><w:r><w:rPr>${rPr}</w:rPr><w:t xml:space="preserve">${escapeXmlText(
                line
              )}</w:t></w:r></w:p>`
          )
          .join('')
      : '<w:p/>';
  const shd = opts.shadeHex ? `<w:shd w:val="clear" w:color="auto" w:fill="${opts.shadeHex}"/>` : '';
  return `<w:tc><w:tcPr><w:tcW w:w="${widthTwips}" w:type="dxa"/>${shd}</w:tcPr>${paras}</w:tc>`;
}

export interface ColumnContent {
  nls?: string;
  kt?: string;
}

/**
 * Chèn cột Năng lực số/Giáo dục hòa nhập vào MỘT bảng hoạt động, trả về
 * document.xml đã chỉnh sửa. Chỉ thêm cột nào bảng CHƯA CÓ SẴN (nếu bảng đã
 * có cột NLS, không đụng vào — tôn trọng nội dung giáo viên đã tự viết).
 * Gọi hàm này lần lượt cho TỪNG bảng theo THỨ TỰ TỪ CUỐI VĂN BẢN LÊN ĐẦU (xem
 * injectAllColumns) để vị trí (start/end) của các bảng đứng trước không bị
 * lệch sau mỗi lần chèn.
 */
export function injectColumnsForTable(documentXml: string, table: ActivityTable, content: ColumnContent): string {
  const addNls = !table.hasNls && content.nls !== undefined;
  const addKt = !table.hasKt && content.kt !== undefined;
  if (!addNls && !addKt) return documentXml;

  const NLS_WIDTH = 2600;
  const KT_WIDTH = 3200;

  let xml = documentXml;

  // Chèn theo thứ tự vị trí GIẢM DẦN trong bảng (dòng dữ liệu -> dòng tiêu đề
  // -> tblGrid) để các vị trí chèn TRƯỚC ĐÓ (ở gần đầu bảng) không bị lệch.
  if (table.dataRow) {
    let insertion = '';
    if (addNls) insertion += buildCellXml(NLS_WIDTH, content.nls || '');
    if (addKt) insertion += buildCellXml(KT_WIDTH, content.kt || '');
    const closeTagLen = '</w:tr>'.length;
    const insertPos = table.dataRow.end - closeTagLen;
    xml = xml.slice(0, insertPos) + insertion + xml.slice(insertPos);
  }

  {
    let insertion = '';
    if (addNls) insertion += buildCellXml(NLS_WIDTH, 'Năng lực số', { bold: true, shadeHex: 'DCE6F7' });
    if (addKt) insertion += buildCellXml(KT_WIDTH, 'Giáo dục hòa nhập (HSKT)', { bold: true, shadeHex: 'F2E2C8' });
    const closeTagLen = '</w:tr>'.length;
    const insertPos = table.headerRow.end - closeTagLen;
    xml = xml.slice(0, insertPos) + insertion + xml.slice(insertPos);
  }

  {
    let insertion = '';
    if (addNls) insertion += `<w:gridCol w:w="${NLS_WIDTH}"/>`;
    if (addKt) insertion += `<w:gridCol w:w="${KT_WIDTH}"/>`;
    xml = xml.slice(0, table.gridEnd) + insertion + xml.slice(table.gridEnd);
  }

  // Nếu bề rộng bảng khai báo cố định (dxa), cộng thêm bề rộng cột mới để
  // bảng không bị bó hẹp lại (Word sẽ tự co các cột cũ nếu không cộng thêm).
  if (table.tblWType === 'dxa' && table.tblWStart >= 0) {
    const addedWidth = (addNls ? NLS_WIDTH : 0) + (addKt ? KT_WIDTH : 0);
    const newValue = table.tblWValue + addedWidth;
    const oldTag = xml.slice(table.tblWStart, table.tblWEnd);
    const newTag = oldTag.replace(/w:w="\d+"/, `w:w="${newValue}"`);
    xml = xml.slice(0, table.tblWStart) + newTag + xml.slice(table.tblWEnd);
  }

  return xml;
}

/** Áp dụng injectColumnsForTable cho NHIỀU bảng cùng lúc — luôn xử lý theo
 * thứ tự bảng đứng SAU trong văn bản trước, để offset của các bảng đứng TRƯỚC
 * (chưa xử lý) không bị lệch sau mỗi lần chèn. */
export function injectAllColumns(
  documentXml: string,
  tables: ActivityTable[],
  contentByIndex: Map<number, ColumnContent>
): string {
  let xml = documentXml;
  const indices = [...contentByIndex.keys()].sort((a, b) => b - a); // giảm dần theo vị trí xuất hiện
  for (const idx of indices) {
    const table = tables[idx];
    const content = contentByIndex.get(idx);
    if (table && content) {
      xml = injectColumnsForTable(xml, table, content);
    }
  }
  return xml;
}
