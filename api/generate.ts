import type { VercelRequest, VercelResponse } from '@vercel/node';

// Kiểm tra https://docs.claude.com/en/docs/about-claude/models để lấy model ID mới nhất
// trước khi triển khai — model ID có thể thay đổi theo thời gian.
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

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
Viết bằng tiếng Việt, theo khung Công văn 5512/BGDĐT-GDTrH, có tích hợp năng lực số và
giáo dục hòa nhập ở CỘT RIÊNG bên phải cho từng mục (không viết chen vào cột trái).

QUY TẮC ĐỊNH DẠNG BẮT BUỘC — tuân thủ tuyệt đối, vì hệ thống sẽ tự động phân tích cú pháp:

1. Mỗi mục lớn dùng heading Markdown: "# " cho tiêu đề KHBD, "## " cho mục La Mã
   (I, II, III, IV), "### " cho từng Hoạt động trong mục III.
2. Ngay sau MỖI heading, viết đúng một cặp khối sau, không thêm văn bản nào khác
   ngoài hai khối này:

<<<TRAI
(nội dung giáo án chuẩn cho mục này)
TRAI>>>
<<<PHAI
(năng lực số & giáo dục hòa nhập tương ứng CHỈ với mục này)
PHAI>>>

3. Placeholder dạng [[EQ:CT1]], [[EQ:CT2]]... trong ngữ liệu gốc LÀ CÔNG THỨC TOÁN —
   giữ nguyên y hệt, đúng vị trí xuất hiện trong câu. Không được viết lại bằng lời,
   không đổi sang LaTeX/ $...$, không xoá.

CẤU TRÚC NỘI DUNG:

# KẾ HOẠCH BÀI DẠY: <tên bài>

## I. MỤC TIÊU
  TRAI: 1) Kiến thức 2) Năng lực chung 3) Năng lực đặc thù môn học 4) Phẩm chất
  PHAI: Mục tiêu năng lực số cụ thể (công cụ số/AI học sinh dùng, kỹ năng số cần đạt)
        VÀ mục tiêu/điều chỉnh giáo dục hòa nhập cho từng loại khuyết tật của HSKT
        trong lớp (nếu có) liên quan đến mục tiêu bài học này.

## II. THIẾT BỊ DẠY HỌC VÀ HỌC LIỆU
  TRAI: thiết bị, học liệu thông thường
  PHAI: học liệu số/công cụ AI hỗ trợ dạy học; học liệu/thiết bị hỗ trợ riêng cho
        từng loại khuyết tật (chữ nổi, phụ đề, hình ảnh trực quan, phần mềm đọc màn
        hình...) tương ứng loại khuyết tật của HSKT trong lớp.

## III. TIẾN TRÌNH DẠY HỌC
### Hoạt động 1: Mở đầu
### Hoạt động 2: Hình thành kiến thức mới
### Hoạt động 3: Luyện tập
### Hoạt động 4: Vận dụng
  Mỗi hoạt động — TRAI: a) Mục tiêu b) Nội dung c) Sản phẩm d) Tổ chức thực hiện.
  PHAI: điểm tích hợp năng lực số/AI cụ thể trong hoạt động này, VÀ cách điều chỉnh
        hoạt động này cho từng loại khuyết tật của HSKT (mô tả hành động cụ thể GV
        thực hiện, không viết chung chung).

## IV. RÚT KINH NGHIỆM
  TRAI: (để trống cho GV điền sau khi dạy)
  PHAI: (để trống)

Chỉ trả lời bằng đúng nội dung KHBD theo định dạng trên. Không thêm lời chào, không
giải thích, không markdown code fence.`;
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

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Thiếu ANTHROPIC_API_KEY trên server (xem README, khai báo trong Vercel Environment Variables).' });
    return;
  }

  const body = req.body as LessonPlanRequestBody;

  try {
    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8000,
        system: buildSystemPrompt(),
        messages: [{ role: 'user', content: buildUserPrompt(body) }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      res.status(response.status).json({ error: `Lỗi từ Anthropic API: ${errText}` });
      return;
    }

    const data = await response.json();
    const markdown = (data.content || [])
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('\n');

    const warnings: string[] = [];
    if (!markdown.includes('<<<TRAI')) {
      warnings.push('AI có thể chưa tuân thủ đúng định dạng 2 cột yêu cầu — kiểm tra lại bản xem trước trước khi dùng.');
    }

    res.status(200).json({ markdown, warnings });
  } catch (err: any) {
    res.status(500).json({ error: `Lỗi máy chủ: ${err.message || String(err)}` });
  }
}
