// ロゴマーク: 「進む前の確認点」を示すチェックポイントのモチーフ。
// 正式ロゴ納品(docs/media/01 デザイン発注)までのプレースホルダーとして機能する完成度で作成。
export default function Logo({ size = 34 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="20" cy="20" r="18.5" stroke="#175e66" strokeWidth="2" />
      <path
        d="M12 21.5 L17.5 27 L28 14.5"
        stroke="#175e66"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="20" cy="20" r="18.5" stroke="#175e66" strokeOpacity="0.15" strokeWidth="6" />
    </svg>
  );
}
