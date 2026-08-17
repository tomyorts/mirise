import Link from 'next/link';
import TrackedLink from './TrackedLink';

// サイト共通CTA。設置は記事フッター1か所のみ(docs/media/02 テンプレート仕様)。
// クリックは cta_click として計測(記事ID・遷移先つき, docs/media/08 3.1)。
export default function Cta({ articleId }: { articleId?: string }) {
  return (
    <aside className="cta-block">
      <p className="cta-title">自分の場合はどうなのか、確認したい方へ</p>
      <p className="cta-sub">
        記事は一般的な情報です。あなたの診断・治療計画についての意見が必要な場合はご相談ください。
      </p>
      <div className="cta-buttons">
        <TrackedLink
          className="cta-button"
          href="/consult/second-opinion/"
          event="cta_click"
          params={{ cta_position: 'article_footer', cta_target: 'second_opinion', article_id: articleId }}
        >
          オンラインセカンドオピニオン
        </TrackedLink>
        <TrackedLink
          className="cta-button secondary"
          href="/consult/complex-cases/"
          event="cta_click"
          params={{ cta_position: 'article_footer', cta_target: 'complex_cases', article_id: articleId }}
        >
          難症例のご相談
        </TrackedLink>
      </div>
      <p className="cta-policy-note">
        当サイトは特定の医院への誘導を目的としません。ご相談はどこで治療する場合でも役立つ形でお応えします(
        <Link href="/about/editorial-policy/">編集ポリシー</Link>)。
      </p>
    </aside>
  );
}
