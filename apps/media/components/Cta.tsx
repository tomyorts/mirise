import Link from 'next/link';

// サイト共通CTA。設置は記事フッター1か所のみ(docs/media/02 テンプレート仕様)
export default function Cta() {
  return (
    <aside className="cta-block">
      <p className="cta-title">自分の場合はどうなのか、確認したい方へ</p>
      <p className="cta-sub">
        記事は一般的な情報です。あなたの診断・治療計画についての意見が必要な場合はご相談ください。
      </p>
      <div className="cta-buttons">
        <Link className="cta-button" href="/consult/second-opinion/">
          オンラインセカンドオピニオン
        </Link>
        <Link className="cta-button secondary" href="/consult/complex-cases/">
          難症例のご相談
        </Link>
      </div>
      <p className="cta-policy-note">
        当サイトは特定の医院への誘導を目的としません。ご相談はどこで治療する場合でも役立つ形でお応えします(
        <Link href="/about/editorial-policy/">編集ポリシー</Link>)。
      </p>
    </aside>
  );
}
