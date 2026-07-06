import Link from 'next/link';
import type { Metadata } from 'next';
import { ARTICLES, articlePath } from '@/lib/articles';

export const metadata: Metadata = { title: '意思決定ガイド' };

export default function GuideIndex() {
  const items = ARTICLES.filter((a) => a.category === 'guide');
  return (
    <div className="container">
      <h1>意思決定ガイド</h1>
      <p>
        矯正治療を「始めるかどうか」「誰に任せるか」を決めるための常設ガイドです。読み終えたとき、カウンセリングで何を確認すべきかが分かる状態を目指しています。
      </p>
      <ul className="card-list">
        {items.map((a) => (
          <li key={a.slug}>
            <Link href={articlePath(a)}>{a.title}</Link>
            <p>{a.summary.slice(0, 80)}…</p>
          </li>
        ))}
      </ul>
      <p style={{ fontSize: '0.85rem', color: 'var(--ink-soft)' }}>
        今後の追加予定: 矯正を始める前の10の質問/カウンセリングで聞くべき15の質問/費用の仕組み/転院とお金(docs/media/05
        コンテンツ計画)
      </p>
    </div>
  );
}
