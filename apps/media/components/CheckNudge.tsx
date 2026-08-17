import TrackedLink from './TrackedLink';

// 回遊の行き止まりでCVへ橋渡しするナッジ。一覧の末尾やトップ下部に置く。
// セルフチェック(全員向け)+ 任意で相談導線(高intentカテゴリ向け)。
export default function CheckNudge({
  position,
  withConsult = false,
}: {
  position: string;
  withConsult?: boolean;
}) {
  return (
    <aside className="check-nudge">
      <p className="title">どれから読めばいいか迷ったら</p>
      <p className="desc">
        3つの質問に答えると、あなたの状況に合った記事と相談の目安をご案内します(個人情報の入力は不要)。
      </p>
      <div className="cta-buttons">
        <TrackedLink
          className="cta-button"
          href="/check/"
          event="cta_click"
          params={{ cta_position: position, cta_target: 'self_check' }}
        >
          3分セルフチェックを始める
        </TrackedLink>
        {withConsult && (
          <TrackedLink
            className="cta-button secondary"
            href="/consult/complex-cases/"
            event="cta_click"
            params={{ cta_position: position, cta_target: 'complex_cases' }}
          >
            難症例のご相談について
          </TrackedLink>
        )}
      </div>
    </aside>
  );
}
