import { MathFraction, MathRadical, MathRoundBrackets, MathRun, MathSubScript, MathSubSuperScript, MathSuperScript } from 'docx';
import type { MathNode } from '../types';

/**
 * Dựng lại object công thức Word (OMML) THẬT từ cây MathNode, dùng API Math của
 * thư viện `docx`. Chỉ các cấu trúc phổ biến (phân số, số mũ, chỉ số dưới, căn,
 * ngoặc tròn) được dựng thành object công thức chuẩn; các cấu trúc phức tạp hơn
 * (nary/tổng-tích phân, ma trận, dấu gạch ngang, dấu mũ accent) được xuất dưới
 * dạng văn bản công thức tuyến tính (linearized) để không mất dữ liệu, dù không
 * phải là object công thức "sống" mà giáo viên có thể bấm sửa từng phần như bình
 * thường trong Word.
 */

const NARY_SYMBOL: Record<string, string> = {
  sum: '∑',
  int: '∫',
  prod: '∏',
  union: '⋃',
  intersect: '⋂',
};

function linearize(node: MathNode): string {
  switch (node.kind) {
    case 'text':
      return node.value;
    case 'row':
      return node.children.map(linearize).join('');
    case 'frac':
      return `(${linearize(node.num)})/(${linearize(node.den)})`;
    case 'sup':
      return `${linearize(node.base)}^(${linearize(node.sup)})`;
    case 'sub':
      return `${linearize(node.base)}_(${linearize(node.sub)})`;
    case 'subsup':
      return `${linearize(node.base)}_(${linearize(node.sub)})^(${linearize(node.sup)})`;
    case 'sqrt':
      return node.degree ? `root(${linearize(node.degree)})(${linearize(node.base)})` : `√(${linearize(node.base)})`;
    case 'delim':
      return `${node.open}${linearize(node.base)}${node.close}`;
    case 'nary': {
      const sym = NARY_SYMBOL[node.op] || node.op;
      const bounds = (node.sub ? `_(${linearize(node.sub)})` : '') + (node.sup ? `^(${linearize(node.sup)})` : '');
      return `${sym}${bounds}(${linearize(node.base)})`;
    }
    case 'func':
      return `${linearize(node.name)}(${linearize(node.base)})`;
    case 'bar':
      return node.position === 'top' ? `bar(${linearize(node.base)})` : `underline(${linearize(node.base)})`;
    case 'acc':
      return `${linearize(node.base)}${node.char}`;
    case 'matrix':
      return node.rows.map((row) => row.map(linearize).join(' ; ')).join(' | ');
    default:
      return '';
  }
}

/** Trả về mảng các "math component" (con của <m:Math>) từ một MathNode. */
export function mathNodeToDocxComponents(node: MathNode): (MathRun | MathFraction | MathSuperScript | MathSubScript | MathSubSuperScript | MathRadical | MathRoundBrackets)[] {
  switch (node.kind) {
    case 'text':
      return node.value ? [new MathRun(node.value)] : [];
    case 'row':
      return node.children.flatMap(mathNodeToDocxComponents);
    case 'frac':
      return [
        new MathFraction({
          numerator: mathNodeToDocxComponents(node.num),
          denominator: mathNodeToDocxComponents(node.den),
        }),
      ];
    case 'sup':
      return [
        new MathSuperScript({
          children: mathNodeToDocxComponents(node.base),
          superScript: mathNodeToDocxComponents(node.sup),
        }),
      ];
    case 'sub':
      return [
        new MathSubScript({
          children: mathNodeToDocxComponents(node.base),
          subScript: mathNodeToDocxComponents(node.sub),
        }),
      ];
    case 'subsup':
      return [
        new MathSubSuperScript({
          children: mathNodeToDocxComponents(node.base),
          subScript: mathNodeToDocxComponents(node.sub),
          superScript: mathNodeToDocxComponents(node.sup),
        }),
      ];
    case 'sqrt':
      return [
        new MathRadical({
          children: mathNodeToDocxComponents(node.base),
          degree: node.degree ? mathNodeToDocxComponents(node.degree) : undefined,
        }),
      ];
    case 'delim':
      if (node.open === '(' && node.close === ')') {
        return [new MathRoundBrackets({ children: mathNodeToDocxComponents(node.base) })];
      }
      return [new MathRun(node.open), ...mathNodeToDocxComponents(node.base), new MathRun(node.close)];
    // nary, func, bar, acc, matrix: chưa có API tương ứng ổn định trong `docx` ->
    // xuất dạng văn bản tuyến tính, vẫn nằm trong object công thức (font Cambria Math)
    default:
      return [new MathRun(linearize(node))];
  }
}
