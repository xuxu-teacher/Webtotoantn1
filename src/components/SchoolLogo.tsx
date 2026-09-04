interface Props {
  size?: number;
}

/**
 * Huy hiệu dạng chữ/biểu tượng toán học đơn giản, không sao chép logo chính thức
 * nào (mình không có file logo thật của trường). Nếu bạn có file logo chính thức
 * (PNG/SVG), thay thế component này bằng <img src="/logo-truong.png" ... /> —
 * chỉ cần sửa đúng một chỗ này, mọi nơi dùng <SchoolLogo /> sẽ tự cập nhật.
 */
export default function SchoolLogo({ size = 52 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Tổ Toán - THPT Số 1 Tư Nghĩa">
      <defs>
        <linearGradient id="schoolLogoBg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#4a63c9" />
          <stop offset="100%" stopColor="#202d5e" />
        </linearGradient>
      </defs>
      <circle cx="32" cy="32" r="31" fill="url(#schoolLogoBg)" stroke="#e08a2b" strokeWidth="2" />
      <circle cx="32" cy="32" r="25" fill="none" stroke="#fff1de" strokeWidth="1" opacity="0.5" />
      <text x="32" y="30" textAnchor="middle" fontFamily="Fraunces, Georgia, serif" fontSize="20" fontWeight="700" fill="#fff">
        Σ
      </text>
      <text x="32" y="44" textAnchor="middle" fontFamily="'Be Vietnam Pro', sans-serif" fontSize="7" fontWeight="700" fill="#fff1de" letterSpacing="0.5">
        TỔ TOÁN
      </text>
      <text x="32" y="52" textAnchor="middle" fontFamily="'Be Vietnam Pro', sans-serif" fontSize="4.6" fill="#fff1de">
        THPT SỐ 1 TƯ NGHĨA
      </text>
    </svg>
  );
}
