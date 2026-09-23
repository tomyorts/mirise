import Link from 'next/link';
import type { Metadata } from 'next';
import Breadcrumbs from '@/components/Breadcrumbs';
import CheckNudge from '@/components/CheckNudge';
import JsonLd from '@/components/JsonLd';
import { ARTICLES, articlePath } from '@/lib/articles';
import { itemListLd } from '@/lib/jsonld';
import { abs } from '@/lib/site';

export const metadata: Metadata = {
  title: 'よくある誤解と不安',
  description:
    'カウンセリングで実際にいただく質問に、1つずつ矯正歯科医師が答えます。マウスピース矯正、非抜歯、年齢、顔の変化。',
  alternates: { canonical: abs('/faq/') },
};

export default function FaqIndex() {
  const items = ARTICLES.filter((a) => a.category === 'faq');
  return (
    <>
      <Breadcrumbs items={[{ label: 'よくある誤解と不安' }]} />
      <div className="container">
        <JsonLd data={itemListLd(items, 'よくある誤解と不安 記事一覧')} />
        <header className="page-header">
          <p className="eyebrow">FAQ</p>
          <h1>よくある誤解と不安</h1>
          <p className="page-lead">
            カウンセリングで実際にいただく質問に、1つずつ専門医が答えていくコーナーです。質問は今後も追加していきます。
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
        <p className="note">
          ここにない疑問をお持ちの方へ:
          記事末尾の相談窓口からいただいた質問は、個人が特定されない形でこのコーナーの新しい記事の題材にさせていただくことがあります。
        </p>
        <CheckNudge position="cat_faq" />
      </div>
    </>
  );
}
