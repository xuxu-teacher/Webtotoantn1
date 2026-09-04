import type { GeneratedLessonPlan, LessonPlanRequest } from '../types';
import { chunkSourceText } from './chunkSource';

export async function generateLessonPlan(req: LessonPlanRequest): Promise<GeneratedLessonPlan> {
  let res: Response;
  try {
    res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
  } catch (err: any) {
    // Lỗi mạng "trần" (không có mã trạng thái HTTP) ở đây rất hay là do server
    // (Vercel) TỰ NGẮT function vì chạy quá lâu (mặc định 10s ở gói Hobby nếu
    // chưa cấu hình vercel.json) — không phải do trình duyệt hay mạng của GV.
    throw new Error(
      'Mất kết nối tới server khi đang soạn — nhiều khả năng do giáo án quá dài khiến quá trình ' +
        'vượt giới hạn thời gian chạy của server (đặc biệt nếu deploy trên gói Hobby của Vercel ' +
        'chưa cấu hình vercel.json, mặc định chỉ 10 giây). Thử soạn với giáo án ngắn hơn, hoặc ' +
        'xem README để tăng maxDuration / nâng gói Vercel.'
    );
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    if (res.status === 504) {
      throw new Error(
        'Sinh KHBD thất bại (504): Server đã chạy hết thời gian cho phép (giáo án này dài hơn ' +
          'mức server có thể xử lý trong thời gian tối đa hiện tại). Thử: (1) đổi biến môi trường ' +
          'GEMINI_MODEL sang "gemini-3.5-flash-lite" để soạn nhanh hơn, hoặc (2) nếu dùng gói Vercel ' +
          'Pro, tăng "maxDuration" trong vercel.json lên 120–300 giây rồi deploy lại — xem README.'
      );
    }
    throw new Error(`Sinh KHBD thất bại (${res.status}): ${errBody || res.statusText}`);
  }

  return (await res.json()) as GeneratedLessonPlan;
}

// Ngưỡng độ dài (ký tự) của ngữ liệu gốc, qua đó coi là "giáo án dài" và chủ
// động CHIA NHỎ thành nhiều phần rồi gọi API riêng cho từng phần — thay vì
// dồn hết vào một lượt gọi duy nhất rồi rủi ro bị timeout (xem api/generate.ts
// và src/utils/chunkSource.ts). Cố tình đặt THẤP hơn ngưỡng LONG_DOC_CHAR_THRESHOLD
// phía server (nơi quyết định tự chuyển sang model nhanh) một chút, vì chia
// nhỏ + gọi API nhiều lần luôn an toàn hơn dựa hẳn vào một model nhanh cho
// MỘT giáo án cực dài.
const CHUNK_THRESHOLD_CHARS = 15_000;
const CHUNK_TARGET_CHARS = 8_000;

/**
 * Soạn KHBD cho một giáo án DÀI bằng cách chia ngữ liệu gốc thành nhiều phần
 * nhỏ, gọi /api/generate riêng cho TỪNG phần (tuần tự, không gọi song song —
 * tránh dồn dập vào Gemini API cùng lúc dễ bị 429), rồi ghép các phần markdown
 * trả về lại với nhau theo đúng thứ tự. `equationLegend` (chú thích công thức)
 * được gửi kèm ĐẦY ĐỦ ở mọi phần vì không tốn nhiều token và đơn giản hơn hẳn
 * việc phải lọc placeholder [[EQ:...]]/[[IMG:...]] nào thuộc phần nào.
 *
 * Nếu ngữ liệu không đủ dài để cần chia (dưới CHUNK_THRESHOLD_CHARS), gọi
 * thẳng generateLessonPlan như bình thường — không chia phần không cần thiết.
 */
export async function generateLessonPlanSmart(
  req: LessonPlanRequest,
  onProgress?: (current: number, total: number) => void
): Promise<GeneratedLessonPlan> {
  if (req.sourceContent.length <= CHUNK_THRESHOLD_CHARS) {
    return generateLessonPlan(req);
  }

  const parts = chunkSourceText(req.sourceContent, CHUNK_TARGET_CHARS);
  const markdownParts: string[] = [];
  const warnings: string[] = [];

  for (let i = 0; i < parts.length; i++) {
    onProgress?.(i + 1, parts.length);
    const partResult = await generateLessonPlan({
      ...req,
      sourceContent: parts[i],
      partInfo: { index: i + 1, total: parts.length },
    });
    markdownParts.push(partResult.markdown);
    for (const w of partResult.warnings) warnings.push(`Phần ${i + 1}/${parts.length}: ${w}`);
  }

  return { markdown: markdownParts.join('\n\n'), warnings };
}
