import Link from 'next/link';
import type { Metadata } from 'next';
import Breadcrumbs from '@/components/Breadcrumbs';
import { ARTICLES, articlePath } from '@/lib/articles';

export const metadata: Metadata = {
  title: '治療法を正しく理解する',
  description:
    'ワイヤー矯正・マウスピース矯正の適応の科学、デジタル矯正・3Dシミュレーションで分かること、抜歯・非抜歯の判断基準。装置の宣伝ではなく適応を理解するためのカテゴリ。',
  alternates: { canonical: '/treatment/' },
};

export default function TreatmentIndex() {
  const items = ARTICLES.filter((a) => a.category === 'treatment');
  return (
    <>
      <Breadcrumbs items={[{ label: '治療法を正しく理解する' }]} />
      <div className="container">
        <header className="page-header">
          <p className="eyebrow">TREATMENT</p>
          <h1>治療法を正しく理解する</h1>
          <p className="page-lead">
            装置や技術の「宣伝」ではなく「適応」を理解するためのカテゴリです。すべての治療法には得意な症例と限界があります。
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
      </div>
    </>
  );
}
