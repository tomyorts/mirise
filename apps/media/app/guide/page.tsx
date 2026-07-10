import Link from 'next/link';
import type { Metadata } from 'next';
import Breadcrumbs from '@/components/Breadcrumbs';
import CheckNudge from '@/components/CheckNudge';
import { ARTICLES, articlePath } from '@/lib/articles';
import { abs } from '@/lib/site';

export const metadata: Metadata = {
  title: '意思決定ガイド',
  description:
    '矯正治療を始めるかどうか、誰に任せるかを決めるための常設ガイド。カウンセリングの聞き方、セカンドオピニオン、費用と転院の考え方。',
  alternates: { canonical: abs('/guide/') },
};


export default function GuideIndex() {
  const items = ARTICLES.filter((a) => a.category === 'guide');
  return (
    <>
      <Breadcrumbs items={[{ label: '意思決定ガイド' }]} />
      <div className="container">
        <header className="page-header">
          <p className="eyebrow">GUIDE</p>
          <h1>意思決定ガイド</h1>
          <p className="page-lead">
            矯正治療を「始めるかどうか」「誰に任せるか」を決めるための常設ガイドです。読み終えたとき、カウンセリングで何を確認すべきかが分かる状態を目指しています。
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
        <CheckNudge position="cat_guide" />
      </div>
    </>
  );
}
