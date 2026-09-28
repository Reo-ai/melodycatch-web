/**
 * ブランドロゴ (グラデーションのタイル + 波形バー)。
 * ヘッダー / サブページ共通で使う。
 */
export default function BrandMark({ size = 36 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      aria-hidden
      className="shrink-0 drop-shadow-[0_6px_18px_rgba(198,75,255,0.45)]"
    >
      <defs>
        <linearGradient id="mc-brand-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7c5cff" />
          <stop offset=".5" stopColor="#c64bff" />
          <stop offset="1" stopColor="#ff7a7a" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill="url(#mc-brand-g)" />
      <g fill="#fff">
        <rect x="13" y="26" width="6" height="12" rx="3" />
        <rect x="23" y="18" width="6" height="28" rx="3" />
        <rect x="33" y="12" width="6" height="40" rx="3" />
        <rect x="43" y="22" width="6" height="20" rx="3" />
      </g>
    </svg>
  );
}
