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
 * là "Equation..." hoặc chứa "MathType"), Word không lưu dữ liệu công thức
 * nhưng CÓ lưu một ảnh xem trước (<v:imagedata r:id="..."/> trỏ tới file trong
 * word/media/) — ảnh này được trích ra riêng ở bước resolveEquationImages.
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
    const oleNodes = findDeep(node, 'o:OLEObject');
    const isEquation = oleNodes.some((o) => /equation|mathtype/i.test(attrOf(o, 'ProgID') || ''));
    if (!isEquation) return ''; // đối tượng nhúng khác (vd. bảng Excel) — ngoài phạm vi, bỏ qua

    const shapeNode = findDeep(node, 'v:shape')[0];
    const imageDataNode = findDeep(node, 'v:imagedata')[0];
    const imageRelId = imageDataNode && attrOf(imageDataNode, 'r:id');
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
  const inner = children.map((c) => walk(c, ctx)).join('');
  return tag === 'w:p' ? `${inner}\n` : inner;
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

/** Trích ảnh xem trước cho các công thức OLE (dùng __imageRelId tạm gắn lúc walk). */
async function resolveEquationImages(zip: JSZip, equations: Record<string, EquationEntry>) {
  const relsFile = zip.file('word/_rels/document.xml.rels');
  const relsMap = relsFile ? parseRelationships(await relsFile.async('text')) : {};

  for (const eq of Object.values(equations)) {
    const relId = eq.__imageRelId;
    delete eq.__imageRelId;
    if (!relId) continue;

    const target = relsMap[relId];
    if (!target) continue;

    const normalized = target.replace(/^\.?\/?/, '');
    const path = `word/${normalized}`;
    const imgFile = zip.file(path);
    if (!imgFile) continue;

    const ext = (normalized.split('.').pop() || '').toLowerCase();
    const info = IMAGE_MIME_BY_EXT[ext];
    if (!info) continue;

    const base64 = await imgFile.async('base64');
    eq.previewImage = { dataUrl: `data:${info.mime};base64,${base64}`, mime: info.mime, kind: info.kind };
  }
}

/**
 * Phân tích file .docx (giáo án gốc): trích văn bản đúng thứ tự kèm placeholder
 * công thức [[EQ:CTx]], một sổ đăng ký công thức (MathNode + MathML) để hiển thị/
 * xuất file chính xác, và ảnh xem trước cho công thức MathType kiểu OLE cũ.
 */
export async function parseDocxFile(file: File): Promise<ParsedDocument> {
  const arrayBuffer = await file.arrayBuffer();

  // Bản HTML để người dùng đối chiếu trực quan với file gốc (không dùng để gửi AI)
  const htmlResult = await mammoth.convertToHtml({ arrayBuffer });

  const equations: Record<string, EquationEntry> = {};
  let sourceTextWithPlaceholders = '';

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

    await resolveEquationImages(zip, equations);
  }

  const equationCount = Object.keys(equations).length;
  const nonConvertibleEquationCount = Object.values(equations).filter((e) => !e.convertible).length;

  return {
    fileName: file.name,
    sourceTextWithPlaceholders,
    rawHtml: htmlResult.value,
    equations,
    equationCount,
    nonConvertibleEquationCount,
  };
}
