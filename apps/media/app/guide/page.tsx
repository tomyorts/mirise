import Link from 'next/link';
import type { Metadata } from 'next';
import Breadcrumbs from '@/components/Breadcrumbs';
import { ARTICLES, articlePath } from '@/lib/articles';

export const metadata: Metadata = {
  title: '意思決定ガイド',
  description:
    '矯正治療を始めるかどうか、誰に任せるかを決めるための常設ガイド。カウンセリングの聞き方、セカンドオピニオン、費用と転院の考え方。',
};

const UPCOMING = [
  '矯正を始める前の10の質問(自己整理シート付き)',
  'カウンセリングで聞くべき15の質問(チェックリスト)',
  '矯正の費用の仕組み:総額制・処置料別・追加費用の読み方',
  '矯正の転院とお金:中断時の精算・返金はどうなるか',
  '「矯正医選び」で本当に見るべきもの',
  '治療計画書の読み方',
];

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
        <h2>今後公開予定</h2>
        <ul className="article-list">
          {UPCOMING.map((t) => (
            <li key={t}>
              <span
                className="list-title list-coming"
                style={{ display: 'block', padding: '14px 6px' }}
              >
                {t}
                <span className="badge">準備中</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
