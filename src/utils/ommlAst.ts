import type { MathNode } from '../types';

/**
 * Làm việc với cây XML dạng preserveOrder của fast-xml-parser:
 * mỗi node là { [tagName]: children[], ':@'?: {attrs} } hoặc { '#text': string }.
 * Dạng này giữ đúng THỨ TỰ các phần tử con — quan trọng vì OMML là nội dung hỗn hợp
 * (chữ thường xen với phân số, số mũ... theo đúng vị trí xuất hiện).
 */
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

function findChild(children: XNode[], tag: string): XNode | undefined {
  return children.find((c) => tagOf(c) === tag);
}

function findAllChildren(children: XNode[], tag: string): XNode[] {
  return children.filter((c) => tagOf(c) === tag);
}

/** m:e wrapper: lấy children thật bên trong, hoặc coi chính node này là nội dung nếu không có wrapper. */
function unwrapE(children: XNode[], tag = 'm:e'): XNode[] {
  const e = findChild(children, tag);
  return e ? childrenOf(e) : [];
}

/** Chuyển một dãy phần tử con (đã giữ thứ tự) thành một MathNode (row nếu nhiều phần tử). */
function seqToNode(children: XNode[]): MathNode {
  const parts: MathNode[] = [];
  let textBuffer = '';

  const flush = () => {
    if (textBuffer) {
      parts.push({ kind: 'text', value: textBuffer });
      textBuffer = '';
    }
  };

  for (const child of children) {
    const tag = tagOf(child);
    if (tag === 'm:r') {
      // run văn bản: lấy toàn bộ text lồng bên trong (thường là một hoặc nhiều m:t)
      textBuffer += flattenText(child);
    } else if (tag) {
      flush();
      const node = elementToNode(tag, child);
      if (node) parts.push(node);
    }
    // '#text' rời rạc (hiếm gặp trực tiếp trong OMML) bị bỏ qua có chủ đích
  }
  flush();

  if (parts.length === 0) return { kind: 'text', value: '' };
  if (parts.length === 1) return parts[0];
  return { kind: 'row', children: parts };
}

/** Lấy toàn bộ text thô lồng bên trong một node bất kỳ (fallback an toàn, không mất dữ liệu). */
function flattenText(node: XNode): string {
  const children = childrenOf(node);
  return children
    .map((c) => {
      if ('#text' in c) return String(c['#text']);
      return flattenText(c);
    })
    .join('');
}

const NARY_CHAR_MAP: Record<string, string> = {
  '∑': 'sum',
  '∫': 'int',
  '∏': 'prod',
  '⋃': 'union',
  '⋂': 'intersect',
};

function elementToNode(tag: string, node: XNode): MathNode | null {
  const children = childrenOf(node);

  switch (tag) {
    case 'm:f': {
      const num = seqToNode(unwrapE(children, 'm:num'));
      const den = seqToNode(unwrapE(children, 'm:den'));
      return { kind: 'frac', num, den };
    }
    case 'm:rad': {
      const degChildren = unwrapE(children, 'm:deg');
      const base = seqToNode(unwrapE(children, 'm:e'));
      const degree = degChildren.length ? seqToNode(degChildren) : undefined;
      return { kind: 'sqrt', base, degree };
    }
    case 'm:sSup': {
      const base = seqToNode(unwrapE(children, 'm:e'));
      const sup = seqToNode(unwrapE(children, 'm:sup'));
      return { kind: 'sup', base, sup };
    }
    case 'm:sSub': {
      const base = seqToNode(unwrapE(children, 'm:e'));
      const sub = seqToNode(unwrapE(children, 'm:sub'));
      return { kind: 'sub', base, sub };
    }
    case 'm:sSubSup': {
      const base = seqToNode(unwrapE(children, 'm:e'));
      const sub = seqToNode(unwrapE(children, 'm:sub'));
      const sup = seqToNode(unwrapE(children, 'm:sup'));
      return { kind: 'subsup', base, sub, sup };
    }
    case 'm:d': {
      const dPr = findChild(children, 'm:dPr');
      const open = (dPr && attrOf(findChild(childrenOf(dPr), 'm:begChr') || {}, 'val')) || '(';
      const close = (dPr && attrOf(findChild(childrenOf(dPr), 'm:endChr') || {}, 'val')) || ')';
      const eNodes = findAllChildren(children, 'm:e');
      const inner: MathNode =
        eNodes.length > 1
          ? { kind: 'row', children: eNodes.map((e) => seqToNode(childrenOf(e))) }
          : seqToNode(unwrapE(children, 'm:e'));
      return { kind: 'delim', open, close, base: inner };
    }
    case 'm:nary': {
      const naryPr = findChild(children, 'm:naryPr');
      const chr = naryPr && findChild(childrenOf(naryPr), 'm:chr');
      const opChar = (chr && attrOf(chr, 'val')) || '∑';
      const sub = unwrapE(children, 'm:sub').length ? seqToNode(unwrapE(children, 'm:sub')) : undefined;
      const sup = unwrapE(children, 'm:sup').length ? seqToNode(unwrapE(children, 'm:sup')) : undefined;
      const base = seqToNode(unwrapE(children, 'm:e'));
      return { kind: 'nary', op: NARY_CHAR_MAP[opChar] || opChar, sub, sup, base };
    }
    case 'm:func': {
      const name = seqToNode(unwrapE(children, 'm:fName'));
      const base = seqToNode(unwrapE(children, 'm:e'));
      return { kind: 'func', name, base };
    }
    case 'm:bar': {
      const barPr = findChild(children, 'm:barPr');
      const pos = (barPr && attrOf(findChild(childrenOf(barPr), 'm:pos') || {}, 'val')) || 'top';
      const base = seqToNode(unwrapE(children, 'm:e'));
      return { kind: 'bar', base, position: pos === 'bot' ? 'bottom' : 'top' };
    }
    case 'm:acc': {
      const accPr = findChild(children, 'm:accPr');
      const chr = accPr && findChild(childrenOf(accPr), 'm:chr');
      const char = (chr && attrOf(chr, 'val')) || '^';
      const base = seqToNode(unwrapE(children, 'm:e'));
      return { kind: 'acc', base, char };
    }
    case 'm:m': {
      const rows = findAllChildren(children, 'm:mr').map((mr) =>
        findAllChildren(childrenOf(mr), 'm:e').map((e) => seqToNode(childrenOf(e)))
      );
      return { kind: 'matrix', rows };
    }
    case 'm:eqArr': {
      const rows = findAllChildren(children, 'm:e').map((e) => [seqToNode(childrenOf(e))]);
      return { kind: 'matrix', rows };
    }
    default:
      return null;
  }
}

/** Điểm vào: nhận node XML của <m:oMath> (dạng preserveOrder), trả về cây MathNode. */
export function parseOMathToNode(oMathNode: XNode): MathNode {
  return seqToNode(childrenOf(oMathNode));
}
