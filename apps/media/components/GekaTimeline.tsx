// 外科矯正の治療全体を横帯で見せるタイムライン図(表示専用)。
// 新たな臨床的主張は持たせない。数値は本文・監修済みの記述
// (術前矯正1年〜1年半/入院・手術1〜2週間/術後矯正6ヶ月〜1年/保定2年以上)に従う。
export default function GekaTimeline() {
  return (
    <figure className="article-fig">
      <svg viewBox="0 0 660 150" role="img" aria-label="外科矯正の治療タイムライン" style={{ minWidth: '560px' }}>
        {/* 入院の注記(手術セグメントの上) */}
        <path d="M304 44 v-8 h64 v8" fill="none" stroke="var(--ink-soft)" />
        <text x="336" y="26" textAnchor="middle" fontSize="11" fill="var(--ink-soft)">入院1〜2週間</text>

        {/* 帯 */}
        <rect x="16" y="52" width="76" height="38" rx="7" fill="var(--paper)" stroke="var(--line-strong)" />
        <text x="54" y="75" textAnchor="middle" fontSize="12" fill="var(--ink)">精密検査</text>

        <rect x="98" y="52" width="198" height="38" rx="7" fill="var(--accent-soft)" stroke="var(--accent-line)" />
        <text x="197" y="75" textAnchor="middle" fontSize="13" fill="var(--ink)">術前矯正</text>

        <rect x="302" y="48" width="68" height="46" rx="7" fill="var(--accent)" />
        <text x="336" y="75" textAnchor="middle" fontSize="13" fontWeight="bold" fill="#ffffff">手術</text>

        <rect x="376" y="52" width="152" height="38" rx="7" fill="var(--accent-soft)" stroke="var(--accent-line)" />
        <text x="452" y="75" textAnchor="middle" fontSize="13" fill="var(--ink)">術後矯正</text>

        <rect x="534" y="52" width="106" height="38" rx="7" fill="var(--paper)" stroke="var(--line-strong)" strokeDasharray="5 4" />
        <text x="585" y="75" textAnchor="middle" fontSize="13" fill="var(--ink)">保定</text>

        {/* 期間の目安(帯の下) */}
        <text x="54" y="112" textAnchor="middle" fontSize="11" fill="var(--ink-soft)">1〜2ヶ月</text>
        <text x="197" y="112" textAnchor="middle" fontSize="11" fill="var(--ink-soft)">1年〜1年半</text>
        <text x="336" y="112" textAnchor="middle" fontSize="11" fill="var(--ink-soft)">1〜2週間</text>
        <text x="452" y="112" textAnchor="middle" fontSize="11" fill="var(--ink-soft)">6ヶ月〜1年</text>
        <text x="585" y="112" textAnchor="middle" fontSize="11" fill="var(--ink-soft)">2年以上</text>

        {/* 全体期間 */}
        <line x1="16" y1="132" x2="528" y2="132" stroke="var(--accent-line)" />
        <text x="272" y="146" textAnchor="middle" fontSize="11" fill="var(--ink-soft)">動的治療の全体で2〜3年程度(個人差があります)</text>
      </svg>
      <figcaption>
        外科矯正のタイムライン(概要)。帯の長さは実際の期間の比率どおりではありません。保定を含めた全体は2年半〜4年程度が目安で、期間には個人差があります。
      </figcaption>
    </figure>
  );
}
