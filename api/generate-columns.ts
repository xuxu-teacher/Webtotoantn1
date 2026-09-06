import type { VercelRequest, VercelResponse } from '@vercel/node';

// Dùng chung model với api/generate.ts (đổi qua biến môi trường GEMINI_MODEL
// nếu cần) — nhưng vì mỗi lượt gọi ở đây RẤT NHẸ (chỉ vài trăm ký tự ngữ cảnh
// mỗi bảng, output chỉ vài câu ngắn mỗi bảng), không cần cơ chế retry/fallback
// phức tạp như api/generate.ts (giáo án dài dễ vượt ngân sách thời gian) —
// một lượt gọi đơn giản là đủ an toàn cho chế độ này.
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const urlFor = (model: string) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

interface TableInput {
  index: number;
  heading: string;
  gvHsText: string;
  sanPhamText: string;
  needNls: boolean;
  needKt: boolean;
}

interface RequestBody {
  subject: string;
  grade: string;
  accommodation?: { types: string[]; notes: string };
  tables: TableInput[];
}

const DISABILITY_LABELS: Record<string, string> = {
  nhin: 'Khuyết tật nhìn (Thị giác)',
  nghe: 'Khuyết tật nghe (Thính giác)',
  van_dong: 'Khuyết tật vận động',
  tri_tue: 'Khuyết tật trí tuệ / Phát triển',
  ngon_ngu: 'Khuyết tật ngôn ngữ / Giao tiếp',
  khac: 'Khuyết tật khác',
};

// Khung năng lực số theo Thông tư 02/2025/TT-BGDĐT — xem giải thích đầy đủ
// trong api/generate.ts (buildSystemPrompt, mục 4) — giữ NGẮN GỌN ở đây vì
// đây là một lượt gọi nhẹ, không cần lặp lại toàn bộ hướng dẫn KHBD.
const NLS_FRAMEWORK = `Khung năng lực số (Thông tư 02/2025/TT-BGDĐT), chọn ĐÚNG MỘT năng lực thành phần sát nhất, mức "NC1" (Nâng cao, bậc 5 - phù hợp THPT):
1. KHAI THÁC DỮ LIỆU: 1.1 Duyệt/tìm kiếm/lọc | 1.2 Đánh giá | 1.3 Quản lý dữ liệu-thông tin số.
2. GIAO TIẾP-HỢP TÁC SỐ: 2.1 Tương tác | 2.2 Chia sẻ | 2.3 Trách nhiệm công dân số | 2.4 Hợp tác | 2.5 Ứng xử trên mạng | 2.6 Quản lý danh tính số.
3. SÁNG TẠO NỘI DUNG SỐ: 3.1 Phát triển | 3.2 Tích hợp/tạo lập lại | 3.3 Bản quyền | 3.4 Lập trình.
4. AN TOÀN: 4.1 Bảo vệ thiết bị | 4.2 Dữ liệu cá nhân | 4.3 Sức khỏe-an sinh số | 4.4 Môi trường.
5. GIẢI QUYẾT VẤN ĐỀ: 5.1 Vấn đề kỹ thuật | 5.2 Xác định nhu cầu-giải pháp công nghệ | 5.3 Sử dụng sáng tạo công nghệ số | 5.4 Cải thiện năng lực số.
6. ỨNG DỤNG AI: 6.1 Hiểu biết về AI | 6.2 Dùng AI có đạo đức | 6.3 Đánh giá công cụ AI.
Định dạng: "[miền].[thành phần].NC1[chỉ báo]: mô tả ngắn" — ví dụ "5.3.NC1b: HS sử dụng GeoGebra để vẽ đồ thị và kiểm chứng tính chất hàm số."`;

function buildPrompt(body: RequestBody): string {
  const accTypes = body.accommodation?.types?.length
    ? body.accommodation.types.map((t) => DISABILITY_LABELS[t] || t).join(', ')
    : '';
  const accNotes = body.accommodation?.notes?.trim() || '';
  const hasHsKt = !!(accTypes || accNotes);

  const tablesBlock = body.tables
    .map(
      (t) => `--- BẢNG #${t.index} ---
Hoạt động: ${t.heading || '(không rõ)'}
Trích GV-HS: ${t.gvHsText.slice(0, 1200)}
Trích Sản phẩm dự kiến: ${t.sanPhamText.slice(0, 1200)}
Cần viết: ${[t.needNls ? 'nls' : '', t.needKt ? 'kt' : ''].filter(Boolean).join(' và ')}`
    )
    .join('\n\n');

  return `Bạn là trợ lý soạn giáo án môn ${body.subject}, lớp ${body.grade}. Với MỖI bảng hoạt động dạy học dưới đây
(chỉ trích một phần GV-HS/Sản phẩm dự kiến để bạn có ngữ cảnh — KHÔNG cần và KHÔNG được chép lại các đoạn này),
hãy viết:
- "nls" (nếu bảng đó "Cần viết" có "nls"): 1-2 ý ngắn gọn về năng lực số HS/GV có thể dùng thêm, gắn đúng với nội dung
  hoạt động đó. ${NLS_FRAMEWORK}
${
  hasHsKt
    ? `- "kt" (nếu bảng đó "Cần viết" có "kt"): 1-2 gợi ý điều chỉnh/hỗ trợ cụ thể cho học sinh khuyết tật trong lớp
  (dạng khuyết tật: ${accTypes || '(xem ghi chú)'}${accNotes ? `; ghi chú thêm: ${accNotes}` : ''}), gắn đúng với nội
  dung hoạt động đó — không viết chung chung.`
    : ''
}

${tablesBlock}

CHỈ trả về DUY NHẤT một mảng JSON hợp lệ, không kèm markdown/backtick/giải thích gì thêm, đúng dạng:
[{"index": 0, "nls": "...", "kt": "..."}, ...]
Chỉ đưa field "nls"/"kt" vào một phần tử nếu bảng đó thực sự "Cần viết" field đó (bỏ hẳn field nếu không cần, đừng để chuỗi rỗng).`;
}

function extractJsonArray(text: string): unknown {
  const cleaned = text.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) throw new Error('Không tìm thấy mảng JSON trong phản hồi AI.');
  return JSON.parse(cleaned.slice(start, end + 1));
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Chỉ hỗ trợ POST' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Thiếu GEMINI_API_KEY trên server (xem README, khai báo trong Vercel Environment Variables).' });
    return;
  }

  const body = req.body as RequestBody;
  if (!body?.tables?.length) {
    res.status(400).json({ error: 'Thiếu danh sách bảng cần xử lý (tables).' });
    return;
  }

  try {
    const response = await fetch(`${urlFor(MODEL)}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: buildPrompt(body) }] }],
        generationConfig: { maxOutputTokens: 8192, responseMimeType: 'application/json' },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      res.status(response.status).json({ error: `Lỗi từ Gemini API: ${errText}` });
      return;
    }

    const data = await response.json();
    const candidate = (data.candidates || [])[0];
    if (!candidate) {
      res.status(502).json({ error: 'Gemini không trả về nội dung nào (có thể bị chặn bởi bộ lọc an toàn).' });
      return;
    }
    const text = (candidate.content?.parts || [])
      .filter((p: any) => typeof p.text === 'string' && !p.thought)
      .map((p: any) => p.text)
      .join('');

    let parsed: unknown;
    try {
      parsed = extractJsonArray(text);
    } catch {
      res.status(502).json({ error: 'AI trả về nội dung không đúng định dạng JSON mong đợi — thử lại.' });
      return;
    }
    if (!Array.isArray(parsed)) {
      res.status(502).json({ error: 'AI trả về nội dung không đúng định dạng mảng JSON mong đợi — thử lại.' });
      return;
    }

    res.status(200).json({ results: parsed });
  } catch (err: any) {
    res.status(500).json({ error: `Lỗi không xác định: ${err?.message || String(err)}` });
  }
}
