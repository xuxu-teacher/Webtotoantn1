import type { GeneratedLessonPlan, LessonPlanRequest } from '../types';

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
    throw new Error(`Sinh KHBD thất bại (${res.status}): ${errBody || res.statusText}`);
  }

  return (await res.json()) as GeneratedLessonPlan;
}
