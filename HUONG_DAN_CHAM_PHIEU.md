# Chấm phiếu tô ô — web tổ Toán

Địa chỉ: `<tên miền web tổ>/cham-phieu` (trang soạn KHBD có thêm nút **📷 Chấm phiếu** ở góc trên).

## Cài đặt (làm 1 lần)

### Bước 1 — Tạo Supabase cho tổ
1. Vào supabase.com → **New project** (gói Free). Đặt tên, ví dụ `to-toan-tn1`.
2. Mở **SQL Editor** → dán toàn bộ file `supabase/schema_cham_phieu.sql` → **Run**.
   - Dòng `admin_emails()` trong file là email quản trị viên (đăng ký bằng email này thì tự là quản trị và được duyệt sẵn). Muốn đổi thì sửa rồi chạy lại.
3. **Authentication → Sign In / Providers → Email**: nên **tắt "Confirm email"** (vì cô đã duyệt từng tài khoản; gói Free chỉ gửi được rất ít email mỗi giờ).
4. **Authentication → URL Configuration → Site URL**: điền `https://<tên miền web tổ>/cham-phieu` (dùng cho link "Quên mật khẩu").
5. **Project Settings → API**: chép **Project URL** và khoá **anon public**.

### Bước 2 — Biến môi trường Vercel (project web tổ)
Project Settings → Environment Variables, thêm:

| Tên | Giá trị |
|---|---|
| `VITE_SUPABASE_URL` | Project URL ở bước 1.5 |
| `VITE_SUPABASE_ANON_KEY` | khoá anon public ở bước 1.5 |

`GEMINI_API_KEY` đã có sẵn — dùng chung. Tuỳ chọn: `OMR_MODELS` = danh sách model đọc chữ viết tay (cách nhau dấu phẩy; model 1 và 2 dùng cho 2 lần đọc đối chiếu).

### Bước 3 — Tải code lên GitHub (Upload files, giữ nguyên đường dẫn thư mục) rồi Redeploy

## Sử dụng
1. Cô đăng ký tài khoản bằng email quản trị → dùng được ngay.
2. Giáo viên trong tổ vào `/cham-phieu` → **Đăng ký** → báo cô. Cô vào **🔑 Duyệt giáo viên** → **Duyệt**.
3. (Phiếu lớp) **👥 Lớp & học sinh** → thêm lớp, dán danh sách học sinh đúng thứ tự STT.
4. **📷 Chấm phiếu** → tạo đợt chấm (phiếu trường 40–6–8 cắt phách, hoặc phiếu lớp do web in) → nhập đáp án → chấm → kết quả, xuất Excel, ghép phách.

## Lưu ý về độ chính xác
- Phần I, II đọc bằng xử lý ảnh (không dùng AI). Ô tô 2 lần, tô mờ, vết tẩy, hàng ô không khớp vị trí (ảnh mờ / giấy cong / bị che) → **tô vàng**, không tự đoán.
- **Đáp án đọc từ bảng (PDF/ảnh) luôn phải được cô đối chiếu** với ảnh bảng gốc hiện bên cạnh rồi bấm "Đã rà xong" mới lưu được. PDF xuất từ Word được đọc kèm lớp chữ của PDF (chính xác hơn ảnh scan).
- Cách chắc chắn nhất: tô đáp án lên một tờ phiếu rồi chụp (máy đọc bằng xử lý ảnh), hoặc nhập trực tiếp trên lưới.
- Phần III: học sinh ghi phân số (VD 13/4, hoặc 13 trên 4) có giá trị bằng đáp án (3,25) → tính đúng. Đáp án có từ 2 chữ số thập phân trở lên thì phân số làm tròn bằng đáp án cũng tính đúng (2/3 ≈ 0,67).
- Chụp cả tờ, thấy đủ 6 ô vuông đen ■ quanh Phần I; đặt phẳng, đủ sáng.
