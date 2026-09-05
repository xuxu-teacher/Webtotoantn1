import type { VercelRequest, VercelResponse } from '@vercel/node';

// Kiểm tra https://ai.google.dev/gemini-api/docs/models để lấy model ID mới nhất
// trước khi triển khai — model ID có thể thay đổi/nghỉ hưu theo thời gian.
// gemini-3.5-flash: bản GA hiện tại (nhanh, rẻ, đủ tốt cho việc soạn văn bản dài
// như KHBD). Nếu muốn chất lượng cao hơn (chấp nhận chậm/đắt hơn), đổi thành
// "gemini-3.1-pro-preview" qua biến môi trường GEMINI_MODEL.
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
// Model DỰ PHÒNG — khi MODEL chính bị Google báo "quá tải" (503) dù đã thử lại
// nhiều lần, tự động chuyển sang model này thử thêm 1 lần trước khi báo lỗi
// cho giáo viên. Đặt khác dòng model với MODEL để giảm khả năng cả hai cùng
// quá tải một lúc (các model "flash" hay bị quá tải đồng loạt vào giờ cao điểm
// hơn "pro"). Có thể đổi qua biến môi trường GEMINI_FALLBACK_MODEL.
const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || 'gemini-2.5-flash';
// Model NHANH — dùng làm lựa chọn ĐẦU TIÊN khi giáo án gốc quá dài (xem
// LONG_DOC_CHAR_THRESHOLD bên dưới), vì với giáo án dài, bản thân MỘT lượt
// sinh nội dung bằng MODEL thường (dù không bị quá tải, không cần retry) đã
// có thể tốn hơn 50-60s -> bị Vercel ngắt cứng thành 504 (khác hẳn lỗi quá
// tải 503 mà retry ở trên xử lý được). Model "lite" xử lý nhanh hơn nhiều nên
// giảm rủi ro này, đánh đổi bằng chất lượng có thể kém tinh tế hơn đôi chút —
// chấp nhận được vì việc chính ở khối GOC chỉ là CHÉP LẠI nguyên văn, không
// cần suy luận sâu. Có thể đổi qua biến môi trường GEMINI_LITE_MODEL, hoặc
// tắt hẳn cơ chế tự chuyển này bằng GEMINI_DISABLE_AUTO_LITE=1.
const LITE_MODEL = process.env.GEMINI_LITE_MODEL || 'gemini-3.5-flash-lite';
const AUTO_LITE_DISABLED = process.env.GEMINI_DISABLE_AUTO_LITE === '1';
// Ngưỡng độ dài (số ký tự) của phần ngữ liệu trích từ giáo án gốc, qua đó coi
// là "giáo án dài" và ưu tiên dùng LITE_MODEL ngay từ lần thử đầu tiên. Con số
// này là ước lượng thận trọng (không có cách nào biết trước chính xác thời
// gian Gemini sẽ xử lý) — có thể tinh chỉnh dần qua thực tế sử dụng.
const LONG_DOC_CHAR_THRESHOLD = 6000;
const urlFor = (model: string) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

interface LessonPlanRequestBody {
  subject: string;
  grade: string;
  lessonTitle: string;
  durationPeriods: number;
  sourceContent: string;
  equationLegend?: string;
  accommodation: { types: string[]; notes: string };
  extraRequirements?: string;
  partInfo?: { index: number; total: number };
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
   NẾU ngữ liệu gốc của mục này chứa BẢNG dạng Markdown (dòng bắt đầu bằng "|", có dòng phân
   cách "|---|---|" ngay sau dòng tiêu đề), khối GOC PHẢI CHÉP LẠI NGUYÊN VẸN bảng đó, ĐÚNG
   Y HỆT cú pháp Markdown gốc (đủ số cột, đủ số dòng, đúng nội dung từng ô, không được bỏ
   cột, không gộp cột, không chuyển bảng thành đoạn văn xuôi).
4. KHỐI SO (năng lực số) — MẶC ĐỊNH LUÔN VIẾT khối này cho mỗi mục, TRỪ KHI ngữ liệu gốc
   của đúng mục đang xét đã có sẵn một PHẦN/CỘT RIÊNG trình bày ĐẦY ĐỦ về năng lực số cho
   đúng mục đó (ví dụ một cột bảng tên "NLS"/"Năng lực số", hoặc một đoạn ghi rõ mục
   tiêu/kỹ năng số học sinh cần đạt). Một câu NHẮC THOÁNG QUA tên phần mềm/công cụ (ví dụ
   chỉ nói "GV dùng GeoGebra để vẽ đồ thị") KHÔNG được tính là "đã có sẵn" — trường hợp đó
   VẪN PHẢI viết khối SO, tập trung vào góc nhìn HỌC SINH: kỹ năng số cụ thể HS cần rèn
   luyện, cách HS tự thao tác/kiểm tra bằng công cụ số (không lặp lại y hệt việc GV đã làm).
   Khi viết, nêu cụ thể công cụ số/AI học sinh hoặc giáo viên có thể dùng thêm và cách dùng,
   gắn với đúng nội dung của mục đó (không viết chung chung).

   ĐỊNH DẠNG BẮT BUỘC CỦA KHỐI SO — mỗi ý phải BẮT ĐẦU bằng MÃ năng lực số tham chiếu
   đúng Khung năng lực số ban hành theo Thông tư 02/2025/TT-BGDĐT (Bộ GDĐT), theo cấu
   trúc "[miền].[năng lực thành phần].NC1[chỉ báo]" — ví dụ "5.3.NC1a", "1.1.NC1b" — rồi
   mới đến mô tả ngắn gọn, gắn với đúng nội dung của mục. Dùng mức "NC1" (Nâng cao, bậc 5)
   vì đây là chương trình THPT. Chỉ báo (a, b, c...) đặt tuỳ theo khía cạnh cụ thể của kỹ
   năng đang mô tả trong năng lực thành phần đó — không bắt buộc phải là "a" cho mọi mã.
   Chọn ĐÚNG MỘT năng lực thành phần trong bảng dưới đây sát nhất với công cụ/kỹ năng số
   sẽ nêu (không bịa mã ngoài danh sách, không dùng miền/số thành phần không có trong bảng):

   1. KHAI THÁC DỮ LIỆU VÀ THÔNG TIN: 1.1 Duyệt, tìm kiếm và lọc dữ liệu/thông tin/nội
      dung số | 1.2 Đánh giá dữ liệu, thông tin và nội dung số | 1.3 Quản lý dữ liệu,
      thông tin và nội dung số.
   2. GIAO TIẾP VÀ HỢP TÁC TRONG MÔI TRƯỜNG SỐ: 2.1 Tương tác thông qua công nghệ số |
      2.2 Chia sẻ thông tin/nội dung qua công nghệ số | 2.3 Sử dụng công nghệ số để thực
      hiện trách nhiệm công dân | 2.4 Hợp tác thông qua công nghệ số | 2.5 Thực hiện quy
      tắc ứng xử trên mạng | 2.6 Quản lý danh tính số.
   3. SÁNG TẠO NỘI DUNG SỐ: 3.1 Phát triển nội dung số | 3.2 Tích hợp và tạo lập lại nội
      dung số | 3.3 Thực thi bản quyền và giấy phép | 3.4 Lập trình.
   4. AN TOÀN: 4.1 Bảo vệ thiết bị | 4.2 Bảo vệ dữ liệu cá nhân và quyền riêng tư | 4.3 Bảo
      vệ sức khỏe và an sinh số | 4.4 Bảo vệ môi trường.
   5. GIẢI QUYẾT VẤN ĐỀ: 5.1 Giải quyết các vấn đề kỹ thuật | 5.2 Xác định nhu cầu và giải
      pháp công nghệ (chọn, dùng công cụ số phù hợp để giải quyết nhu cầu) | 5.3 Sử dụng
      sáng tạo công nghệ số (dùng công cụ số để tạo kiến thức, đổi mới cách giải quyết vấn
      đề) | 5.4 Xác định các vấn đề cần cải thiện về năng lực số.
   6. ỨNG DỤNG TRÍ TUỆ NHÂN TẠO: 6.1 Hiểu biết về AI | 6.2 Sử dụng AI có đạo đức và trách
      nhiệm | 6.3 Đánh giá các công cụ AI.

   Ví dụ đúng định dạng: "5.3.NC1b: HS sử dụng GeoGebra để dựng hình và kiểm chứng tính
   chất hình học của bài toán." — mã trước, mô tả cụ thể sau, một dòng cho mỗi ý.
5. KHỐI KT (giáo dục hòa nhập) — CHỈ viết khối này nếu lớp CÓ học sinh khuyết tật (xem danh
   sách loại khuyết tật trong phần THÔNG TIN BÀI DẠY bên dưới). Nếu lớp KHÔNG có HSKT (danh
   sách rỗng), TUYỆT ĐỐI không viết khối KT ở bất kỳ mục nào trong toàn bộ bài. Nếu lớp CÓ
   HSKT thì MẶC ĐỊNH LUÔN VIẾT khối KT cho mỗi mục, TRỪ KHI ngữ liệu gốc của đúng mục đó đã
   có sẵn một phần/cột riêng trình bày đầy đủ cách điều chỉnh cho đúng loại khuyết tật đã
   chọn (áp dụng tiêu chuẩn giống mục 4 — một câu nhắc thoáng qua không tính là "đã có sẵn").
   LƯU Ý: một cột năng lực số/công nghệ có sẵn trong ngữ liệu gốc (dùng để quyết định bỏ
   khối SO ở mục 4) KHÔNG liên quan và KHÔNG được dùng làm lý do bỏ khối KT — đây là hai chủ
   đề hoàn toàn khác nhau, quyết định độc lập với nhau. VÍ DỤ CỤ THỂ: nếu ngữ liệu gốc của
   một mục là bảng 3 cột "HOẠT ĐỘNG CỦA GV VÀ HS | SẢN PHẨM DỰ KIẾN | NLS" (đã có cột NLS
   nói về năng lực số) và lớp CÓ HSKT, thì mục đó ĐÚNG là được bỏ khối SO (vì NLS đã có),
   NHƯNG VẪN PHẢI viết khối KT đầy đủ (vì bảng đó KHÔNG có cột nào nói về hòa nhập/HSKT) —
   TUYỆT ĐỐI không được bỏ luôn cả hai khối chỉ vì bảng đã có cột NLS.
   Khi viết, mô tả hành động điều chỉnh cụ thể của GV cho từng loại khuyết tật đã chọn, gắn
   với đúng nội dung của mục đó (không viết chung chung).
6. Placeholder dạng [[EQ:CT1]], [[EQ:CT2]]... trong ngữ liệu gốc LÀ CÔNG THỨC TOÁN của bài.
   Nội dung công thức tương ứng (nếu cần hiểu để viết SO/KT cho sát) nằm ở mục "CHÚ THÍCH
   NỘI DUNG CÔNG THỨC" RIÊNG bên dưới — mục đó CHỈ để bạn tham khảo, TUYỆT ĐỐI KHÔNG chép
   bất kỳ nội dung nào từ mục chú thích đó vào bài. Trong khối GOC, khi gặp placeholder,
   CHỈ được xuất lại ĐÚNG NGUYÊN VĂN placeholder trần đó (ví dụ [[EQ:CT1]]) tại đúng vị trí
   xuất hiện trong câu — TUYỆT ĐỐI KHÔNG viết công thức ra bằng lời, không đổi sang LaTeX,
   không chép nội dung từ mục chú thích vào thay cho placeholder, không xoá placeholder.
6b. Placeholder dạng [[IMG:IMG1]], [[IMG:IMG2]]... trong ngữ liệu gốc LÀ HÌNH VẼ/ẢNH MINH HOẠ
   (ví dụ hình hình học, đồ thị, ẢNH CHỤP/VẼ BẢNG BIẾN THIÊN, ảnh chụp màn hình) — không phải
   công thức và không có văn bản thay thế. Khi gặp placeholder này trong khối GOC, CHỈ được
   xuất lại ĐÚNG NGUYÊN VĂN placeholder trần đó (ví dụ [[IMG:IMG1]]) tại đúng vị trí xuất
   hiện — TUYỆT ĐỐI KHÔNG mô tả hình bằng lời, không đoán nội dung hình để viết thay, không
   xoá placeholder. ĐẶC BIỆT: RẤT NHIỀU bảng biến thiên/bảng xét dấu trong giáo án Việt Nam
   là ẢNH (chèn bằng Insert Picture), KHÔNG phải bảng chữ — khi gặp [[IMG:xxx]] ngay sau chữ
   "Bảng biến thiên:"/"Bảng xét dấu:", TUYỆT ĐỐI KHÔNG được "vẽ lại" bảng đó bằng ký tự "|",
   bằng bảng Markdown, hay bằng bất kỳ ký hiệu văn bản nào khác (dù bạn tự suy luận được hình
   dạng bảng biến thiên đó trông ra sao) — CHỈ giữ nguyên placeholder trần, không thêm bất kỳ
   ký tự nào khác thay cho nó.
6c. Placeholder dạng [[TBL:TBL1]], [[TBL:TBL2]]... trong ngữ liệu gốc LÀ MỘT BẢNG LỒNG bên
   trong ô của bảng ngoài (ví dụ bảng xét dấu/bảng biến thiên trình bày bằng bảng Word thật —
   không phải ảnh — đặt trong cột "SẢN PHẨM DỰ KIẾN") — hệ thống sẽ tự dựng lại thành bảng
   thật khi hiển thị, bạn KHÔNG thấy được nội dung bảng đó ở đây. Khi gặp placeholder này
   trong khối GOC, CHỈ được xuất lại ĐÚNG NGUYÊN VĂN placeholder trần đó (ví dụ [[TBL:TBL1]])
   tại đúng vị trí xuất hiện trong câu — TUYỆT ĐỐI KHÔNG viết lại bảng đó bằng ký tự "|" hay
   bất kỳ hình thức nào khác, không đoán nội dung bảng để mô tả thay, không xoá placeholder.
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
  const hasHskt = types.length > 0;
  const disabilityLines = hasHskt
    ? types.map((t) => `- ${DISABILITY_LABELS[t] || t}`).join('\n')
    : '- (Lớp không có học sinh khuyết tật)';
  const hsktReminder = hasHskt
    ? 'Lớp NÀY CÓ HSKT — theo quy tắc 5, bạn PHẢI viết khối <<<KT>>> cho hầu hết các mục (chỉ bỏ khi ngữ liệu gốc của đúng mục đó đã có sẵn phần riêng đầy đủ, xem quy tắc 5).'
    : 'Lớp này KHÔNG có HSKT — TUYỆT ĐỐI không viết khối <<<KT>>> ở bất kỳ mục nào.';

  const partNote = body.partInfo
    ? `\nLƯU Ý QUAN TRỌNG: Đây CHỈ LÀ PHẦN ${body.partInfo.index}/${body.partInfo.total} của một giáo án DÀI HƠN
đã được chia nhỏ để xử lý (các phần khác được gửi ở những lượt gọi riêng biệt, rồi ghép lại
sau). TUYỆT ĐỐI KHÔNG tự thêm phần mở đầu (vd nhắc lại tên bài, mục tiêu chung) hay phần kết
luận/tổng kết cho CẢ bài — chỉ xử lý ĐÚNG nội dung của phần ${body.partInfo.index} này (chép
nguyên văn ở khối GOC + thêm cột SO/KT), y như thể đây là một đoạn trích ở giữa một tài liệu
dài hơn.\n`
    : '';

  return `THÔNG TIN BÀI DẠY
- Môn học: ${body.subject}
- Khối lớp: ${body.grade}
- Tên bài: ${body.lessonTitle}
- Số tiết: ${body.durationPeriods}
${partNote}
LOẠI KHUYẾT TẬT CỦA HSKT TRONG LỚP (nếu có):
${disabilityLines}
Ghi chú thêm của GV về HSKT: ${body.accommodation?.notes || '(không có)'}
${hsktReminder}

YÊU CẦU THÊM CỦA GIÁO VIÊN:
${body.extraRequirements || '(không có)'}

NGỮ LIỆU TRÍCH TỪ GIÁO ÁN GỐC (đây là phần khối GOC phải chép LẠI NGUYÊN VĂN — công thức
toán đã thay bằng placeholder trần [[EQ:CTx]], hình vẽ/ảnh minh hoạ đã thay bằng placeholder
trần [[IMG:IMGx]], PHẢI giữ nguyên các placeholder này đúng vị trí, không viết lại; nếu có
bảng dạng Markdown thì phải tái tạo lại đúng bảng đó):
---
${body.sourceContent || '(không trích được nội dung — hãy soạn KHBD dựa trên tên bài và môn học ở trên)'}
---

CHÚ THÍCH NỘI DUNG CÔNG THỨC (CHỈ để bạn hiểu ngữ cảnh khi viết khối SO/KT — mục này KHÔNG
phải một phần của giáo án, TUYỆT ĐỐI không chép bất kỳ dòng nào ở đây vào bài):
---
${body.equationLegend || '(không có công thức nào)'}
---

NHẮC LẠI LẦN CUỐI (quan trọng nhất, đọc kỹ trước khi viết): ${hsktReminder}`;
}

// Đếm nhanh số mục (khối GOC) và số mục đang THIẾU khối KT không rỗng, bằng
// regex đơn giản trên chính chuỗi markdown thô — KHÔNG import bộ phân tích đầy
// đủ từ src/utils/khbdParser.ts, vì import xuyên thư mục đó từng làm serverless
// function bị crash (FUNCTION_INVOCATION_FAILED) khi đóng gói trên Vercel. Bộ
// đếm này không cần chính xác tuyệt đối như parser thật — chỉ để đưa ra cảnh
// báo tham khảo cho giáo viên.
function countSectionsMissingKt(markdown: string): { total: number; missing: number } {
  const sections = markdown.split(/<<<GOC\b/).slice(1);
  let missing = 0;
  for (const sec of sections) {
    const ktMatch = sec.match(/<<<KT[^\n]*\n([\s\S]*?)\nKT>>>/);
    const hasKt = Boolean(ktMatch && ktMatch[1].trim().length > 0);
    if (!hasKt) missing++;
  }
  return { total: sections.length, missing };
}

// Kiểm tra placeholder [[EQ:...]]/[[IMG:...]]/[[TBL:...]] có trong ngữ liệu
// gốc gửi cho AI (body.sourceContent) mà KHÔNG còn xuất hiện trong markdown
// AI trả về — dấu hiệu AI đã "viết lại" hoặc bỏ mất công thức/hình vẽ/bảng
// lồng thay vì giữ nguyên placeholder như quy tắc 6/6b/6c yêu cầu. Ví dụ thực
// tế đã gặp: một bảng biến thiên vốn là ẢNH ([[IMG:xxx]]) bị AI "vẽ lại" bằng
// ký tự "|" thành bảng chữ, làm mất mũi tên/hình ảnh gốc và đôi khi để lộ cú
// pháp bảng hỏng ra bài. Không thể tự sửa an toàn (không biết chính xác đoạn
// văn nào AI đã tự viết ra để mà xoá) nên chỉ cảnh báo cho giáo viên kiểm tra.
function findMissingPlaceholders(sourceContent: string, markdown: string): string[] {
  const placeholderRe = /\[\[(?:EQ|IMG|TBL):[^\]]+\]\]/g;
  const sourceSet = new Set(sourceContent.match(placeholderRe) || []);
  const outputSet = new Set(markdown.match(placeholderRe) || []);
  return [...sourceSet].filter((p) => !outputSet.has(p));
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const startedAt = Date.now();
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

  // Vercel giới hạn CỨNG hàm này 60s (vercel.json: maxDuration) rồi tự "giết"
  // và trả 504 — dù code có đang retry dở dang cũng không kịp trả lỗi gọn gàng.
  // Vì vậy MỌI lần thử lại/đổi model dự phòng bên dưới đều phải tự kiểm tra
  // còn bao nhiêu thời gian TRƯỚC khi thử thêm, và DỪNG SỚM (trả lỗi 503 gọn
  // gàng ngay) nếu không còn đủ ngân sách — thà báo lỗi rõ ràng còn hơn để
  // Vercel ngắt đột ngột giữa chừng thành 504 khó hiểu.
  const TIME_BUDGET_MS = 50_000; // chừa ~10s so với maxDuration=60 để kịp dựng + gửi response
  const remainingMs = () => TIME_BUDGET_MS - (Date.now() - startedAt);

  // Giáo án gốc càng dài, một lượt sinh bằng model thường càng dễ vượt quá
  // ngân sách 50-60s dù không hề bị quá tải (503) — đây là nguyên nhân khác
  // hẳn với lỗi quá tải mà cơ chế retry ở dưới xử lý được. Vì vậy với giáo án
  // dài, ưu tiên dùng LITE_MODEL ngay từ đầu để giảm hẳn rủi ro timeout.
  const sourceLen = (body?.sourceContent || '').length;
  const isLongDoc = !AUTO_LITE_DISABLED && sourceLen > LONG_DOC_CHAR_THRESHOLD;
  const primaryModel = isLongDoc ? LITE_MODEL : MODEL;

  // Ngân sách token lớn vì khối GOC phải chép nguyên văn toàn bộ giáo án gốc +
  // thêm cột SO/KT -> output dài hơn nhiều so với việc chỉ tóm tắt/viết lại,
  // cần đủ chỗ để không bị cắt giữa chừng (MAX_TOKENS).
  function buildRequestBody(includeThinkingConfig: boolean) {
    const generationConfig: Record<string, unknown> = { maxOutputTokens: 32768 };
    if (includeThinkingConfig) {
      // Việc này chủ yếu là tuân thủ định dạng + chép lại đúng, không cần suy
      // luận sâu -> tắt "thinking" để dành trọn ngân sách token cho nội dung
      // thật. KHÔNG PHẢI model nào cũng nhận tham số này (vd một số bản "lite"
      // chỉ nhận thinkingLevel, không nhận thinkingBudget) -> nếu Gemini báo
      // lỗi 400 vì tham số này, code bên dưới tự thử lại mà không có nó.
      generationConfig.thinkingConfig = { thinkingBudget: 0 };
    }
    return JSON.stringify({
      system_instruction: { parts: [{ text: buildSystemPrompt() }] },
      contents: [{ role: 'user', parts: [{ text: buildUserPrompt(body) }] }],
      generationConfig,
    });
  }

  // Nếu một lượt gọi Gemini (không hề bị 503/429, chỉ đơn giản là XỬ LÝ LÂU vì
  // giáo án dài) chạy quá lâu, Vercel sẽ tự "giết" cả hàm ở mốc maxDuration mà
  // KHÔNG cho code kịp trả JSON lỗi — client nhận một 504 trần trụi không rõ
  // nguyên nhân. Để tránh việc này, TỰ ngắt (AbortController) mỗi lượt gọi
  // Gemini trước khi hết ngân sách thời gian, để luôn còn cơ hội trả về một
  // thông báo lỗi rõ ràng, đúng nguyên nhân cho giáo viên.
  class GeminiTimeoutError extends Error {}
  const RESPONSE_BUILD_BUFFER_MS = 4_000; // chừa thời gian đọc response + dựng + gửi JSON lỗi

  async function callGemini(model: string, includeThinkingConfig: boolean) {
    const deadline = Math.max(remainingMs() - RESPONSE_BUILD_BUFFER_MS, 500);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deadline);
    try {
      return await fetch(urlFor(model), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Header (thay vì query param ?key=...) để key không bị lộ trong access log.
          'x-goog-api-key': apiKey,
        },
        body: buildRequestBody(includeThinkingConfig),
        signal: controller.signal,
      });
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        throw new GeminiTimeoutError(
          `Gemini (model "${model}") xử lý quá lâu (giáo án dài ${sourceLen.toLocaleString('vi-VN')} ký tự) — đã tự ngắt sau khi chờ quá thời gian cho phép.`
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // 503 (UNAVAILABLE, "quá tải") và 429 (rate limit) là lỗi TẠM THỜI ở phía
  // Google, không phải lỗi ở code hay ở dữ liệu giáo án của giáo viên -> tự
  // thử lại vài lần với thời gian chờ tăng dần trước khi coi là thất bại thật
  // sự — NHƯNG chỉ khi ngân sách thời gian còn lại (xem TIME_BUDGET_MS ở trên)
  // đủ chỗ cho ít nhất một lần thử nữa; nếu sắp hết giờ, dừng ngay và trả lỗi
  // luôn thay vì liều thử thêm rồi bị Vercel ngắt giữa chừng thành 504.
  const RETRYABLE_STATUSES = new Set([429, 503]);
  const RETRY_DELAYS_MS = [1500, 3500];
  // Thời gian tối thiểu cần còn lại để đáng thử thêm một lần: 503/429 thường
  // trả về gần như ngay lập tức (không tốn nhiều giây xử lý thật), nên chỉ cần
  // chừa đủ cho độ trễ chờ (delay) + một khoảng dư an toàn.
  const MIN_MS_FOR_ONE_MORE_TRY = 4_000;

  async function callGeminiWithRetry(model: string, includeThinkingConfig: boolean) {
    let response: Response;
    let attempts = 1;
    try {
      response = await callGemini(model, includeThinkingConfig);
    } catch (err) {
      if (err instanceof GeminiTimeoutError) return { response: null, attempts, timeoutErr: err };
      throw err;
    }
    for (const delay of RETRY_DELAYS_MS) {
      if (response.ok || !RETRYABLE_STATUSES.has(response.status)) break;
      if (remainingMs() < delay + MIN_MS_FOR_ONE_MORE_TRY) break;
      await sleep(delay);
      try {
        response = await callGemini(model, includeThinkingConfig);
      } catch (err) {
        if (err instanceof GeminiTimeoutError) return { response: null, attempts: attempts + 1, timeoutErr: err };
        throw err;
      }
      attempts++;
    }
    return { response, attempts, timeoutErr: undefined as GeminiTimeoutError | undefined };
  }

  try {
    let { response, attempts, timeoutErr } = await callGeminiWithRetry(primaryModel, true);

    // Model chính hết giờ (không phải quá tải kiểu 503, mà là XỬ LÝ CHẬM —
    // thường do bản thân Gemini đang tải cao, không hồi đáp nhanh dù input
    // không hề dài) -> thử lần lượt các model KHÁC chưa dùng, miễn còn đủ
    // ngân sách cho một lượt thử nữa. Không thử lại y model vừa timeout —
    // model đó vừa chứng minh nó đang chậm.
    const modelsTriedOnTimeout = new Set([primaryModel]);
    const timeoutFallbackOrder = [LITE_MODEL, FALLBACK_MODEL, MODEL].filter((m) => !modelsTriedOnTimeout.has(m));
    for (const nextModel of timeoutFallbackOrder) {
      if (!timeoutErr) break;
      if (remainingMs() < 15_000) break;
      modelsTriedOnTimeout.add(nextModel);
      ({ response, attempts, timeoutErr } = await callGeminiWithRetry(nextModel, true));
    }

    function sendTimeoutError(err: InstanceType<typeof GeminiTimeoutError>) {
      res.status(503).json({
        error: `${err.message} Đây là giáo án dài, cần nhiều thời gian xử lý hơn mức server hiện cho phép (hoặc Gemini đang phản hồi chậm bất thường do tải cao). Thử: (1) soạn lại sau vài phút — hệ thống đã tự thử nhiều model khác nhau, (2) chia nhỏ giáo án gốc thành từng phần rồi soạn riêng từng phần, hoặc (3) nếu dùng gói Vercel Pro, tăng "maxDuration" trong vercel.json lên 120-300 giây rồi deploy lại.`,
      });
    }

    if (timeoutErr) {
      sendTimeoutError(timeoutErr);
      return;
    }
    if (!response) {
      res.status(500).json({ error: 'Lỗi không xác định: không nhận được phản hồi từ Gemini.' });
      return;
    }

    if (!response.ok && response.status === 400) {
      const firstErrText = await response.text();
      if (firstErrText.includes('INVALID_ARGUMENT')) {
        // Model hiện tại (vd một số bản "lite") có thể không nhận thinkingConfig
        // theo dạng này -> thử lại một lần, bỏ hẳn tham số đó.
        ({ response, attempts, timeoutErr } = await callGeminiWithRetry(primaryModel, false));
        if (timeoutErr) {
          sendTimeoutError(timeoutErr);
          return;
        }
      } else {
        res.status(400).json({ error: `Lỗi từ Gemini API: ${firstErrText}` });
        return;
      }
    }

    // Model chính vẫn quá tải sau khi đã thử lại nhiều lần -> thử 1 lần với
    // model dự phòng, NHƯNG chỉ khi còn đủ thời gian cho một lượt sinh nội
    // dung ĐẦY ĐỦ (không chỉ một lần fail nhanh) — vì nếu model dự phòng lại
    // xử lý được (không quá tải) thì nó sẽ chạy hết một lượt sinh KHBD thật sự
    // dài, có thể tốn 20-40s cho giáo án dài, chứ không trả lời ngay như khi
    // bị 503. Nếu không đủ ngân sách, bỏ qua bước này để tránh bị Vercel ngắt
    // giữa chừng thành 504.
    const MIN_MS_FOR_FALLBACK_ATTEMPT = 20_000;
    if (
      response &&
      !response.ok &&
      RETRYABLE_STATUSES.has(response.status) &&
      FALLBACK_MODEL !== primaryModel &&
      remainingMs() >= MIN_MS_FOR_FALLBACK_ATTEMPT
    ) {
      await sleep(1500);
      ({ response, attempts, timeoutErr } = await callGeminiWithRetry(FALLBACK_MODEL, true));
      if (timeoutErr) {
        sendTimeoutError(timeoutErr);
        return;
      }
    }

    if (!response || !response.ok) {
      const errText = response ? await response.text() : '(không có phản hồi)';
      if (response && RETRYABLE_STATUSES.has(response.status)) {
        res.status(503).json({
          error: `Hệ thống AI (Gemini) đang quá tải, đã tự động thử lại ${attempts} lần nhưng vẫn chưa được. Đây là lỗi tạm thời từ phía Google (KHÔNG PHẢI lỗi trong giáo án hay tài khoản của bạn) — vui lòng đợi khoảng 30 giây đến 1 phút rồi bấm "Soạn KHBD" lại.`,
        });
      } else {
        res.status(response ? response.status : 500).json({ error: `Lỗi từ Gemini API: ${errText}` });
      }
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

    const missingPlaceholders = findMissingPlaceholders(body.sourceContent || '', markdown);
    if (missingPlaceholders.length > 0) {
      const imgN = missingPlaceholders.filter((p) => p.startsWith('[[IMG:')).length;
      const eqN = missingPlaceholders.filter((p) => p.startsWith('[[EQ:')).length;
      const tblN = missingPlaceholders.filter((p) => p.startsWith('[[TBL:')).length;
      const parts = [
        imgN ? `${imgN} hình vẽ/ảnh` : '',
        eqN ? `${eqN} công thức` : '',
        tblN ? `${tblN} bảng lồng` : '',
      ].filter(Boolean);
      warnings.push(
        `AI có thể đã bỏ mất hoặc VIẾT LẠI thay vì giữ nguyên ${parts.join(', ')} từ file gốc (ví dụ vẽ lại bảng biến thiên bằng ký tự "|" thay vì giữ ảnh gốc) — kiểm tra kỹ các mục liên quan trong bản xem trước, đối chiếu với file Word gốc nếu cần.`
      );
    }

    // Đếm CHI TIẾT theo từng mục (không chỉ kiểm tra "có ít nhất 1 khối KT trong
    // cả bài") — vì AI có thể viết khối KT cho một vài mục rồi bỏ sót các mục
    // còn lại (đúng kiểu lỗi thực tế đã gặp: một mục là bảng có sẵn cột NLS thì
    // bị bỏ luôn cả khối KT dù không liên quan) — kiểm tra tổng thể trước đây
    // sẽ bỏ lọt trường hợp này vì chỉ cần 1 mục có KT là qua được.
    const hasHskt = (body.accommodation?.types || []).length > 0;
    if (hasHskt) {
      const { total, missing } = countSectionsMissingKt(markdown);
      if (total > 0 && missing === total) {
        warnings.push('Lớp có HSKT nhưng AI không tạo cột giáo dục hòa nhập ở mục nào — có thể cần soạn lại hoặc bổ sung thủ công.');
      } else if (missing > 0) {
        warnings.push(`Lớp có HSKT nhưng ${missing}/${total} mục đang THIẾU cột giáo dục hòa nhập — kiểm tra kỹ bản xem trước, bổ sung thủ công cho các mục còn thiếu nếu cần.`);
      }
    }

    res.status(200).json({ markdown, warnings });
  } catch (err: any) {
    res.status(500).json({ error: `Lỗi máy chủ: ${err.message || String(err)}` });
  }
}
