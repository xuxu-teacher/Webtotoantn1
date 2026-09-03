# Soạn Kế Hoạch Bài Dạy — Năng lực số & AI

Ứng dụng React + TypeScript: giáo viên đẩy file giáo án Word (.docx) gốc lên, chọn
thông tin lớp (môn, khối, loại khuyết tật của HSKT nếu có), AI sẽ soạn lại thành một
Kế hoạch bài dạy (KHBD) đầy đủ theo khung hiện hành, có tích hợp mục năng lực số/AI và
điều chỉnh riêng cho học sinh khuyết tật — rồi xuất ra file Word để nộp/lưu.

## Cấu trúc dự án

```
src/
  components/       Giao diện: upload, form, checkbox HSKT, preview, render công thức
  utils/
    docxParser.ts        Đọc .docx: trích văn bản đúng thứ tự + placeholder công thức [[EQ:CTx]]
    ommlAst.ts           Dựng cây cú pháp MathNode từ OMML (công thức Word gốc)
    mathToMathml.ts       MathNode -> MathML, để MathJax hiển thị đúng chuẩn
    mathToDocx.ts         MathNode -> object công thức thật của thư viện `docx`
    khbdParser.ts         Phân tích định dạng 2 cột <<<TRAI/PHAI>>> AI trả về
    lessonPlanTemplate.ts Khung prompt cho AI (đối chiếu logic ở api/generate.ts)
    aiClient.ts           Gọi API backend /api/generate
    exportDocx.ts         Xuất KHBD ra .docx: bảng 2 cột thật + công thức thật
  types/index.ts      Kiểu dữ liệu dùng chung
api/generate.ts     Vercel Serverless Function — gọi Anthropic API (API key giữ ở server)
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
  trong `document.xml` — Word chỉ lưu ảnh render sẵn. App phát hiện qua `ProgID` của
  `o:OLEObject` (chứa "Equation"/"MathType"), vẫn chèn placeholder để AI không viết
  đè lên vị trí đó, nhưng khi hiển thị/xuất file sẽ ghi rõ "không trích được — xem
  file gốc". Khắc phục: mở file gốc, gõ lại công thức đó bằng Insert Equation của
  Word trước khi đẩy lên.
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

### Chất lượng nội dung do AI sinh ra
- AI có thể diễn đạt sai lệch nội dung chuyên môn nếu văn bản gốc trích xuất bị thiếu
  ngữ cảnh (đặc biệt với công thức OLE không trích được). Luôn đọc lại và chỉnh sửa
  trước khi sử dụng chính thức — công cụ này hỗ trợ soạn thảo, không thay thế việc
  giáo viên kiểm duyệt nội dung.

## Có thể mở rộng thêm

- Lưu lịch sử các KHBD đã soạn (thêm Supabase, giống các dự án khác của bạn).
- Cho phép chọn nhiều mẫu khung KHBD khác nhau theo cấp học (Tiểu học/THCS/THPT).
- Thêm xử lý ảnh chèn trong giáo án gốc (hiện tại `docxParser.ts` bỏ qua ảnh, chỉ giữ
  văn bản + công thức).
