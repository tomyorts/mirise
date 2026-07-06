import Link from 'next/link';

// サイト共通CTA。設置は記事フッター1か所のみ(docs/media/02 テンプレート仕様)
export default function Cta() {
  return (
    <aside className="cta-block">
      <p>自分の場合はどうなのか、専門医に確認したい方へ</p>
      <div className="cta-buttons">
        <Link className="cta-button" href="/consult/second-opinion/">
          オンラインセカンドオピニオン(自由診療)
        </Link>
        <Link className="cta-button secondary" href="/consult/complex-cases/">
          難症例のご相談
        </Link>
      </div>
    </aside>
  );
}
