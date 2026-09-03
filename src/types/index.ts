// ===== Loại khuyết tật HSKT =====
export type DisabilityType = 'nhin' | 'nghe' | 'van_dong' | 'tri_tue' | 'ngon_ngu' | 'khac';

export const DISABILITY_LABELS: Record<DisabilityType, string> = {
  nhin: 'Khuyết tật nhìn (Thị giác)',
  nghe: 'Khuyết tật nghe (Thính giác)',
  van_dong: 'Khuyết tật vận động',
  tri_tue: 'Khuyết tật trí tuệ / Phát triển',
  ngon_ngu: 'Khuyết tật ngôn ngữ / Giao tiếp',
  khac: 'Khuyết tật khác',
};

// ===== Cây cú pháp công thức toán, dựng từ OMML (Word Insert Equation) =====
export type MathNode =
  | { kind: 'text'; value: string }
  | { kind: 'row'; children: MathNode[] }
  | { kind: 'frac'; num: MathNode; den: MathNode }
  | { kind: 'sup'; base: MathNode; sup: MathNode }
  | { kind: 'sub'; base: MathNode; sub: MathNode }
  | { kind: 'subsup'; base: MathNode; sub: MathNode; sup: MathNode }
  | { kind: 'sqrt'; base: MathNode; degree?: MathNode }
  | { kind: 'delim'; open: string; close: string; base: MathNode }
  | { kind: 'nary'; op: string; sub?: MathNode; sup?: MathNode; base: MathNode }
  | { kind: 'func'; name: MathNode; base: MathNode }
  | { kind: 'bar'; base: MathNode; position: 'top' | 'bottom' }
  | { kind: 'acc'; base: MathNode; char: string }
  | { kind: 'matrix'; rows: MathNode[][] };

/** Một công thức đã trích từ file gốc, gắn ID để chèn placeholder vào văn bản. */
export interface EquationEntry {
  id: string; // ví dụ "CT1"
  node: MathNode | null; // null nếu không parse được cấu trúc (fallback text thô)
  mathml: string; // dùng để hiển thị bằng MathJax
  convertible: boolean; // false = công thức MathType/OLE cũ, không có dữ liệu cấu trúc
}

export interface ParsedDocument {
  fileName: string;
  sourceTextWithPlaceholders: string; // văn bản gốc, công thức thay bằng [[EQ:CT1]]...
  rawHtml: string; // bản render mammoth, để đối chiếu trực quan
  equations: Record<string, EquationEntry>;
  equationCount: number;
  nonConvertibleEquationCount: number;
}

// ===== Thông tin đầu vào cho AI =====
export interface DisabilityAccommodation {
  types: DisabilityType[];
  notes: string;
}

export interface LessonPlanRequest {
  subject: string;
  grade: string;
  lessonTitle: string;
  durationPeriods: number;
  sourceContent: string; // = sourceTextWithPlaceholders, gửi cho AI
  accommodation: DisabilityAccommodation;
  extraRequirements?: string;
}

export interface GeneratedLessonPlan {
  // Nội dung KHBD ở định dạng có cấu trúc riêng (xem lessonPlanTemplate.ts):
  // heading thường (#, ##, ###) + khối 2 cột <<<TRAI ... TRAI>>> <<<PHAI ... PHAI>>>
  // Placeholder [[EQ:CTx]] PHẢI được AI giữ nguyên, không viết lại thành LaTeX.
  markdown: string;
  warnings: string[];
}
