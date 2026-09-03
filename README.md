# Soạn Kế Hoạch Bài Dạy — Năng lực số & AI

Ứng dụng React + TypeScript: giáo viên đẩy file giáo án Word (.docx) gốc lên, chọn
thông tin lớp (môn, khối, loại khuyết tật của HSKT nếu có), AI sẽ soạn lại thành một
Kế hoạch bài dạy (KHBD) đầy đủ theo khung hiện hành, có tích hợp mục năng lực số/AI và
điều chỉnh riêng cho học sinh khuyết tật — rồi xuất ra file Word để nộp/lưu.

## Cấu trúc dự án

```
src/
  components/       Giao diện: toolbar, upload, checkbox HSKT, preview, hiển thị công thức
  utils/
    docxParser.ts        Đọc .docx: trích văn bản đúng thứ tự + placeholder [[EQ:CTx]] + ảnh OLE
    ommlAst.ts           Dựng cây cú pháp MathNode từ OMML (công thức Word gốc)
    mathToMathml.ts       MathNode -> MathML, để MathJax hiển thị đúng chuẩn
    mathToDocx.ts         MathNode -> object công thức thật của thư viện `docx`
    khbdParser.ts         Phân tích định dạng 2 cột <<<TRAI/PHAI>>> AI trả về
    lessonPlanTemplate.ts Khung prompt cho AI (đối chiếu logic ở api/generate.ts)
    aiClient.ts           Gọi API backend /api/generate
    exportDocx.ts         Xuất KHBD ra .docx: bảng 2 cột thật + công thức/ảnh thật
    mathToLinearText.ts   MathNode -> text tuyến tính (fallback xuất Word + gợi ý cho AI)
    aiSourceBuilder.ts     Dựng ngữ liệu gửi AI (placeholder + gợi ý nội dung công thức)
    mathTypeConverterClient.ts  Gọi thẳng máy chủ MathType->LaTeX riêng của bạn từ trình duyệt
  types/index.ts      Kiểu dữ liệu dùng chung
api/generate.ts      Vercel Serverless Function — gọi Anthropic API (API key giữ ở server)
api/health.ts        Endpoint kiểm tra server đã cấu hình ANTHROPIC_API_KEY chưa
```

## Chạy thử local

```bash
npm install
# Cần Vercel CLI để chạy được cả /api (serverless function) lúc dev:
npm install -g vercel
cp .env.example .env.local   # điền ANTHROPIC_API_KEY thật vào .env.local
vercel dev
```

Nếu chỉ chạy `npm run dev` (Vite thuần) thì phần giao diện chạy được nhưng nút
"Soạn KHBD bằng AI" sẽ lỗi vì không có `/api/generate` — cần `vercel dev` hoặc tự viết
một backend Express tương đương và trỏ proxy trong `vite.config.ts`.

## Triển khai lên Vercel

1. Đẩy thư mục này lên một repo Git (GitHub/GitLab).
2. Import repo vào Vercel (tương tự các dự án Supabase/Vercel khác bạn đang có).
3. Vào **Project Settings → Environment Variables**, thêm `ANTHROPIC_API_KEY`
   (lấy tại console.anthropic.com). Không đưa key này vào code phía client.
4. Deploy. Vercel tự nhận diện `api/generate.ts` là serverless function.

## Kiểm tra cấu hình API key

Truy cập `/api/health` sẽ trả về `{ "hasApiKey": true|false }`. App tự gọi endpoint
này lúc tải trang — nếu server chưa có `ANTHROPIC_API_KEY`, một banner vàng sẽ hiện
ở đầu trang thay vì để bạn phải bấm nút rồi mới biết bị lỗi 500. Nếu chạy `vite`
thuần (không có `/api`), banner sẽ không hiện (không xác định được, không phải là
"đã cấu hình đúng") — đây là hành vi có chủ đích để tránh cảnh báo sai lúc dev.

## Vì sao API key nằm ở server, không gọi thẳng từ trình duyệt?

Nếu gọi Anthropic API trực tiếp từ React, bạn buộc phải nhúng API key vào code
client — ai mở DevTools cũng lấy được key và dùng ké chi phí của bạn. Vì vậy khoá
được giữ trong biến môi trường của serverless function, trình duyệt chỉ gọi vào
`/api/generate` do chính bạn triển khai.

## Kiến trúc xử lý công thức toán (quan trọng)

Thay vì để AI "đọc và viết lại" công thức bằng LaTeX (dễ sai lệch), pipeline giữ
nguyên cấu trúc công thức gốc xuyên suốt:

1. `docxParser.ts` đọc trực tiếp `word/document.xml` (giữ đúng thứ tự nội dung nhờ
   `fast-xml-parser` chế độ `preserveOrder`), mỗi công thức `<m:oMath>` được thay
   bằng một placeholder `[[EQ:CT1]]`, `[[EQ:CT2]]`… ngay tại vị trí xuất hiện.
2. `ommlAst.ts` dựng công thức đó thành cây cú pháp `MathNode` (phân số, số mũ, căn,
   ngoặc, tổng/tích phân, ma trận…).
3. AI chỉ nhận văn bản kèm placeholder, và được yêu cầu **giữ nguyên placeholder,
   không viết lại công thức** — nội dung chuyên môn AI xử lý, còn công thức thì
   không bao giờ đi qua "bộ lọc ngôn ngữ" của AI.
4. Khi hiển thị: `mathToMathml.ts` chuyển `MathNode` → chuỗi MathML chuẩn, và
   **MathJax** (thư viện toán học phổ biến, tải qua CDN trong `index.html`, xem
   `MathRenderer.tsx`) render trực tiếp từ MathML — không qua bước trung gian LaTeX
   tự chế nào, nên hiển thị đúng chuẩn toán học.
5. Khi xuất Word: `mathToDocx.ts` dựng lại `MathNode` thành **object công thức thật**
   của thư viện `docx` (Math, MathFraction, MathSuperScript, MathSubScript,
   MathRadical, MathRoundBrackets…) — mở file trong Word sẽ thấy công thức có thể
   bấm sửa như công thức bình thường, không phải chữ nghiêng giả lập.

### Giới hạn còn lại

- **Công thức MathType kiểu OLE cũ** (chèn bằng phần mềm MathType rời hoặc Equation
  Editor 3.0 đời cũ, không phải Insert Equation của Word) không có dữ liệu cấu trúc
  trong `document.xml` — Word chỉ lưu ảnh xem trước. App phát hiện qua `ProgID` của
  `o:OLEObject` (chứa "Equation"/"MathType"), rồi trích luôn ảnh xem trước đó từ
  `word/media/` (qua bảng quan hệ `word/_rels/document.xml.rels`):
  - Nếu ảnh là **PNG/JPEG/GIF/BMP** → hiển thị được thẳng, và được **nhúng lại thành
    ảnh thật** trong file Word xuất ra (đúng kích thước Word đã đặt).
  - Nếu ảnh là **WMF/EMF** (Windows Metafile — định dạng MathType hay dùng cho bản
    xem trước) → đây là **giới hạn thật của nền tảng web**: không trình duyệt nào
    giải mã được WMF/EMF bằng JavaScript thuần, và thư viện `docx` cũng không hỗ trợ
    nhúng 2 định dạng này. App cho **tải ảnh gốc về** (nút 📎 trong bản xem trước) để
    bạn tự chèn lại bằng Word, hoặc mở bằng Paint/LibreOffice để chuyển sang PNG rồi
    dùng lại. Cách xử lý triệt để duy nhất: mở file gốc, gõ lại công thức đó bằng
    **Insert Equation** của Word (khi đó trở thành công thức số hoá đầy đủ, sửa được).
- **Công thức phức tạp khi xuất Word**: các cấu trúc ít gặp hơn (tổng/tích phân có
  cận, ma trận, dấu gạch ngang/mũ accent) chưa có API tương ứng ổn định trong thư
  viện `docx` nên được xuất dưới dạng văn bản công thức tuyến tính (ví dụ
  `∑_(i=1)^(n)(...)`) đặt trong đúng object công thức (font Cambria Math) — vẫn đúng
  nội dung, chỉ là chưa "bấm sửa từng phần" được như công thức chuẩn. Phân số, số
  mũ, chỉ số dưới, căn, ngoặc tròn thì đã là object chuẩn đầy đủ.
- Vì phần cài `npm install` cần tải gói từ registry, bản dựng này **chưa được build
  thử trong sandbox** (môi trường tạo mã không có mạng ra ngoài) — khi bạn `npm
  install` và `vercel dev` lần đầu, nếu gặp lỗi kiểu tên export không khớp phiên bản
  `docx` (ví dụ API `Math`/`MathRadical` đổi tên giữa các bản), báo lại để chỉnh, vì
  đây là điểm duy nhất chưa xác minh được bằng cách chạy thực tế.

### Bố cục 2 cột — năng lực số & giáo dục hòa nhập

AI được yêu cầu trả lời theo một định dạng có cấu trúc riêng (xem
`lessonPlanTemplate.ts` / `api/generate.ts`, hàm `buildSystemPrompt`): mỗi mục KHBD
đi kèm đúng một cặp khối `<<<TRAI ... TRAI>>>` (nội dung giáo án) và
`<<<PHAI ... PHAI>>>` (năng lực số & giáo dục hòa nhập). Hệ thống tự phân tích cặp
khối này (`khbdParser.ts`) và luôn render thành **một hàng bảng 2 cột thật** — cả ở
bản xem trước (web) lẫn file Word xuất ra — nên nội dung năng lực số/hòa nhập không
bao giờ bị AI chèn lẫn vào cột trái.

### Khung "năng lực số" và quy định Bộ GD&ĐT 2026
- Các thông tư/công văn về khung năng lực số và tích hợp AI trong giáo án tiếp tục
  được cập nhật theo từng năm học. Prompt trong `api/generate.ts` (hàm
  `buildSystemPrompt`) mã hoá cấu trúc KHBD nền theo tinh thần Công văn 5512 và bổ sung
  mục năng lực số/AI theo định hướng chung hiện hành — đây là **một điểm duy nhất**
  bạn cần chỉnh sửa khi có văn bản chính thức mới, không phải sửa rải rác trong code.
- Trước khi ban hành chính thức, đối chiếu KHBD do AI soạn với văn bản mới nhất của
  Sở/Phòng GD&ĐT nơi bạn công tác.

### Các phần khác đã cập nhật

- **Logo**: `src/components/SchoolLogo.tsx` là huy hiệu SVG tự thiết kế (không sao
  chép logo chính thức nào — mình không có file thật của trường). Nếu bạn có file
  logo chính thức, thay nội dung component này bằng `<img src="/logo-truong.png" />`
  — sửa đúng 1 file, mọi chỗ dùng `<SchoolLogo />` tự cập nhật.
- **Header tài liệu (tự ghi)**: ô nhập ngay dưới tiêu đề trang — nội dung gõ vào (ví
  dụ tên trường/tổ chuyên môn/GV soạn) được in căn giữa ở đầu file Word xuất ra, và
  hiện trước bản xem trước KHBD.
- **Tự động điền tên bài** khi upload: `docxParser.ts` thử tìm theo thứ tự — (1)
  đoạn có style Heading/Title trong file Word, (2) dòng bắt đầu bằng "BÀI"/"CHỦ
  ĐỀ"/"CHUYÊN ĐỀ" trong 25 dòng đầu, (3) suy từ tên file (bỏ mã số/hậu tố viết tắt
  đầu-cuối). Đây chỉ là **gợi ý** — nếu bạn tự gõ vào ô Tên bài học, gợi ý sẽ không
  ghi đè lên nữa (kể cả khi upload file khác sau đó).
- **Khối lớp**: dropdown chỉ còn Lớp 10, 11, 12 (`GRADE_OPTIONS` trong
  `src/types/index.ts` — muốn đổi lại thì sửa mảng này).

## Chất lượng nội dung do AI sinh ra
- AI có thể diễn đạt sai lệch nội dung chuyên môn nếu văn bản gốc trích xuất bị thiếu
  ngữ cảnh (đặc biệt với công thức OLE không trích được). Luôn đọc lại và chỉnh sửa
  trước khi sử dụng chính thức — công cụ này hỗ trợ soạn thảo, không thay thế việc
  giáo viên kiểm duyệt nội dung.

## Tích hợp máy chủ MathType→LaTeX riêng của bạn

Đã nối theo đúng API thật lấy từ code project cũ của bạn
(`services/mathWordParserService.ts`), không còn là giả định nữa:

```
GET  {VITE_MATHTYPE_SERVER_URL}/health          -> đánh thức server (Render free tier ngủ đông)
POST {VITE_MATHTYPE_SERVER_URL}/v1/convert
     body:     { items: [{ id, ole_b64 }], wrap: true }
     response: { results: [{ id, latex, error? }] }
```

Luồng hoạt động:

1. Với mỗi công thức OLE, app đã trích sẵn dữ liệu **OLE gốc** (`.bin` chứa MTEF
   nhị phân) lúc đọc file — xem `docxParser.ts`.
2. Bấm nút "🔄 Chuyển đổi N công thức bằng máy chủ MathType→LaTeX" (hiện dưới
   phần tóm tắt sau khi upload) → `mathTypeConverterClient.ts` gọi **thẳng từ
   trình duyệt** tới server của bạn — TOÀN BỘ công thức trong **một request duy
   nhất** (đúng như server được thiết kế để nhận, không gọi từng cái một).
3. LaTeX trả về được hiển thị bằng MathJax, và dùng làm gợi ý nội dung công thức
   gửi cho AI (xem `aiSourceBuilder.ts`).

**Vì sao gọi thẳng từ trình duyệt, không qua serverless function của app** (khác
với cách giấu `ANTHROPIC_API_KEY`): server MathType chạy trên Render free tier
sẽ ngủ đông khi không có traffic, cold-start có thể mất 60-90 giây để đánh thức.
Một hàm serverless của Vercel có giới hạn thời gian chạy (Hobby: 10 giây) sẽ bị
timeout trước khi server kịp thức dậy. Gọi thẳng từ trình duyệt (giống hệt cách
project cũ của bạn đã làm, qua biến `VITE_MATHTYPE_SERVER_URL`) không bị giới
hạn này. Biến này là build-time và sẽ lộ trong bundle client — an toàn vì chỉ là
một URL công khai, server không yêu cầu API key.

Khai báo `VITE_MATHTYPE_SERVER_URL` trong Vercel Environment Variables (áp dụng
cho môi trường Production/Preview, và nhớ **Redeploy** sau khi thêm — biến
`VITE_` chỉ được đọc lúc build, thêm biến xong mà không deploy lại thì bundle cũ
vẫn không có giá trị này, đúng như tình huống bạn từng gặp ở project cũ).

Nếu server của bạn có domain khác hoặc cần thêm xác thực, sửa
`src/utils/mathTypeConverterClient.ts` — mọi thứ nằm gọn trong 1 file.

## Có thể mở rộng thêm

- Lưu lịch sử các KHBD đã soạn (thêm Supabase, giống các dự án khác của bạn).
- Cho phép chọn nhiều mẫu khung KHBD khác nhau theo cấp học (Tiểu học/THCS/THPT).
- Thêm xử lý ảnh chèn trong giáo án gốc (hiện tại `docxParser.ts` bỏ qua ảnh, chỉ giữ
  văn bản + công thức).
