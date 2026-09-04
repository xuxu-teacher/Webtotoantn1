import type { MathNode } from '../types';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const NARY_MML: Record<string, string> = {
  sum: '&#8721;',
  int: '&#8747;',
  prod: '&#8719;',
  union: '&#8899;',
  intersect: '&#8898;',
};

function toMml(node: MathNode): string {
  switch (node.kind) {
    case 'text': {
      const v = node.value;
      // Số thì <mn>, biến/chữ đơn thì <mi>, toán tử phổ biến thì <mo>, còn lại <mtext>
      if (/^-?\d+(\.\d+)?$/.test(v.trim())) return `<mn>${esc(v)}</mn>`;
      if (/^[+\-=<>≤≥≠×÷±]$/.test(v.trim())) return `<mo>${esc(v)}</mo>`;
      if (/^[a-zA-Zα-ωΑ-Ω]$/.test(v.trim())) return `<mi>${esc(v)}</mi>`;
      return `<mtext>${esc(v)}</mtext>`;
    }
    case 'row':
      return `<mrow>${node.children.map(toMml).join('')}</mrow>`;
    case 'frac':
      return `<mfrac>${toMml(node.num)}${toMml(node.den)}</mfrac>`;
    case 'sup':
      return `<msup>${toMml(node.base)}${toMml(node.sup)}</msup>`;
    case 'sub':
      return `<msub>${toMml(node.base)}${toMml(node.sub)}</msub>`;
    case 'subsup':
      return `<msubsup>${toMml(node.base)}${toMml(node.sub)}${toMml(node.sup)}</msubsup>`;
    case 'sqrt':
      return node.degree ? `<mroot>${toMml(node.base)}${toMml(node.degree)}</mroot>` : `<msqrt>${toMml(node.base)}</msqrt>`;
    case 'delim':
      return `<mrow>${node.open ? `<mo>${esc(node.open)}</mo>` : ''}${toMml(node.base)}${node.close ? `<mo>${esc(node.close)}</mo>` : ''}</mrow>`;
    case 'nary': {
      const opMml = `<mo>${NARY_MML[node.op] || esc(node.op)}</mo>`;
      if (node.sub && node.sup) {
        return `<mrow><munderover>${opMml}${toMml(node.sub)}${toMml(node.sup)}</munderover>${toMml(node.base)}</mrow>`;
      }
      if (node.sub) {
        return `<mrow><munder>${opMml}${toMml(node.sub)}</munder>${toMml(node.base)}</mrow>`;
      }
      return `<mrow>${opMml}${toMml(node.base)}</mrow>`;
    }
    case 'func':
      return `<mrow>${toMml(node.name)}<mo>&#8289;</mo>${toMml(node.base)}</mrow>`;
    case 'bar':
      return node.position === 'top'
        ? `<mover>${toMml(node.base)}<mo>&#175;</mo></mover>`
        : `<munder>${toMml(node.base)}<mo>&#818;</mo></munder>`;
    case 'acc':
      return `<mover>${toMml(node.base)}<mo>${esc(node.char)}</mo></mover>`;
    case 'matrix':
      return `<mtable>${node.rows
        .map((row) => `<mtr>${row.map((cell) => `<mtd>${toMml(cell)}</mtd>`).join('')}</mtr>`)
        .join('')}</mtable>`;
    default:
      return '';
  }
}

/** Trả về chuỗi <math>...</math> hoàn chỉnh, sẵn sàng cho MathJax (input mml). */
export function mathNodeToMathml(node: MathNode): string {
  return `<math xmlns="http://www.w3.org/1998/Math/MathML">${toMml(node)}</math>`;
}
