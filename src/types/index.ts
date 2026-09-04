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

// ===== Khối lớp (dùng cho dropdown chọn lớp) =====
export const GRADE_OPTIONS = ['Lớp 10', 'Lớp 11', 'Lớp 12'];

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

/** Ảnh xem trước của công thức OLE cũ (MathType), trích từ word/media/... */
export interface EquationPreviewImage {
  dataUrl: string; // data:<mime>;base64,...
  mime: string;
  /** 'raster' = PNG/JPEG/GIF/BMP, hiển thị được thẳng bằng <img>. 'vector_legacy' = WMF/EMF, trình duyệt không render được. */
  kind: 'raster' | 'vector_legacy';
}

/** Một công thức đã trích từ file gốc, gắn ID để chèn placeholder vào văn bản. */
export interface EquationEntry {
  id: string; // ví dụ "CT1"
  node: MathNode | null; // null nếu không parse được cấu trúc (fallback text thô)
  mathml: string; // dùng để hiển thị bằng MathJax
  convertible: boolean; // false = công thức MathType/OLE cũ, không có dữ liệu cấu trúc
  previewImage?: EquationPreviewImage; // ảnh xem trước, nếu trích được (chỉ áp dụng khi convertible = false)
  /** Dữ liệu OLE gốc (.bin, chứa MTEF nhị phân) — dữ liệu ĐÚNG cần gửi cho máy chủ MathType→LaTeX. Base64, không có prefix data:. */
  oleObjectBase64?: string;
  /** Kết quả LaTeX trả về từ máy chủ chuyển đổi riêng của bạn (nếu đã chạy bước "Chuyển đổi bằng máy chủ MathType"). */
  latexFromExternalConverter?: string;
  /** Kích thước Word đã đặt cho ảnh xem trước (đơn vị pt), dùng để xuất lại đúng tỉ lệ. */
  sizePt?: { width: number; height: number };
  /** @internal chỉ dùng tạm trong lúc parse (docxParser.ts), bị xoá trước khi trả về ParsedDocument. */
  __imageRelId?: string;
  /** @internal chỉ dùng tạm trong lúc parse (docxParser.ts), bị xoá trước khi trả về ParsedDocument. */
  __oleRelId?: string;
}

/** Một hình vẽ/ảnh minh hoạ (không phải công thức) trích từ file gốc, ví dụ hình vẽ hình học,
 * biểu đồ chèn bằng "Insert > Pictures", ảnh chụp màn hình GeoGebra dán vào giáo án... */
export interface ImageEntry {
  id: string; // ví dụ "IMG1"
  dataUrl: string; // data:<mime>;base64,...
  mime: string;
  /** 'raster' = PNG/JPEG/GIF/BMP, hiển thị và xuất Word được thẳng. 'vector_legacy' = WMF/EMF, không nhúng lại được. */
  kind: 'raster' | 'vector_legacy';
  /** Kích thước Word đã đặt cho ảnh (đơn vị pt), dùng để xuất lại đúng tỉ lệ. */
  sizePt?: { width: number; height: number };
  /** @internal chỉ dùng tạm trong lúc parse (docxParser.ts), bị xoá trước khi trả về ParsedDocument. */
  __relId?: string;
}

export interface ParsedDocument {
  fileName: string;
  sourceTextWithPlaceholders: string; // văn bản gốc, công thức thay bằng [[EQ:CT1]]..., hình vẽ thay bằng [[IMG:IMG1]]...
  rawHtml: string; // bản render mammoth, để đối chiếu trực quan
  equations: Record<string, EquationEntry>;
  equationCount: number;
  nonConvertibleEquationCount: number;
  images: Record<string, ImageEntry>;
  /** Tên bài học gợi ý (tự nhận diện từ heading trong file hoặc từ tên file) — chỉ là gợi ý, GV có thể sửa. */
  suggestedTitle?: string;
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
  sourceContent: string; // ngữ liệu gửi AI — CHỈ chứa placeholder trần [[EQ:CTx]], không chèn chú thích
  equationLegend?: string; // chú thích nội dung công thức, gửi TÁCH RIÊNG khỏi sourceContent
  accommodation: DisabilityAccommodation;
  extraRequirements?: string;
  /** Có khi giáo án gốc quá dài, hệ thống tự chia `sourceContent` thành nhiều phần rồi gọi
   * API riêng cho từng phần (xem aiClient.ts: generateLessonPlanSmart) — trường này báo cho
   * AI biết đang xử lý phần thứ mấy trong tổng số, để KHÔNG tự thêm phần mở đầu/kết luận cho
   * toàn bài hay lặp lại tiêu đề ở mỗi phần. */
  partInfo?: { index: number; total: number };
}

export interface GeneratedLessonPlan {
  // Nội dung KHBD ở định dạng có cấu trúc riêng (xem khbdParser.ts):
  // heading thường (#, ##, ###) + khối <<<GOC ... GOC>>> (bắt buộc) + tuỳ chọn
  // <<<SO ... SO>>> (năng lực số) và/hoặc <<<KT ... KT>>> (giáo dục hòa nhập).
  // Placeholder [[EQ:CTx]] PHẢI được AI giữ nguyên, không viết lại thành LaTeX.
  markdown: string;
  warnings: string[];
}
