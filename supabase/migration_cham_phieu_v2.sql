-- CẬP NHẬT CHẤM PHIẾU (bản 2) — chạy 1 lần trong Supabase → SQL Editor. Chạy lại nhiều lần cũng không sao.
-- Khổ phiếu (nửa trang / 1 trang A4) và phạm vi chấm (chỉ Phần I + II) lưu trong cột config (jsonb) có sẵn -> KHÔNG cần cột mới.
-- Cột dưới đây là TUỲ CHỌN: lưu cảnh báo lúc máy đọc phiếu để đếm "bài từng có cảnh báo" ở trang kết quả.
-- Chưa chạy thì web vẫn lưu điểm bình thường (chỉ không đếm được mục này).

alter table paper_sheets add column if not exists read_flags jsonb not null default '{}'::jsonb;

notify pgrst, 'reload schema';
