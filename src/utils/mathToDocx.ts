import {
  MathAngledBrackets,
  MathCurlyBrackets,
  MathFraction,
  MathFunction,
  MathRadical,
  MathRoundBrackets,
  MathRun,
  MathSquareBrackets,
  MathSubScript,
  MathSubSuperScript,
  MathSum,
  MathSuperScript,
} from 'docx';
import { mathNodeToLinearText } from './mathToLinearText';
import type { MathNode } from '../types';

type MathComponent =
  | MathRun
  | MathFraction
  | MathSuperScript
  | MathSubScript
  | MathSubSuperScript
  | MathRadical
  | MathRoundBrackets
  | MathSquareBrackets
  | MathCurlyBrackets
  | MathAngledBrackets
  | MathFunction
  | MathSum;

/**
 * Dựng lại object công thức Word (OMML) THẬT từ cây MathNode, dùng API Math của
 * thư viện `docx`. Ngoài các cấu trúc cơ bản (phân số, số mũ, chỉ số dưới, căn),
 * giờ còn dựng đúng loại ngoặc thật (tròn/vuông/nhọn/nhọn-đôi — bấm sửa được
 * như ngoặc Word thật, tự giãn theo chiều cao nội dung bên trong) và hàm số
 * (m:func — tên hàm + đối số TÁCH RIÊNG, đúng chuẩn thay vì gộp thành chữ).
 * Các cấu trúc hiếm gặp hơn (tích phân/tích, ma trận 2D thật, dấu gạch ngang,
 * dấu mũ accent) vẫn xuất dạng văn bản tuyến tính vì `docx` chưa có API ổn
 * định tương ứng — không mất dữ liệu, chỉ là chưa "bấm sửa từng phần" được.
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
    case 'func':
      // m:func thật: tên hàm (vd "sin", "cos", "f") và đối số là hai vùng
      // TÁCH RIÊNG có thể bấm sửa độc lập — đúng chuẩn Word, không phải chữ
      // ghép "sin(x)" như trước.
      return [
        new MathFunction({
          name: mathNodeToDocxComponents(node.name),
          children: mathNodeToDocxComponents(node.base),
        }),
      ];
    case 'delim': {
      const pair = `${node.open}${node.close}`;
      if (pair === '()') return [new MathRoundBrackets({ children: mathNodeToDocxComponents(node.base) })];
      if (pair === '[]') return [new MathSquareBrackets({ children: mathNodeToDocxComponents(node.base) })];
      if (pair === '{}') return [new MathCurlyBrackets({ children: mathNodeToDocxComponents(node.base) })];
      if (pair === '<>') return [new MathAngledBrackets({ children: mathNodeToDocxComponents(node.base) })];
      // Ngoặc không đối xứng (vd chỉ có "{" mở, không đóng — cách Word biểu
      // diễn hệ phương trình/hệ điều kiện) -> không có class ngoặc thật tương
      // ứng, ghép thủ công bằng ký tự để không mất dấu ngoặc gốc.
      return [
        ...(node.open ? [new MathRun(node.open)] : []),
        ...mathNodeToDocxComponents(node.base),
        ...(node.close ? [new MathRun(node.close)] : []),
      ];
    }
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
    case 'nary':
      // MathSum (m:nary với ký tự ∑) là loại duy nhất `docx` có API riêng ổn
      // định; các toán tử nary khác (tích phân, tích, hợp, giao) vẫn xuất dạng
      // văn bản tuyến tính (nhánh default bên dưới) để tránh đoán sai API.
      if (node.op === 'sum') {
        return [
          new MathSum({
            children: mathNodeToDocxComponents(node.base),
            subScript: node.sub ? mathNodeToDocxComponents(node.sub) : undefined,
            superScript: node.sup ? mathNodeToDocxComponents(node.sup) : undefined,
          }),
        ];
      }
      return [new MathRun(mathNodeToLinearText(node))];
    // bar, acc: chưa có API tương ứng ổn định trong `docx` -> xuất dạng văn
    // bản tuyến tính, vẫn nằm trong object công thức (font Cambria Math)
    default:
      return [new MathRun(mathNodeToLinearText(node))];
  }
}
