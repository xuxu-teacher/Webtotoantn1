import {
  Document,
  Packer,
  Paragraph,
  HeadingLevel,
  TextRun,
  ImageRun,
  Table,
  TableRow,
  TableCell,
  WidthType,
  ShadingType,
  AlignmentType,
  Math as DocxMath,
} from 'docx';
import { saveAs } from 'file-saver';
import { parseKhbd } from './khbdParser';
import { parseContentLines, trySectionMerge } from './markdownTable';
import { mathNodeToDocxComponents } from './mathToDocx';
import { parseLatexSafe } from './latexToMathNode';
import type { EquationEntry, ImageEntry } from '../types';

type ParaChild = TextRun | DocxMath | ImageRun;

const PT_TO_PX = 96 / 72;
const DEFAULT_EQ_SIZE_PT = { width: 90, height: 24 };

// Font/định dạng chuẩn cho toàn bộ văn bản xuất ra — Times New Roman 12 (size
// tính bằng half-point, nên 12pt = 24), lề gọn theo chuẩn văn bản hành chính VN
// (trên 2cm, dưới 2cm, phải 2cm, trái 3cm để chừa chỗ đóng tập/bấm ghim).
const BODY_FONT = 'Times New Roman';
const BODY_SIZE_HALF_PT = 24; // 12pt
const CM_TO_TWIP = 566.929;
const PAGE_MARGIN = {
  top: Math.round(2 * CM_TO_TWIP),
  bottom: Math.round(2 * CM_TO_TWIP),
  right: Math.round(2 * CM_TO_TWIP),
  left: Math.round(3 * CM_TO_TWIP),
};
// Chiều rộng khả dụng của trang (A4 21cm - lề trái 3cm - lề phải 2cm = 16cm) —
// dùng để giới hạn ảnh chèn từ file gốc không bị tràn lề khi Word đặt kích
// thước gốc quá khổ (ví dụ ảnh chụp màn hình full HD dán thẳng vào giáo án).
const MAX_IMAGE_WIDTH_PT = (21 - 3 - 2) * (72 / 2.54);
const DEFAULT_IMG_SIZE_PT = { width: 300, height: 200 };

const MIME_TO_DOCX_TYPE: Record<string, 'png' | 'jpg' | 'gif' | 'bmp'> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
};

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Trả về ImageRun cho công thức OLE có ảnh xem trước dạng raster (PNG/JPEG/GIF/BMP). */
function equationImageRun(entry: EquationEntry): ImageRun | null {
  const img = entry.previewImage;
  if (!img || img.kind !== 'raster') return null;
  const type = MIME_TO_DOCX_TYPE[img.mime];
  if (!type) return null;

  const base64 = img.dataUrl.split(',')[1] || '';
  const size = entry.sizePt || DEFAULT_EQ_SIZE_PT;

  return new ImageRun({
    type,
    data: base64ToUint8Array(base64),
    transformation: {
      width: Math.round(size.width * PT_TO_PX),
      height: Math.round(size.height * PT_TO_PX),
    },
  } as any);
}

/** Trả về ImageRun cho một hình vẽ/ảnh minh hoạ thường (không phải công thức), có giới hạn
 * chiều rộng tối đa để không tràn lề trang khi ảnh gốc quá khổ. */
function plainImageRun(entry: ImageEntry): ImageRun | null {
  if (entry.kind !== 'raster') return null;
  const type = MIME_TO_DOCX_TYPE[entry.mime];
  if (!type) return null;

  const base64 = entry.dataUrl.split(',')[1] || '';
  const size = entry.sizePt || DEFAULT_IMG_SIZE_PT;
  let widthPt = size.width;
  let heightPt = size.height;
  if (widthPt > MAX_IMAGE_WIDTH_PT) {
    heightPt = (heightPt * MAX_IMAGE_WIDTH_PT) / widthPt;
    widthPt = MAX_IMAGE_WIDTH_PT;
  }

  return new ImageRun({
    type,
    data: base64ToUint8Array(base64),
    transformation: {
      width: Math.round(widthPt * PT_TO_PX),
      height: Math.round(heightPt * PT_TO_PX),
    },
  } as any);
}

/** Tách một dòng thành các run (text thường / công thức thật / ảnh công thức OLE / hình vẽ thường / $...$ AI viết thêm). */
function inlineToRuns(
  line: string,
  equations: Record<string, EquationEntry>,
  images: Record<string, ImageEntry>
): ParaChild[] {
  const parts = line.split(/(\[\[EQ:[^\]]+\]\]|\[\[IMG:[^\]]+\]\]|\$[^$]+\$)/g).filter((p) => p !== '');
  const runs: ParaChild[] = [];

  for (const part of parts) {
    const imgMatch = part.match(/^\[\[IMG:([^\]]+)\]\]$/);
    if (imgMatch) {
      const entry = images[imgMatch[1]];
      const imgRun = entry ? plainImageRun(entry) : null;
      if (imgRun) {
        runs.push(imgRun);
        continue;
      }
      runs.push(
        new TextRun({
          text: `[hình vẽ #${imgMatch[1]} — không trích được, xem file gốc]`,
          italics: true,
          color: 'A13D3D',
        })
      );
      continue;
    }
    const eqMatch = part.match(/^\[\[EQ:([^\]]+)\]\]$/);
    if (eqMatch) {
      const entry = equations[eqMatch[1]];
      if (entry?.convertible && entry.node) {
        runs.push(new DocxMath({ children: mathNodeToDocxComponents(entry.node) }));
        continue;
      }
      if (entry?.latexFromExternalConverter) {
        // Trước đây in thẳng chuỗi LaTeX ra làm chữ nghiêng (hiện đúng lỗi
        // "\left(...)" trong file Word) — giờ dựng lại thành object công thức
        // Word thật, giống hệt cách công thức gốc (m:oMath) được xử lý, và
        // giống công thức MỚI do AI viết thêm ở nhánh $...$ bên dưới.
        runs.push(new DocxMath({ children: mathNodeToDocxComponents(parseLatexSafe(entry.latexFromExternalConverter)) }));
        continue;
      }
      const imgRun = entry ? equationImageRun(entry) : null;
      if (imgRun) {
        runs.push(imgRun);
        continue;
      }
      runs.push(
        new TextRun({
          text: `[công thức #${eqMatch[1]} — không trích được, xem file gốc]`,
          italics: true,
          color: 'A13D3D',
        })
      );
      continue;
    }
    if (part.startsWith('$') && part.endsWith('$')) {
      // Công thức AI viết thêm (không thuộc file gốc) -> dựng lại thành object
      // công thức Word thật (giống công thức gốc), không ghi thẳng mã LaTeX ra
      // làm chữ nghiêng nữa (đó là nguyên nhân lỗi hiển thị kiểu "\left(...").
      runs.push(new DocxMath({ children: mathNodeToDocxComponents(parseLatexSafe(part.slice(1, -1))) }));
      continue;
    }
    if (part) runs.push(new TextRun({ text: part }));
  }

  return runs;
}

function contentLinesToParagraphs(
  items: ReturnType<typeof parseContentLines>,
  equations: Record<string, EquationEntry>,
  images: Record<string, ImageEntry>
): (Paragraph | Table)[] {
  if (items.length === 0) return [new Paragraph({})];

  const out: (Paragraph | Table)[] = [];
  for (const item of items) {
    if (item.type === 'table') {
      const [header, ...body] = item.rows;
      const colCount = header.length;
      const colWidth = Math.floor(100 / colCount);
      const buildRow = (cells: string[], isHeader: boolean) =>
        new TableRow({
          children: cells.map(
            (cell) =>
              new TableCell({
                width: { size: colWidth, type: WidthType.PERCENTAGE },
                shading: isHeader ? { type: ShadingType.CLEAR, fill: 'E9ECF7' } : undefined,
                children: [new Paragraph({ children: inlineToRuns(cell, equations, images) })],
                margins: { top: 80, bottom: 80, left: 100, right: 100 },
              })
          ),
        });
      out.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [buildRow(header, true), ...body.map((r) => buildRow(r, false))],
        }),
        new Paragraph({})
      );
      continue;
    }
    if (item.type === 'bullet') {
      out.push(new Paragraph({ bullet: { level: 0 }, children: inlineToRuns(item.text, equations, images) }));
      continue;
    }
    out.push(new Paragraph({ children: inlineToRuns(item.text, equations, images) }));
  }
  return out;
}

function textBlockToParagraphs(
  text: string,
  equations: Record<string, EquationEntry>,
  images: Record<string, ImageEntry>
): (Paragraph | Table)[] {
  return contentLinesToParagraphs(parseContentLines(text), equations, images);
}

/**
 * Bảng đã GỘP thêm cột Năng lực số/Hòa nhập trực tiếp vào bảng gốc (thay vì để
 * cạnh thành cột riêng) — dùng khi khối GOC của mục đó vốn đã là một bảng thật
 * (ví dụ "HOẠT ĐỘNG CỦA GV VÀ HS | SẢN PHẨM DỰ KIẾN | NLS"). Nội dung SO/KT
 * dùng `rowSpan` để hiện thành MỘT Ô gộp dọc suốt chiều cao bảng (vì đó là một
 * đoạn văn chung cho cả mục, không tách theo từng dòng bảng gốc).
 */
function buildMergedTable(
  merged: NonNullable<ReturnType<typeof trySectionMerge>>,
  equations: Record<string, EquationEntry>,
  images: Record<string, ImageEntry>
): Table {
  const { headers, rows, soText, ktText } = merged;
  const extraCols = (soText !== null ? 1 : 0) + (ktText !== null ? 1 : 0);
  const totalCols = headers.length + extraCols;
  const colWidth = Math.floor(100 / totalCols);

  const headerRow = new TableRow({
    children: [
      ...headers.map(
        (h) =>
          new TableCell({
            width: { size: colWidth, type: WidthType.PERCENTAGE },
            shading: { type: ShadingType.CLEAR, fill: 'E9ECF7' },
            children: [new Paragraph({ children: inlineToRuns(h, equations, images) })],
            margins: { top: 80, bottom: 80, left: 100, right: 100 },
          })
      ),
      ...(soText !== null
        ? [
            new TableCell({
              width: { size: colWidth, type: WidthType.PERCENTAGE },
              shading: { type: ShadingType.CLEAR, fill: 'DCE6F7' },
              children: [new Paragraph({ children: [new TextRun({ text: 'Năng lực số', bold: true, color: '2F6FA8' })] })],
              margins: { top: 80, bottom: 80, left: 100, right: 100 },
            }),
          ]
        : []),
      ...(ktText !== null
        ? [
            new TableCell({
              width: { size: colWidth, type: WidthType.PERCENTAGE },
              shading: { type: ShadingType.CLEAR, fill: 'F2E2C8' },
              children: [new Paragraph({ children: [new TextRun({ text: 'Giáo dục hòa nhập (HSKT)', bold: true, color: 'B8681A' })] })],
              margins: { top: 80, bottom: 80, left: 100, right: 100 },
            }),
          ]
        : []),
    ],
  });

  const dataRows = rows.map(
    (row, ri) =>
      new TableRow({
        children: [
          ...row.map(
            (cell) =>
              new TableCell({
                width: { size: colWidth, type: WidthType.PERCENTAGE },
                children: [new Paragraph({ children: inlineToRuns(cell, equations, images) })],
                margins: { top: 80, bottom: 80, left: 100, right: 100 },
              })
          ),
          // Cột SO/KT chỉ khai báo Ở DÒNG ĐẦU TIÊN với rowSpan — thư viện `docx`
          // tự hiểu các dòng sau KHÔNG có ô ở vị trí đó (giống demo chính thức
          // của thư viện), không cần khai báo ô rỗng "tiếp nối" cho từng dòng.
          ...(soText !== null && ri === 0
            ? [
                new TableCell({
                  width: { size: colWidth, type: WidthType.PERCENTAGE },
                  shading: { type: ShadingType.CLEAR, fill: 'DCE6F7' },
                  rowSpan: rows.length,
                  children: contentLinesToParagraphs(parseContentLines(soText), equations, images),
                  margins: { top: 80, bottom: 80, left: 100, right: 100 },
                }),
              ]
            : []),
          ...(ktText !== null && ri === 0
            ? [
                new TableCell({
                  width: { size: colWidth, type: WidthType.PERCENTAGE },
                  shading: { type: ShadingType.CLEAR, fill: 'F2E2C8' },
                  rowSpan: rows.length,
                  children: contentLinesToParagraphs(parseContentLines(ktText), equations, images),
                  margins: { top: 80, bottom: 80, left: 100, right: 100 },
                }),
              ]
            : []),
        ],
      })
  );

  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [headerRow, ...dataRows] });
}

/**
 * Xuất KHBD ra file .docx: mỗi mục là một bảng thật với 1-3 cột — cột "gốc"
 * (nguyên văn giáo án, luôn có), cột "năng lực số" và cột "giáo dục hòa nhập"
 * chỉ xuất hiện khi mục đó thực sự có nội dung bổ sung (mỗi loại một cột màu
 * nền riêng, không gộp chung). Công thức Word gốc (Insert Equation) được dựng
 * lại thành object công thức thật; công thức MathType đã chuyển qua máy chủ
 * riêng hiện dạng LaTeX; công thức OLE có ảnh xem trước PNG/JPEG được nhúng
 * lại bằng ảnh thật; công thức MỚI do AI viết thêm (không có trong file gốc)
 * cũng được dựng thành object công thức thật thay vì in nguyên mã LaTeX.
 *
 * headerNote (tự ghi, ví dụ tên trường/tổ chuyên môn) được in thành các dòng
 * căn giữa ở đầu văn bản, trước toàn bộ nội dung KHBD.
 */
export async function exportLessonPlanToDocx(
  markdown: string,
  equations: Record<string, EquationEntry>,
  images: Record<string, ImageEntry>,
  fileName: string,
  headerNote?: string,
  weekNumber?: string,
  durationPeriods?: number
) {
  const blocks = parseKhbd(markdown);
  const children: (Paragraph | Table)[] = [];

  if (headerNote?.trim()) {
    const headerLines = headerNote.split('\n').filter((l) => l.trim());
    headerLines.forEach((line, idx) => {
      children.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: line.trim(), bold: idx === 0, size: idx === 0 ? 24 : 20 })],
          spacing: { after: idx === headerLines.length - 1 ? 240 : 40 },
        })
      );
    });
  }

  // "Tuần thực hiện" + "Số tiết" in ngay dưới tiêu đề bài (heading đầu tiên do
  // AI sinh ra) — không in ở đầu văn bản trước cả tiêu đề, vì đây là hai dòng
  // thông tin đi kèm bài dạy chứ không phải phần header trường/tổ chuyên môn.
  const subtitleParts = [
    weekNumber?.trim() ? `Tuần thực hiện: ${weekNumber.trim()}` : '',
    durationPeriods ? `Số tiết: ${durationPeriods}` : '',
  ].filter(Boolean);
  let subtitleInserted = subtitleParts.length === 0; // không có gì để chèn -> coi như đã xong

  for (const block of blocks) {
    if (block.type === 'heading') {
      const headingLevel = block.level === 1 ? HeadingLevel.HEADING_1 : block.level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3;
      children.push(new Paragraph({ heading: headingLevel, children: inlineToRuns(block.text, equations, images), spacing: { before: 240, after: 120 } }));
      if (!subtitleInserted) {
        children.push(
          new Paragraph({
            children: [new TextRun({ text: subtitleParts.join('   —   '), bold: true, size: 20 })],
            spacing: { after: 200 },
          })
        );
        subtitleInserted = true;
      }
      continue;
    }

    if (block.type === 'text') {
      children.push(new Paragraph({ children: inlineToRuns(block.text, equations, images) }));
      continue;
    }

    // block.type === 'section' -> bảng nhiều cột thật: GOC luôn có, SO/KT tuỳ mục có hay không
    const hasSo = block.so.trim().length > 0;
    const hasKt = block.kt.trim().length > 0;

    const merged = trySectionMerge(block.goc, block.so, block.kt);
    if (merged) {
      if (merged.beforeTable.length > 0) {
        children.push(...contentLinesToParagraphs(merged.beforeTable, equations, images));
      }
      children.push(buildMergedTable(merged, equations, images), new Paragraph({}));
      continue;
    }

    const gocCell = new TableCell({
      width: { size: hasSo && hasKt ? 50 : hasSo || hasKt ? 62 : 100, type: WidthType.PERCENTAGE },
      children: textBlockToParagraphs(block.goc, equations, images),
      margins: { top: 120, bottom: 120, left: 120, right: 120 },
    });

    const otherWidth = hasSo && hasKt ? 25 : 38;
    const soCell = hasSo
      ? new TableCell({
          width: { size: otherWidth, type: WidthType.PERCENTAGE },
          shading: { type: ShadingType.CLEAR, fill: 'DCE6F7' },
          children: [
            new Paragraph({
              children: [new TextRun({ text: 'Năng lực số', bold: true, color: '2F6FA8', size: 18 })],
              spacing: { after: 80 },
            }),
            ...textBlockToParagraphs(block.so, equations, images),
          ],
          margins: { top: 120, bottom: 120, left: 120, right: 120 },
        })
      : null;

    const ktCell = hasKt
      ? new TableCell({
          width: { size: otherWidth, type: WidthType.PERCENTAGE },
          shading: { type: ShadingType.CLEAR, fill: 'F2E2C8' },
          children: [
            new Paragraph({
              children: [new TextRun({ text: 'Giáo dục hòa nhập (HSKT)', bold: true, color: 'B8681A', size: 18 })],
              spacing: { after: 80 },
            }),
            ...textBlockToParagraphs(block.kt, equations, images),
          ],
          margins: { top: 120, bottom: 120, left: 120, right: 120 },
        })
      : null;

    children.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          new TableRow({
            children: [gocCell, soCell, ktCell].filter((c): c is TableCell => c !== null),
          }),
        ],
      }),
      new Paragraph({}) // khoảng cách sau bảng
    );
  }

  const doc = new Document({
    // Đặt font/size mặc định CHO TOÀN BỘ văn bản (Times New Roman 12pt — chuẩn
    // soạn thảo văn bản hành chính/giáo án VN) ở một chỗ duy nhất, thay vì phải
    // set lặp lại `font`/`size` trên từng TextRun rải rác khắp file — mọi đoạn
    // văn/heading không tự khai báo font riêng sẽ tự động thừa hưởng từ đây.
    styles: {
      default: {
        document: {
          run: { font: BODY_FONT, size: BODY_SIZE_HALF_PT },
          paragraph: { spacing: { line: 276, lineRule: 'auto' } }, // ~1.15 dòng, đọc thoáng hơn mặc định
        },
        heading1: {
          run: { font: BODY_FONT, size: 32, bold: true },
          paragraph: { spacing: { before: 240, after: 120 } },
        },
        heading2: {
          run: { font: BODY_FONT, size: 28, bold: true },
          paragraph: { spacing: { before: 200, after: 100 } },
        },
        heading3: {
          run: { font: BODY_FONT, size: 26, bold: true },
          paragraph: { spacing: { before: 160, after: 80 } },
        },
      },
    },
    sections: [
      {
        properties: {
          page: { margin: PAGE_MARGIN },
        },
        children,
      },
    ],
  });
  const blob = await Packer.toBlob(doc);
  saveAs(blob, fileName.endsWith('.docx') ? fileName : `${fileName}.docx`);
}
