import type { MathNode } from '../types';

/**
 * Bộ phân tích LaTeX -> MathNode, DÙNG RIÊNG cho công thức MỚI mà AI tự viết
 * thêm trong lời văn (bọc trong $...$) — ví dụ khi gợi ý một hàm số ví dụ trong
 * cột "Năng lực số". KHÔNG dùng cho công thức gốc trong file Word (công thức
 * gốc đi qua ommlAst.ts, giữ đúng 100% cấu trúc XML gốc).
 *
 * Trước đây các đoạn $...$ này bị ghi thẳng ra làm text (kể cả dấu \, {, })
 * nên hiện lỗi kiểu "y=f\left({x}\right)=x^{3}-3x^{2}+2x+1" trên bản Word xuất
 * ra. Parser này chỉ cần hiểu đúng tập lệnh LaTeX phổ biến AI hay dùng (^, _,
 * \frac, \sqrt, \left...\right, vài hàm số quen thuộc) rồi trả về MathNode —
 * tái dùng đúng pipeline mathToMathml.ts (xem trước) / mathToDocx.ts (xuất
 * Word) đã có sẵn cho công thức gốc, nên hiển thị ra công thức thật, không
 * phải chữ nghiêng chép nguyên mã LaTeX.
 *
 * Không cầu toàn: cú pháp lạ/hiếm sẽ rơi vào nhánh dự phòng (xem parseLatexSafe)
 * — vẫn hiển thị được, chỉ là không còn là object công thức có thể bấm sửa.
 */

const FUNC_NAMES = new Set([
  'sin', 'cos', 'tan', 'cot', 'sec', 'csc',
  'log', 'ln', 'lim', 'exp', 'max', 'min', 'gcd', 'lcm',
]);

const SYMBOL_MAP: Record<string, string> = {
  '\\cdot': '·', '\\times': '×', '\\div': '÷',
  '\\pm': '±', '\\mp': '∓',
  '\\leq': '≤', '\\geq': '≥', '\\neq': '≠', '\\approx': '≈', '\\equiv': '≡',
  '\\infty': '∞', '\\rightarrow': '→', '\\to': '→', '\\Rightarrow': '⇒',
  '\\in': '∈', '\\notin': '∉', '\\subset': '⊂', '\\cup': '∪', '\\cap': '∩',
  '\\forall': '∀', '\\exists': '∃', '\\emptyset': '∅', '\\partial': '∂',
  '\\alpha': 'α', '\\beta': 'β', '\\gamma': 'γ', '\\delta': 'δ', '\\Delta': 'Δ',
  '\\theta': 'θ', '\\lambda': 'λ', '\\mu': 'μ', '\\pi': 'π', '\\sigma': 'σ',
  '\\phi': 'φ', '\\omega': 'ω', '\\varepsilon': 'ε',
  '\\%': '%', '\\ ': ' ', '\\,': ' ', '\\;': ' ', '\\!': '',
};

class Cursor {
  constructor(public s: string, public i = 0) {}
  peek(): string {
    return this.s[this.i] ?? '';
  }
  eof(): boolean {
    return this.i >= this.s.length;
  }
  skipSpaces() {
    while (!this.eof() && /\s/.test(this.peek())) this.i++;
  }
}

/** Đọc một "command" LaTeX bắt đầu bằng \ (ví dụ \frac, \left, \alpha, \{). */
function readCommand(c: Cursor): string {
  const start = c.i;
  c.i++; // bỏ qua \
  if (c.eof()) return c.s.slice(start, c.i);
  if (/[a-zA-Z]/.test(c.peek())) {
    while (!c.eof() && /[a-zA-Z]/.test(c.peek())) c.i++;
  } else {
    c.i++; // ký tự đặc biệt sau \ (vd \{, \%, \,)
  }
  return c.s.slice(start, c.i);
}

/** Đọc một nhóm {...} (đã biết ký tự hiện tại là '{'), trả về MathNode bên trong. */
function readGroup(c: Cursor): MathNode {
  c.i++; // bỏ qua '{'
  const node = parseRow(c, '}');
  if (c.peek() === '}') c.i++;
  return node;
}

/** Đọc một "atom" đơn: nếu là '{...}' thì đọc cả nhóm, nếu không thì đọc 1 ký tự/1 lệnh. */
function readAtom(c: Cursor): MathNode {
  c.skipSpaces();
  if (c.peek() === '{') return readGroup(c);
  if (c.peek() === '\\') {
    const cmd = readCommand(c);
    return parseCommandAsAtom(c, cmd);
  }
  const ch = c.peek();
  c.i++;
  return { kind: 'text', value: ch };
}

function parseCommandAsAtom(c: Cursor, cmd: string): MathNode {
  if (cmd === '\\left') return parseLeftRight(c);
  if (cmd === '\\frac') {
    const num = readAtom(c);
    const den = readAtom(c);
    return { kind: 'frac', num, den };
  }
  if (cmd === '\\sqrt') {
    c.skipSpaces();
    let degree: MathNode | undefined;
    if (c.peek() === '[') {
      c.i++;
      const startDeg = c.i;
      while (!c.eof() && c.peek() !== ']') c.i++;
      degree = { kind: 'text', value: c.s.slice(startDeg, c.i) };
      if (c.peek() === ']') c.i++;
    }
    const base = readAtom(c);
    return { kind: 'sqrt', base, degree };
  }
  if (FUNC_NAMES.has(cmd.slice(1))) {
    const base = readAtom(c);
    return { kind: 'func', name: { kind: 'text', value: cmd.slice(1) }, base };
  }
  if (cmd in SYMBOL_MAP) return { kind: 'text', value: SYMBOL_MAP[cmd] };
  if (cmd === '\\{') return { kind: 'text', value: '{' };
  if (cmd === '\\}') return { kind: 'text', value: '}' };
  if (cmd === '\\text' || cmd === '\\mathrm' || cmd === '\\mathbf') {
    return readAtom(c);
  }
  // Lệnh lạ không nhận diện được -> bỏ dấu \, giữ lại phần chữ (an toàn, dễ đọc
  // hơn là in nguyên "\lệnh" ra bài).
  return { kind: 'text', value: cmd.replace(/^\\/, '') };
}

function readDelimChar(c: Cursor): string {
  c.skipSpaces();
  if (c.peek() === '\\') {
    const cmd = readCommand(c).replace(/^\\/, '');
    if (cmd === '{') return '{';
    if (cmd === '}') return '}';
    return cmd; // ex: "langle", "|" handled below via literal
  }
  const ch = c.peek();
  c.i++;
  return ch;
}

function parseLeftRight(c: Cursor): MathNode {
  const open = readDelimChar(c);
  const inner = parseRow(c, null, true);
  c.skipSpaces();
  if (c.s.startsWith('\\right', c.i)) {
    c.i += '\\right'.length;
  }
  const close = readDelimChar(c);
  const openCh = open === '.' ? '' : open;
  const closeCh = close === '.' ? '' : close;
  return { kind: 'delim', open: openCh, close: closeCh, base: inner };
}

/**
 * Đọc một chuỗi atom liên tiếp thành 'row', xử lý hậu tố ^ và _ ngay sau mỗi
 * atom. Dừng lại khi gặp ký tự kết thúc `stopChar` (vd '}' khi đang trong một
 * nhóm), hoặc gặp \right khi `stopAtRight` = true (đang trong \left...\right).
 */
function parseRow(c: Cursor, stopChar: string | null, stopAtRight = false): MathNode {
  const children: MathNode[] = [];
  while (!c.eof()) {
    c.skipSpaces();
    if (c.eof()) break;
    if (stopChar && c.peek() === stopChar) break;
    if (stopAtRight && c.s.startsWith('\\right', c.i)) break;

    let atom = readAtom(c);
    c.skipSpaces();

    // Cho phép cả ^ và _ trên cùng một atom (subsup), theo thứ tự bất kỳ.
    let sup: MathNode | undefined;
    let sub: MathNode | undefined;
    for (let guard = 0; guard < 2; guard++) {
      if (c.peek() === '^') {
        c.i++;
        sup = readAtom(c);
        c.skipSpaces();
      } else if (c.peek() === '_') {
        c.i++;
        sub = readAtom(c);
        c.skipSpaces();
      } else {
        break;
      }
    }
    if (sup && sub) atom = { kind: 'subsup', base: atom, sub, sup };
    else if (sup) atom = { kind: 'sup', base: atom, sup };
    else if (sub) atom = { kind: 'sub', base: atom, sub };

    children.push(atom);
  }
  if (children.length === 1) return children[0];
  return { kind: 'row', children };
}

/**
 * Phân tích an toàn: không bao giờ ném lỗi ra ngoài — nếu cú pháp quá lạ, trả
 * về node text thô (đã bỏ bớt backslash) thay vì crash cả trang.
 */
export function parseLatexSafe(latex: string): MathNode {
  try {
    const c = new Cursor(latex.trim());
    const node = parseRow(c, null);
    return node;
  } catch {
    return { kind: 'text', value: latex.replace(/\\[a-zA-Z]+/g, '').replace(/[{}]/g, '') };
  }
}

/**
 * LƯỚI AN TOÀN: đôi khi AI không tuân thủ đúng hướng dẫn (bọc công thức mới
 * trong $...$), hoặc — trường hợp hay gặp hơn — lỡ chép nguyên văn phần "chú
 * thích nội dung công thức" (vốn có dạng LaTeX như "y=f\left(x\right)=...")
 * ra làm nội dung thay vì giữ placeholder [[EQ:CTx]] trần. Nếu để nguyên, các
 * đoạn LaTeX trần này hiện ra như chữ thường, lộ hết dấu \, {, } (đúng lỗi
 * "\left(...)" người dùng gặp phải).
 *
 * Hàm này quét toàn bộ khối văn bản, tìm các "cụm dính liền không có khoảng
 * trắng" (giống hệt cách LaTeX thường được viết: không chèn dấu cách quanh
 * *, ^, _, \) mà chứa dấu hiệu LaTeX rõ ràng (dấu \ hoặc chữ/số/dấu ngoặc
 * đóng theo ngay sau bởi ^ hoặc _), rồi tự bọc chúng trong $...$ để pipeline
 * hiển thị/xuất Word xử lý như công thức thật thay vì bỏ mặc thành chữ.
 * Không đụng vào những gì đã nằm trong $...$, [[EQ:CTx]], hay dòng bảng
 * Markdown (| ... |).
 */
export function wrapBareLatex(text: string): string {
  const protectedSpans: string[] = [];
  let working = text.replace(/(\[\[EQ:[^\]]+\]\]|\$[^$]+\$)/g, (m) => {
    protectedSpans.push(m);
    return `\u0000${protectedSpans.length - 1}\u0000`;
  });

  working = working.replace(/\S+/g, (word) => {
    if (word.includes('\u0000')) return word; // đã được bảo vệ ở trên, bỏ qua
    const trailingPunct = word.match(/[.,;:!?]+$/)?.[0] || '';
    const core = trailingPunct ? word.slice(0, -trailingPunct.length) : word;
    if (!core) return word;

    const looksLikeLatex = core.includes('\\') || /[A-Za-z0-9)\]]\^/.test(core) || /[A-Za-z0-9)\]]_/.test(core);
    if (!looksLikeLatex) return word;

    return `$${core}$${trailingPunct}`;
  });

  return working.replace(/\u0000(\d+)\u0000/g, (_, i) => protectedSpans[Number(i)]);
}
