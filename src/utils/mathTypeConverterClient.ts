import type { EquationEntry } from '../types';

/**
 * Client gọi THẲNG server MathType→LaTeX của bạn từ trình duyệt (không qua
 * serverless function của app) — vì server chạy trên Render free tier sẽ "ngủ
 * đông" khi không có traffic và cold-start có thể mất tới ~60-90 giây; một hàm
 * serverless của Vercel sẽ timeout trước khi chờ được (Hobby plan: 10s, Pro:
 * tối đa vài chục giây). Gọi trực tiếp từ browser thì không bị giới hạn này.
 *
 * URL server lấy từ biến môi trường build-time VITE_MATHTYPE_SERVER_URL — đây
 * là URL công khai (không phải secret, server không yêu cầu API key theo code
 * gốc), nên an toàn khi để lộ trong bundle client, giống hệt cách project cũ
 * của bạn đã làm.
 *
 * Hợp đồng API (lấy đúng từ code cũ services/mathWordParserService.ts):
 *   GET  {serverUrl}/health                          -> đánh thức server
 *   POST {serverUrl}/v1/convert
 *        body:     { items: [{ id, ole_b64 }], wrap: true }
 *        response: { results: [{ id, latex, error? }] }
 */

const MATHTYPE_SERVER_URL: string =
  (import.meta as any).env?.VITE_MATHTYPE_SERVER_URL || 'http://localhost:8000';

/** Bỏ dấu $ hoặc $$ bao ngoài nếu server đã tự bọc sẵn (tham số wrap: true). */
function stripDollarWrap(s: string): string {
  const t = s.trim();
  if (t.startsWith('$$') && t.endsWith('$$')) return t.slice(2, -2).trim();
  if (t.startsWith('$') && t.endsWith('$')) return t.slice(1, -1).trim();
  return t;
}

/**
 * "Đánh thức" server: chỉ cần request có phản hồi (dù là 404/500) là coi như
 * server đã sống dậy — không yêu cầu /health phải trả 2xx, vì có thể server
 * thật của bạn không có route /health, hoặc trả về mã khác 200. Chỉ khi request
 * ném lỗi mạng thật sự (server ngủ chưa kịp phản hồi, DNS sai, hoặc bị CORS
 * chặn) mới coi là thất bại.
 */
async function wakeUpServer(serverUrl: string, timeoutMs = 90_000): Promise<{ ok: boolean; error?: string }> {
  try {
    await fetch(`${serverUrl}/health`, {
      signal: (AbortSignal as any).timeout?.(timeoutMs),
    });
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

export interface ConvertPhaseUpdate {
  phase: 'waking' | 'converting' | 'done' | 'error';
  message: string;
}

/**
 * Chuyển đổi TẤT CẢ công thức OLE còn thiếu trong một lần gọi (đúng như server
 * được thiết kế — 1 request cho toàn bộ danh sách, không phải gọi từng cái).
 * Mutate trực tiếp field `latexFromExternalConverter` trên từng EquationEntry
 * khi có kết quả; gọi onPhase để cập nhật trạng thái hiển thị (đánh thức server
 * có thể mất khá lâu do cold-start).
 */
export async function convertEquationsBatch(
  targets: EquationEntry[],
  onPhase: (update: ConvertPhaseUpdate) => void,
  serverUrl: string = MATHTYPE_SERVER_URL
): Promise<{ converted: number; total: number }> {
  const items = targets
    .filter((e) => e.oleObjectBase64)
    .map((e) => ({ id: e.id, ole_b64: e.oleObjectBase64 as string }));

  if (items.length === 0) {
    onPhase({ phase: 'done', message: 'Không có công thức OLE nào để chuyển đổi.' });
    return { converted: 0, total: 0 };
  }

  onPhase({ phase: 'waking', message: 'Đang đánh thức máy chủ MathType (có thể mất đến 60-90 giây nếu server đang ngủ đông)…' });
  const wake = await wakeUpServer(serverUrl, 90_000);
  if (!wake.ok) {
    onPhase({
      phase: 'error',
      message:
        `Không kết nối được máy chủ MathType (${wake.error || 'lỗi mạng'}). ` +
        `Khả năng cao: (1) server đang tắt/chưa bật CORS cho phép trình duyệt gọi tới — thử mở thẳng ` +
        `${serverUrl}/health trên một tab trình duyệt để kiểm tra server còn sống không, hoặc ` +
        `(2) VITE_MATHTYPE_SERVER_URL chưa đúng/chưa redeploy.`,
    });
    return { converted: 0, total: items.length };
  }

  onPhase({ phase: 'converting', message: `Đang chuyển đổi ${items.length} công thức…` });
  try {
    const res = await fetch(`${serverUrl}/v1/convert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items, wrap: true }),
      signal: (AbortSignal as any).timeout?.(120_000),
    });
    if (!res.ok) throw new Error(`Server phản hồi ${res.status}`);

    const data = await res.json();
    const byId = new Map<string, { latex?: string; error?: string }>();
    for (const r of data.results || []) byId.set(r.id, r);

    let converted = 0;
    for (const eq of targets) {
      const r = byId.get(eq.id);
      if (r?.latex && !r.error) {
        eq.latexFromExternalConverter = stripDollarWrap(r.latex);
        converted++;
      }
    }

    onPhase({ phase: 'done', message: `Đã chuyển đổi ${converted}/${items.length} công thức.` });
    return { converted, total: items.length };
  } catch (err: any) {
    onPhase({ phase: 'error', message: `Lỗi gọi máy chủ MathType: ${err.message || String(err)}` });
    return { converted: 0, total: items.length };
  }
}
