# Cập nhật Phần III – lưới tô ô chuẩn Bộ GD&ĐT (phiếu lớp do web tạo)

## Thay đổi
- `utils/sheetTemplates.ts`: lưới Phần III (6 câu/hàng, mỗi câu 4 cột × 12 hàng: − , 0–9; r = 2,0 mm, bước hàng 4,8 mm, bước cột 5,6 mm),
  ô ghi nháp (không đọc), chữ số xám nhạt trong ô viền đen; thêm 2 mốc ■ ở mép trái/phải ngang tâm lưới;
  mã cấu trúc: trường n3 = số câu + 16 khi Phần III tô ô (phân biệt với phiếu viết tay cũ); hàm `p3Placement`, `p3Fillable`, `fitsA4`.
- `utils/bubbleOmr.ts`: đọc Phần III theo từng cột, bù mức nền theo từng ký tự in trong ô, ghép chuỗi trái → phải,
  tô 2 ô một cột → `INVALID` (tính sai), chuỗi không phải số → `INVALID`, ký tự không liền cột → gắn cờ.
- `utils/omr.ts`: `PaperConfig.p3Mode` ('bubble' | 'write'), Phần III lưới tô không gửi AI; nhận ra phiếu in nhầm mẫu cũ/mới;
  `unfillableP3Keys` cảnh báo đáp án không tô được trên lưới.
- `utils/overlay.ts`, `components/GradedImage.tsx`: đánh dấu xanh/đỏ trên ô tô, vòng nét đứt ở ô đáp án đúng, nhãn "ĐA: …".
- `utils/printSheets.ts`, `paper.css`: hướng dẫn in cho Phần III, giữ đúng màu xám khi in, xem trước khổ A4 to hơn.
- `api/omr.ts`: cờ `p3bubble` — AI chỉ đọc phần đầu phiếu.
- `pages/BatchList.tsx`, `pages/BatchDetail.tsx`: đợt chấm mới (phiếu web tạo) dùng lưới tô; tối đa 12 câu Phần III; có Phần III → 1 trang A4.

## Giữ nguyên
- Toạ độ Phần I, II; phiếu trường (40 – 6 – 8, chọn chấm 2 phần hoặc 3 phần, Phần III viết tay do AI đọc); phiếu 35 câu.
- Đợt chấm cũ (không có `p3Mode`) vẫn in & quét Phần III viết tay như trước. Không đổi cơ sở dữ liệu (`p3Mode` nằm trong cột config jsonb).
