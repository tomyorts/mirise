import Link from 'next/link';
import type { Metadata } from 'next';
import { ARTICLES, articlePath } from '@/lib/articles';

export const metadata: Metadata = { title: '難症例・外科矯正' };

export default function JawSurgeryIndex() {
  const items = ARTICLES.filter((a) => a.category === 'jaw-surgery');
  return (
    <div className="container">
      <h1>難症例・外科矯正</h1>
      <p>
        顎変形症・外科矯正・サージェリーファースト・再治療・咬合再建。「普通の矯正情報では自分のケースの答えが見つからない」方のための一次情報です。
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
        今後の追加予定: 外科矯正の流れ・入院/下顎前突の骨格性と歯性/リスクと合併症/顔面非対称/開咬/再治療/咬合再建(docs/media/05)
      </p>
    </div>
  );
}
