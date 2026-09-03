import mammoth from 'mammoth';
import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import { parseOMathToNode } from './ommlAst';
import { mathNodeToMathml } from './mathToMathml';
import type { EquationEntry, ParsedDocument } from '../types';

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
  counter: { n: number };
  /** Tiêu đề gợi ý, lấy từ đoạn văn đầu tiên có style Title/Heading (nếu có). */
  headingTitle?: string;
}

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

  if (tag === 'w:t') {
    return childrenOf(node)
      .map((c) => ('#text' in c ? String(c['#text']) : ''))
      .join('');
  }

  if (tag === 'w:tab') return '\t';
  if (tag === 'w:br' || tag === 'w:cr') return '\n';

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
    const ctx: WalkCtx = { equations, counter: { n: 0 } };

    if (bodyNode) {
      sourceTextWithPlaceholders = childrenOf(bodyNode)
        .map((c) => walk(c, ctx))
        .join('')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }

    headingTitle = ctx.headingTitle;
    await resolveEquationAssets(zip, equations);
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
    suggestedTitle,
  };
}
