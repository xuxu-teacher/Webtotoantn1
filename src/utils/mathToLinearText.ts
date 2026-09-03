import type { MathNode } from '../types';

const NARY_SYMBOL: Record<string, string> = {
  sum: '∑',
  int: '∫',
  prod: '∏',
  union: '⋃',
  intersect: '⋂',
};

/** Chuyển một MathNode thành chuỗi văn bản tuyến tính đơn giản, không mất nội dung. */
export function mathNodeToLinearText(node: MathNode): string {
  switch (node.kind) {
    case 'text':
      return node.value;
    case 'row':
      return node.children.map(mathNodeToLinearText).join('');
    case 'frac':
      return `(${mathNodeToLinearText(node.num)})/(${mathNodeToLinearText(node.den)})`;
    case 'sup':
      return `${mathNodeToLinearText(node.base)}^(${mathNodeToLinearText(node.sup)})`;
    case 'sub':
      return `${mathNodeToLinearText(node.base)}_(${mathNodeToLinearText(node.sub)})`;
    case 'subsup':
      return `${mathNodeToLinearText(node.base)}_(${mathNodeToLinearText(node.sub)})^(${mathNodeToLinearText(node.sup)})`;
    case 'sqrt':
      return node.degree
        ? `root(${mathNodeToLinearText(node.degree)})(${mathNodeToLinearText(node.base)})`
        : `√(${mathNodeToLinearText(node.base)})`;
    case 'delim':
      return `${node.open}${mathNodeToLinearText(node.base)}${node.close}`;
    case 'nary': {
      const sym = NARY_SYMBOL[node.op] || node.op;
      const bounds =
        (node.sub ? `_(${mathNodeToLinearText(node.sub)})` : '') + (node.sup ? `^(${mathNodeToLinearText(node.sup)})` : '');
      return `${sym}${bounds}(${mathNodeToLinearText(node.base)})`;
    }
    case 'func':
      return `${mathNodeToLinearText(node.name)}(${mathNodeToLinearText(node.base)})`;
    case 'bar':
      return node.position === 'top' ? `bar(${mathNodeToLinearText(node.base)})` : `underline(${mathNodeToLinearText(node.base)})`;
    case 'acc':
      return `${mathNodeToLinearText(node.base)}${node.char}`;
    case 'matrix':
      return node.rows.map((row) => row.map(mathNodeToLinearText).join(' ; ')).join(' | ');
    default:
      return '';
  }
}
