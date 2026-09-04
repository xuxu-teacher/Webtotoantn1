import { MathFraction, MathRadical, MathRoundBrackets, MathRun, MathSubScript, MathSubSuperScript, MathSuperScript } from 'docx';
import { mathNodeToLinearText } from './mathToLinearText';
import type { MathNode } from '../types';

type MathComponent = MathRun | MathFraction | MathSuperScript | MathSubScript | MathSubSuperScript | MathRadical | MathRoundBrackets;

/**
 * Dựng lại object công thức Word (OMML) THẬT từ cây MathNode, dùng API Math của
 * thư viện `docx`. Chỉ các cấu trúc phổ biến (phân số, số mũ, chỉ số dưới, căn,
 * ngoặc tròn) được dựng thành object công thức chuẩn; các cấu trúc phức tạp hơn
 * (nary/tổng-tích phân, ma trận, dấu gạch ngang, dấu mũ accent) được xuất dưới
 * dạng văn bản công thức tuyến tính (linearized) để không mất dữ liệu.
 */
export function mathNodeToDocxComponents(node: MathNode): MathComponent[] {
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
      return [
        ...(node.open ? [new MathRun(node.open)] : []),
        ...mathNodeToDocxComponents(node.base),
        ...(node.close ? [new MathRun(node.close)] : []),
      ];
    // Hệ phương trình / hệ điều kiện (m:eqArr, m:m) -> xếp mỗi dòng trên một
    // hàng riêng trong CÙNG một object công thức, dùng MathRun('\n') để ngắt
    // dòng (thư viện `docx` tự tách '\n' thành <w:br/> lúc xuất) — mỗi dòng
    // vẫn được dựng thành công thức thật (phân số, số mũ... bên trong dòng đó
    // vẫn hiển thị đúng), thay vì gộp tất cả thành một dòng chữ dài khó đọc.
    case 'matrix': {
      const out: MathComponent[] = [];
      node.rows.forEach((row, ri) => {
        if (ri > 0) out.push(new MathRun('\n'));
        row.forEach((cell, ci) => {
          if (ci > 0) out.push(new MathRun('   '));
          out.push(...mathNodeToDocxComponents(cell));
        });
      });
      return out;
    }
    // nary, func, bar, acc: chưa có API tương ứng ổn định trong `docx` ->
    // xuất dạng văn bản tuyến tính, vẫn nằm trong object công thức (font Cambria Math)
    default:
      return [new MathRun(mathNodeToLinearText(node))];
  }
}
