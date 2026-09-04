import type { VercelRequest, VercelResponse } from '@vercel/node';

// Kiểm tra https://ai.google.dev/gemini-api/docs/models để lấy model ID mới nhất
// trước khi triển khai — model ID có thể thay đổi/nghỉ hưu theo thời gian.
// gemini-3.5-flash: bản GA hiện tại (nhanh, rẻ, đủ tốt cho việc soạn văn bản dài
// như KHBD). Nếu muốn chất lượng cao hơn (chấp nhận chậm/đắt hơn), đổi thành
// "gemini-3.1-pro-preview" qua biến môi trường GEMINI_MODEL.
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

interface LessonPlanRequestBody {
  subject: string;
  grade: string;
  lessonTitle: string;
  durationPeriods: number;
  sourceContent: string;
  accommodation: { types: string[]; notes: string };
  extraRequirements?: string;
}

const DISABILITY_LABELS: Record<string, string> = {
  nhin: 'Khuyết tật nhìn (Thị giác)',
  nghe: 'Khuyết tật nghe (Thính giác)',
  van_dong: 'Khuyết tật vận động',
  tri_tue: 'Khuyết tật trí tuệ / Phát triển',
  ngon_ngu: 'Khuyết tật ngôn ngữ / Giao tiếp',
  khac: 'Khuyết tật khác',
};

// Giữ đồng bộ với src/utils/lessonPlanTemplate.ts (bản phía client, dùng khi cần
// hiển thị/preview prompt — logic gọi AI thật chạy ở đây, phía server).
function buildSystemPrompt(): string {
  return `Bạn là chuyên gia biên soạn Kế hoạch bài dạy (KHBD) cho giáo viên phổ thông Việt Nam.
Viết bằng tiếng Việt. NHIỆM VỤ CHÍNH của bạn KHÔNG phải là viết lại giáo án — mà là GIỮ NGUYÊN
giáo án gốc của giáo viên và bổ sung thêm các cột tích hợp năng lực số & giáo dục hòa nhập bên
cạnh, mỗi loại nội dung một cột riêng biệt (không gộp chung).

QUY TẮC ĐỊNH DẠNG BẮT BUỘC — tuân thủ tuyệt đối, vì hệ thống sẽ tự động phân tích cú pháp:

1. Dùng heading Markdown ("# ", "## ", "### ") bám sát đúng cấu trúc mục/hoạt động đã có
   trong ngữ liệu gốc (giữ nguyên tên mục, số thứ tự hoạt động... của giáo viên — KHÔNG ép
   về khung I/II/III/IV nếu bản gốc không chia như vậy).
2. Ngay sau MỖI heading, viết khối GOC (bắt buộc), rồi tuỳ trường hợp thêm khối SO và/hoặc
   khối KT (xem điều kiện ở mục 3, 4 bên dưới) — không viết thêm văn bản nào khác ngoài các
   khối này:

<<<GOC
(nguyên văn nội dung giáo án gốc tương ứng với mục này)
GOC>>>
<<<SO
(nội dung năng lực số bổ sung cho mục này — chỉ xuất hiện khi đủ điều kiện, xem mục 3)
SO>>>
<<<KT
(nội dung điều chỉnh giáo dục hòa nhập cho mục này — chỉ xuất hiện khi đủ điều kiện, xem mục 4)
KT>>>

3. KHỐI GOC — QUAN TRỌNG NHẤT: phải là bản SAO Y NGUYÊN VĂN phần tương ứng trong "NGỮ LIỆU
   TRÍCH TỪ GIÁO ÁN GỐC" ở dưới — giữ đúng từng câu chữ, thứ tự, gạch đầu dòng, placeholder
   công thức [[EQ:CTx]] như bản gốc. TUYỆT ĐỐI KHÔNG diễn giải lại, không tóm tắt, không đổi
   văn phong, không "chuẩn hoá" theo khung 5512. Nếu ngữ liệu gốc không chia rõ theo mục nào
   đó, chỉ cần trích đúng phần liên quan gần nhất, không tự bịa thêm nội dung gốc.
4. KHỐI SO (năng lực số) — CHỈ viết khối này khi nội dung gốc của đúng mục đang xét CHƯA có
   sẵn yếu tố năng lực số/công nghệ nào (vd: chưa nhắc phần mềm, công cụ số, AI, máy tính...).
   Nếu ngữ liệu gốc của mục này ĐÃ có sẵn (ví dụ đã dùng GeoGebra, PowerPoint, AI...) thì
   BỎ HẲN khối SO cho mục đó — không lặp lại nội dung đã có, không viết khối rỗng.
   Khi viết, nêu cụ thể công cụ số/AI học sinh hoặc giáo viên có thể dùng thêm và cách dùng,
   gắn với đúng nội dung của mục đó (không viết chung chung).
5. KHỐI KT (giáo dục hòa nhập) — CHỈ viết khối này nếu lớp CÓ học sinh khuyết tật (xem danh
   sách loại khuyết tật trong phần THÔNG TIN BÀI DẠY bên dưới). Nếu lớp KHÔNG có HSKT (danh
   sách rỗng), TUYỆT ĐỐI không viết khối KT ở bất kỳ mục nào trong toàn bộ bài. Khi viết, mô
   tả hành động điều chỉnh cụ thể của GV cho từng loại khuyết tật đã chọn, gắn với đúng nội
   dung của mục đó (không viết chung chung).
6. Placeholder dạng [[EQ:CT1]], [[EQ:CT2]]... trong ngữ liệu gốc LÀ CÔNG THỨC TOÁN của bài.
   Có thể có chú thích ngay sau, dạng [[EQ:CT1]](ct: x^2+3x-4) — phần (ct: ...) CHỈ để bạn
   hiểu nội dung công thức, TUYỆT ĐỐI KHÔNG chép lại phần (ct: ...) vào bài. Trong khối GOC,
   chỉ xuất lại placeholder trần [[EQ:CT1]], bỏ hẳn phần (ct: ...) phía sau, giữ nguyên đúng
   vị trí xuất hiện trong câu — không viết lại bằng lời, không đổi sang LaTeX, không xoá.
7. Nếu trong khối SO hoặc KT bạn cần viết MỘT công thức toán MỚI (không có trong ngữ liệu
   gốc, ví dụ ví dụ minh hoạ trong một prompt gợi ý AI), được phép dùng LaTeX bọc trong
   $...$, nhưng CHỈ dùng cú pháp đơn giản: chữ/số, ^{...} (số mũ), _{...} (chỉ số dưới),
   \\frac{a}{b}, \\sqrt{a}, \\left( \\right). KHÔNG dùng các lệnh LaTeX phức tạp/hiếm khác.
   Không lạm dụng — chỉ thêm công thức mới khi thực sự cần thiết cho ví dụ minh hoạ.
8. TUYỆT ĐỐI KHÔNG viết bất kỳ lời giải thích, liệt kê, ghi chú, hay "diễn giải trước" nào
   về cách bạn hiểu/xử lý ngữ liệu, placeholder, hay chú thích (ct: ...) — không liệt kê
   bảng ánh xạ công thức, không tóm tắt kế hoạch trước khi viết. TRẢ LỜI BẮT ĐẦU NGAY bằng
   heading "# " đầu tiên, không có bất kỳ câu chữ nào phía trước.

Chỉ trả lời bằng đúng nội dung KHBD theo định dạng trên. Không thêm lời chào, không giải
thích, không markdown code fence.`;
}

function buildUserPrompt(body: LessonPlanRequestBody): string {
  const types = body.accommodation?.types || [];
  const disabilityLines =
    types.length > 0
      ? types.map((t) => `- ${DISABILITY_LABELS[t] || t}`).join('\n')
      : '- (Lớp không có học sinh khuyết tật)';

  return `THÔNG TIN BÀI DẠY
- Môn học: ${body.subject}
- Khối lớp: ${body.grade}
- Tên bài: ${body.lessonTitle}
- Số tiết: ${body.durationPeriods}

LOẠI KHUYẾT TẬT CỦA HSKT TRONG LỚP (nếu có):
${disabilityLines}
Ghi chú thêm của GV về HSKT: ${body.accommodation?.notes || '(không có)'}

YÊU CẦU THÊM CỦA GIÁO VIÊN:
${body.extraRequirements || '(không có)'}

NGỮ LIỆU TRÍCH TỪ GIÁO ÁN GỐC (công thức toán đã thay bằng placeholder [[EQ:CTx]],
PHẢI giữ nguyên các placeholder này đúng vị trí, không viết lại):
---
${body.sourceContent || '(không trích được nội dung — hãy soạn KHBD dựa trên tên bài và môn học ở trên)'}
---`;
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

  const body = req.body as LessonPlanRequestBody;

  try {
    const response = await fetch(GEMINI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Header (thay vì query param ?key=...) để key không bị lộ trong access log.
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: buildSystemPrompt() }] },
        contents: [{ role: 'user', parts: [{ text: buildUserPrompt(body) }] }],
        generationConfig: {
          // Cột GOC phải chép nguyên văn toàn bộ giáo án gốc + thêm cột SO/KT
          // -> output có thể dài hơn nhiều so với việc chỉ tóm tắt/viết lại,
          // nên cần ngân sách token lớn để không bị cắt giữa chừng (MAX_TOKENS).
          maxOutputTokens: 32768,
          // Việc này chủ yếu là tuân thủ định dạng + chép lại đúng, không cần
          // suy luận sâu -> tắt "thinking" để dành trọn ngân sách token cho nội
          // dung thật, tránh vừa tốn token vừa có nguy cơ rò rỉ suy nghĩ ra bài.
          thinkingConfig: { thinkingBudget: 0 },
        },
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

    const markdown = (candidate.content?.parts || [])
      .filter((p: any) => typeof p.text === 'string' && !p.thought)
      .map((p: any) => p.text)
      .join('\n');

    const warnings: string[] = [];
    if (candidate.finishReason && candidate.finishReason !== 'STOP') {
      const extra =
        candidate.finishReason === 'MAX_TOKENS'
          ? ' Giáo án gốc có thể quá dài — thử giảm bớt nội dung nguồn hoặc chia soạn theo từng phần nhỏ hơn.'
          : '';
      warnings.push(`Phản hồi có thể chưa đầy đủ (finishReason: ${candidate.finishReason}).${extra} Kiểm tra lại bản xem trước trước khi dùng.`);
    }
    if (!markdown.includes('<<<GOC')) {
      warnings.push('AI có thể chưa tuân thủ đúng định dạng cột yêu cầu — kiểm tra lại bản xem trước trước khi dùng.');
    }

    res.status(200).json({ markdown, warnings });
  } catch (err: any) {
    res.status(500).json({ error: `Lỗi máy chủ: ${err.message || String(err)}` });
  }
}
