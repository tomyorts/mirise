import Link from 'next/link';
import type { Metadata } from 'next';
import Breadcrumbs from '@/components/Breadcrumbs';
import CheckNudge from '@/components/CheckNudge';
import JsonLd from '@/components/JsonLd';
import { ARTICLES, articlePath } from '@/lib/articles';
import { itemListLd } from '@/lib/jsonld';
import { abs } from '@/lib/site';

export const metadata: Metadata = {
  title: '難症例・外科矯正',
  description:
    '顎変形症・外科矯正・サージェリーファースト・再治療・咬合再建。「普通の矯正情報では答えが見つからない」方のための専門医による一次情報。',
  alternates: { canonical: abs('/jaw-surgery/') },
};


export default function JawSurgeryIndex() {
  const items = ARTICLES.filter((a) => a.category === 'jaw-surgery');
  return (
    <>
      <Breadcrumbs items={[{ label: '難症例・外科矯正' }]} />
      <div className="container">
        <JsonLd data={itemListLd(items, '難症例・外科矯正の記事一覧')} />
        <header className="page-header">
          <p className="eyebrow">COMPLEX CASES</p>
          <h1>難症例・外科矯正</h1>
          <p className="page-lead">
            顎変形症・外科矯正・サージェリーファースト・再治療・咬合再建。「普通の矯正情報では自分のケースの答えが見つからない」方のための一次情報です。このサイトの中心となるカテゴリです。
          </p>
        </header>
        <ul className="article-list">
          {items.map((a) => (
            <li key={a.slug}>
              <Link href={articlePath(a)}>
                <span className="list-title">{a.title}</span>
                <p className="list-desc">{a.summary.slice(0, 100)}…</p>
              </Link>
            </li>
          ))}
        </ul>
        <CheckNudge position="cat_jaw_surgery" withConsult />
      </div>
    </>
  );
}
