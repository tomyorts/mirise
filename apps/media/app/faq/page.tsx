import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'よくある誤解と不安' };

// 1問1ページ構成の入口。質問はカウンセリング・LINEの実際の質問から採用する(docs/media/06 FAQマイニング)
export default function FaqIndex() {
  return (
    <div className="container">
      <h1>よくある誤解と不安</h1>
      <p>
        カウンセリングで実際にいただく質問に、1つずつ専門医が答えていくコーナーです。準備中の質問は順次公開します。
      </p>
      <ul className="card-list">
        <li>
          マウスピース矯正で受け口(骨格性)は治るのか
          <p>準備中(docs/media/05 記事18)</p>
        </li>
        <li>
          非抜歯矯正の限界:「抜かない」ことは常に良いことか
          <p>準備中(記事19)</p>
        </li>
        <li>
          大人の矯正に年齢の上限はあるか
          <p>準備中(記事20)</p>
        </li>
        <li>
          矯正すると顔は変わるのか
          <p>準備中(記事21)</p>
        </li>
      </ul>
      <p style={{ fontSize: '0.9rem' }}>
        いま気になっていることがある方は、各記事末尾のFAQ、または
        <Link href="/guide/second-opinion/">セカンドオピニオンの受け方</Link>
        をご覧ください。
      </p>
    </div>
  );
}
