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

/**
 * Duyệt cây XML (preserveOrder) theo đúng thứ tự tài liệu, trả về text với
 * placeholder [[EQ:CTx]] chèn đúng vị trí công thức xuất hiện.
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

  if (tag === 'o:OLEObject') {
    const progId = attrOf(node, 'ProgID') || '';
    if (/equation|mathtype/i.test(progId)) {
      const id = `CT${++ctx.counter.n}`;
      ctx.equations[id] = { id, node: null, mathml: '', convertible: false };
      return `[[EQ:${id}]]`;
    }
    return '';
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

/**
 * Phân tích file .docx (giáo án gốc): trích văn bản đúng thứ tự kèm placeholder
 * công thức [[EQ:CTx]], và một sổ đăng ký công thức (MathNode + MathML) để hiển
 * thị/xuất file chính xác về sau — thay vì AI phải "đọc lại" công thức bằng LaTeX.
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
