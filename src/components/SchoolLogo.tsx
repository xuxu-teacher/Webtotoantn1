interface Props {
  size?: number;
}

/**
 * Huy hiệu chữ đơn giản "Design by Xu" — logo/branding của người phát triển
 * ứng dụng này (không phải logo trường/tổ chuyên môn).
 */
export default function SchoolLogo({ size = 52 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Design by Xu">
      <defs>
        <linearGradient id="schoolLogoBg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#4a63c9" />
          <stop offset="100%" stopColor="#202d5e" />
        </linearGradient>
      </defs>
      <circle cx="32" cy="32" r="31" fill="url(#schoolLogoBg)" stroke="#e08a2b" strokeWidth="2" />
      <circle cx="32" cy="32" r="25" fill="none" stroke="#fff1de" strokeWidth="1" opacity="0.5" />
      <text x="32" y="34" textAnchor="middle" fontFamily="Fraunces, Georgia, serif" fontSize="18" fontWeight="700" fill="#fff">
        Xu
      </text>
      <text x="32" y="48" textAnchor="middle" fontFamily="'Be Vietnam Pro', sans-serif" fontSize="6" fontWeight="700" fill="#fff1de" letterSpacing="0.5">
        DESIGN BY XU
      </text>
    </svg>
  );
}
