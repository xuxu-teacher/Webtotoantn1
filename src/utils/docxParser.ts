import mammoth from 'mammoth';
import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import { parseOMathToNode } from './ommlAst';
import { mathNodeToMathml } from './mathToMathml';
import type { EquationEntry, ImageEntry, ParsedDocument } from '../types';

type XNode = Record<string, any>;

function tagOf(node: XNode): string | null {
  for (const key of Object.keys(node)) {
    if (key !== ':@') return key;
  }
  return null;
}

function childrenOf(node: XNode): XNode[] {
  const tag = tagOf(node);
  if (!tag) return [];
  const val = node[tag];
  return Array.isArray(val) ? val : [];
}

function attrOf(node: XNode, name: string): string | undefined {
  const attrs = node[':@'];
  if (!attrs) return undefined;
  return attrs[`@_${name}`];
}

function findDeep(node: XNode, tag: string, results: XNode[] = []): XNode[] {
  if (tagOf(node) === tag) results.push(node);
  for (const child of childrenOf(node)) findDeep(child, tag, results);
  return results;
}

interface WalkCtx {
  equations: Record<string, EquationEntry>;
  images: Record<string, ImageEntry>;
  counter: { n: number };
  imgCounter: { n: number };
  /** Tiêu đề gợi ý, lấy từ đoạn văn đầu tiên có style Title/Heading (nếu có). */
  headingTitle?: string;
}

/** 1pt = 12700 EMU (đơn vị mà <wp:extent cx="..." cy="..."/> dùng). */
const EMU_PER_PT = 12700;

const IMAGE_MIME_BY_EXT: Record<string, { mime: string; kind: 'raster' | 'vector_legacy' }> = {
  png: { mime: 'image/png', kind: 'raster' },
  jpg: { mime: 'image/jpeg', kind: 'raster' },
  jpeg: { mime: 'image/jpeg', kind: 'raster' },
  gif: { mime: 'image/gif', kind: 'raster' },
  bmp: { mime: 'image/bmp', kind: 'raster' },
  wmf: { mime: 'image/wmf', kind: 'vector_legacy' },
  emf: { mime: 'image/emf', kind: 'vector_legacy' },
};

/**
 * Duyệt cây XML (preserveOrder) theo đúng thứ tự tài liệu, trả về text với
 * placeholder [[EQ:CTx]] chèn đúng vị trí công thức xuất hiện.
 *
 * Với công thức MathType kiểu OLE cũ (<w:object> chứa <o:OLEObject> có ProgID
 * là "Equation..." hoặc chứa "MathType"), Word không lưu dữ liệu công thức dạng
 * text, nhưng CÓ lưu:
 *   - Ảnh xem trước: <v:imagedata r:id="..."/> -> word/media/...
 *   - Dữ liệu OLE gốc (chứa MTEF nhị phân — dữ liệu ĐÚNG để gửi máy chủ
 *     MathType→LaTeX): chính <o:OLEObject r:id="..."/> -> word/embeddings/...bin
 * Cả hai được trích ở bước resolveEquationAssets.
 */
function walk(node: XNode, ctx: WalkCtx): string {
  const tag = tagOf(node);

  if (tag === 'm:oMath') {
    const id = `CT${++ctx.counter.n}`;
    try {
      const mathNode = parseOMathToNode(node);
      ctx.equations[id] = { id, node: mathNode, mathml: mathNodeToMathml(mathNode), convertible: true };
    } catch {
      ctx.equations[id] = { id, node: null, mathml: '', convertible: false };
    }
    return `[[EQ:${id}]]`;
  }

  if (tag === 'w:object') {
    const oleNode = findDeep(node, 'o:OLEObject')[0];
    const isEquation = oleNode && /equation|mathtype/i.test(attrOf(oleNode, 'ProgID') || '');
    if (!isEquation) return ''; // đối tượng nhúng khác (vd. bảng Excel) — ngoài phạm vi, bỏ qua

    const shapeNode = findDeep(node, 'v:shape')[0];
    const imageDataNode = findDeep(node, 'v:imagedata')[0];
    const imageRelId = imageDataNode && attrOf(imageDataNode, 'r:id');
    const oleRelId = attrOf(oleNode, 'r:id');
    const style = shapeNode && attrOf(shapeNode, 'style');
    const wMatch = style?.match(/width:([\d.]+)pt/);
    const hMatch = style?.match(/height:([\d.]+)pt/);

    const id = `CT${++ctx.counter.n}`;
    ctx.equations[id] = {
      id,
      node: null,
      mathml: '',
      convertible: false,
      sizePt: wMatch && hMatch ? { width: parseFloat(wMatch[1]), height: parseFloat(hMatch[1]) } : undefined,
      __imageRelId: imageRelId,
      __oleRelId: oleRelId,
    };
    return `[[EQ:${id}]]`;
  }

  if (tag === 'w:drawing') {
    // Hình vẽ/ảnh chèn bằng "Insert > Pictures" (không phải công thức) — cấu trúc
    // DrawingML chuẩn: w:drawing > wp:inline|wp:anchor > a:graphic > a:graphicData
    // > pic:pic > pic:blipFill > a:blip (r:embed = id ảnh trong word/media/...),
    // kèm wp:extent (cx/cy đơn vị EMU) cho kích thước hiển thị trong Word.
    const blipNode = findDeep(node, 'a:blip')[0];
    const relId = blipNode && attrOf(blipNode, 'r:embed');
    if (!relId) return ''; // không tìm được ảnh nhúng (vd. hình vẽ SmartArt/shape thuần) — ngoài phạm vi, bỏ qua

    const extentNode = findDeep(node, 'wp:extent')[0];
    const cx = extentNode && Number(attrOf(extentNode, 'cx'));
    const cy = extentNode && Number(attrOf(extentNode, 'cy'));

    const id = `IMG${++ctx.imgCounter.n}`;
    ctx.images[id] = {
      id,
      dataUrl: '',
      mime: '',
      kind: 'raster',
      sizePt: cx && cy ? { width: cx / EMU_PER_PT, height: cy / EMU_PER_PT } : undefined,
      __relId: relId,
    };
    return `[[IMG:${id}]]`;
  }

  if (tag === 'w:t') {
    return childrenOf(node)
      .map((c) => ('#text' in c ? String(c['#text']) : ''))
      .join('');
  }

  if (tag === 'w:tab') return '\t';
  if (tag === 'w:br' || tag === 'w:cr') return '\n';

  if (tag === 'w:tbl') {
    return renderTableAsMarkdown(node, ctx);
  }

  const children = childrenOf(node);

  if (tag === 'w:p') {
    const inner = children.map((c) => walk(c, ctx)).join('');
    if (!ctx.headingTitle) {
      const pStyle = findDeep(node, 'w:pStyle')[0];
      const styleVal = pStyle && attrOf(pStyle, 'val');
      const plain = inner.replace(/\[\[EQ:[^\]]+\]\]/g, '').trim();
      if (styleVal && /^(Title|Heading ?1?)$/i.test(styleVal) && plain.length >= 3 && plain.length <= 150) {
        ctx.headingTitle = plain;
      }
    }
    return `${inner}\n`;
  }

  return children.map((c) => walk(c, ctx)).join('');
}

/**
 * Nhiều giáo án Việt Nam trình bày sẵn dạng BẢNG THẬT trong Word (ví dụ 3 cột
 * "HOẠT ĐỘNG CỦA GV VÀ HS" | "SẢN PHẨM DỰ KIẾN" | "NLS"). Trước đây app chỉ đọc
 * text tuần tự nên một bảng 3 cột bị "làm phẳng" thành các đoạn văn nối tiếp,
 * MẤT HẲN ranh giới cột — đây là lý do "file gốc 3 cột mà lên web chỉ còn 1
 * cột". Hàm này dựng lại bảng gốc thành cú pháp bảng Markdown (| ô 1 | ô 2 |),
 * giữ đúng số cột/số dòng, để:
 *   1) Gửi cho AI dưới dạng văn bản mà AI hiểu đúng đây là một bảng nhiều cột
 *      và phải TÁI TẠO Y NGUYÊN (xem quy tắc trong api/generate.ts).
 *   2) Được nhận diện lại ở markdownTable.ts và render/xuất thành bảng thật
 *      (không phải đoạn văn) cả ở bản xem trước lẫn file Word xuất ra.
 */
function renderTableAsMarkdown(tblNode: XNode, ctx: WalkCtx): string {
  const rows = childrenOf(tblNode).filter((c) => tagOf(c) === 'w:tr');
  if (rows.length === 0) return '';

  const rowCells: string[][] = rows.map((tr) => {
    const cells = childrenOf(tr).filter((c) => tagOf(c) === 'w:tc');
    return cells.map((tc) => {
      const raw = childrenOf(tc)
        .map((c) => walk(c, ctx))
        .join('')
        .replace(/\n+/g, ' ') // Markdown table: mỗi ô chỉ được nằm trên 1 dòng
        .replace(/\|/g, '\\|') // tránh dấu | trong nội dung phá vỡ cú pháp bảng
        .trim();
      return raw;
    });
  });

  const colCount = Math.max(...rowCells.map((r) => r.length), 1);
  const pad = (r: string[]) => {
    const padded = [...r];
    while (padded.length < colCount) padded.push('');
    return padded;
  };

  const lines = [
    `| ${pad(rowCells[0]).join(' | ')} |`,
    `| ${Array(colCount).fill('---').join(' | ')} |`,
    ...rowCells.slice(1).map((r) => `| ${pad(r).join(' | ')} |`),
  ];
  return lines.join('\n') + '\n';
}

/** Đọc word/_rels/document.xml.rels -> map relationship Id -> đường dẫn file trong zip. */
function parseRelationships(relsXml: string): Record<string, string> {
  const map: Record<string, string> = {};
  const tagRegex = /<Relationship\b[^>]*\/?>/g;
  for (const tag of relsXml.match(tagRegex) || []) {
    const id = tag.match(/Id="([^"]+)"/)?.[1];
    const target = tag.match(/Target="([^"]+)"/)?.[1];
    if (id && target) map[id] = target;
  }
  return map;
}

/** Trích ảnh xem trước + dữ liệu OLE gốc cho các công thức OLE (dùng __imageRelId/__oleRelId tạm gắn lúc walk). */
async function resolveEquationAssets(zip: JSZip, equations: Record<string, EquationEntry>) {
  const relsFile = zip.file('word/_rels/document.xml.rels');
  const relsMap = relsFile ? parseRelationships(await relsFile.async('text')) : {};

  for (const eq of Object.values(equations)) {
    const imageRelId = eq.__imageRelId;
    const oleRelId = eq.__oleRelId;
    delete eq.__imageRelId;
    delete eq.__oleRelId;

    if (imageRelId) {
      const target = relsMap[imageRelId];
      if (target) {
        const path = `word/${target.replace(/^\.?\/?/, '')}`;
        const imgFile = zip.file(path);
        const ext = (target.split('.').pop() || '').toLowerCase();
        const info = IMAGE_MIME_BY_EXT[ext];
        if (imgFile && info) {
          const base64 = await imgFile.async('base64');
          eq.previewImage = { dataUrl: `data:${info.mime};base64,${base64}`, mime: info.mime, kind: info.kind };
        }
      }
    }

    if (oleRelId) {
      const target = relsMap[oleRelId];
      if (target) {
        const path = `word/${target.replace(/^\.?\/?/, '')}`;
        const binFile = zip.file(path);
        if (binFile) {
          eq.oleObjectBase64 = await binFile.async('base64');
        }
      }
    }
  }
}

/** Trích dữ liệu ảnh thật (base64) cho các hình vẽ/ảnh minh hoạ, dùng __relId tạm gắn lúc walk(). */
async function resolveImageAssets(zip: JSZip, images: Record<string, ImageEntry>) {
  const relsFile = zip.file('word/_rels/document.xml.rels');
  const relsMap = relsFile ? parseRelationships(await relsFile.async('text')) : {};

  for (const img of Object.values(images)) {
    const relId = img.__relId;
    delete img.__relId;
    if (!relId) continue;

    const target = relsMap[relId];
    if (!target) continue;

    const path = `word/${target.replace(/^\.?\/?/, '')}`;
    const imgFile = zip.file(path);
    const ext = (target.split('.').pop() || '').toLowerCase();
    const info = IMAGE_MIME_BY_EXT[ext];
    if (imgFile && info) {
      const base64 = await imgFile.async('base64');
      img.dataUrl = `data:${info.mime};base64,${base64}`;
      img.mime = info.mime;
      img.kind = info.kind;
    }
  }

  // Ảnh không trích được dữ liệu (định dạng lạ/không tìm thấy file) -> loại khỏi
  // sổ đăng ký, để lúc hiển thị/xuất Word hiện đúng "không trích được" thay vì
  // một ảnh rỗng.
  for (const [id, img] of Object.entries(images)) {
    if (!img.dataUrl) delete images[id];
  }
}

/** Dò tên bài từ vài dòng đầu (mẫu "BÀI ...", "CHỦ ĐỀ ...", "CHUYÊN ĐỀ ..."). */
function findTitleLineInText(text: string): string | undefined {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 25);
  const match = lines.find((l) => /^(BÀI|CHỦ ĐỀ|CHUYÊN ĐỀ)\b/iu.test(l) && l.length <= 150);
  return match;
}

/** Suy ra tên bài từ tên file khi không tìm được trong nội dung (bỏ mã số/hậu tố viết tắt). */
function suggestTitleFromFilename(fileName: string): string {
  let base = fileName.replace(/\.docx$/i, '').replace(/_/g, ' ');
  const tokens = base.split(/\s+/).filter(Boolean);

  let startIdx = tokens.findIndex((t) => /^(BÀI|CHỦ|CHUYÊN)/iu.test(t));
  if (startIdx === -1) startIdx = tokens.findIndex((t) => /^\p{Lu}\p{Ll}{3,}/u.test(t));
  if (startIdx === -1) startIdx = 0;

  const kept = tokens.slice(startIdx);
  while (kept.length > 1 && /^\p{Lu}{2,6}$/u.test(kept[kept.length - 1])) kept.pop();

  const result = kept.join(' ').trim();
  return result || base.trim();
}

/**
 * Phân tích file .docx (giáo án gốc): trích văn bản đúng thứ tự kèm placeholder
 * công thức [[EQ:CTx]], sổ đăng ký công thức (MathNode/MathML/ảnh/dữ liệu OLE gốc),
 * và tên bài gợi ý để tự điền vào form.
 */
export async function parseDocxFile(file: File): Promise<ParsedDocument> {
  const arrayBuffer = await file.arrayBuffer();

  // Bản HTML để người dùng đối chiếu trực quan với file gốc (không dùng để gửi AI)
  const htmlResult = await mammoth.convertToHtml({ arrayBuffer });

  const equations: Record<string, EquationEntry> = {};
  const images: Record<string, ImageEntry> = {};
  let sourceTextWithPlaceholders = '';
  let headingTitle: string | undefined;

  const zip = await JSZip.loadAsync(arrayBuffer);
  const docXmlFile = zip.file('word/document.xml');
  if (docXmlFile) {
    const xml = await docXmlFile.async('text');
    const parser = new XMLParser({ ignoreAttributes: false, preserveOrder: true, trimValues: false });
    const parsed: XNode[] = parser.parse(xml);

    const documentNode = findDeep({ root: parsed } as any, 'w:document')[0];
    const bodyNode = documentNode && findDeep(documentNode, 'w:body')[0];
    const ctx: WalkCtx = { equations, images, counter: { n: 0 }, imgCounter: { n: 0 } };

    if (bodyNode) {
      sourceTextWithPlaceholders = childrenOf(bodyNode)
        .map((c) => walk(c, ctx))
        .join('')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }

    headingTitle = ctx.headingTitle;
    await resolveEquationAssets(zip, equations);
    await resolveImageAssets(zip, images);
  }

  const equationCount = Object.keys(equations).length;
  const nonConvertibleEquationCount = Object.values(equations).filter((e) => !e.convertible).length;

  const suggestedTitle =
    headingTitle || findTitleLineInText(sourceTextWithPlaceholders) || suggestTitleFromFilename(file.name);

  return {
    fileName: file.name,
    sourceTextWithPlaceholders,
    rawHtml: htmlResult.value,
    equations,
    equationCount,
    nonConvertibleEquationCount,
    images,
    suggestedTitle,
  };
}
