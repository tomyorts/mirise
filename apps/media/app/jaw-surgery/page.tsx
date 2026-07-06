import Link from 'next/link';
import type { Metadata } from 'next';
import Breadcrumbs from '@/components/Breadcrumbs';
import { ARTICLES, articlePath } from '@/lib/articles';

export const metadata: Metadata = {
  title: '難症例・外科矯正',
  description:
    '顎変形症・外科矯正・サージェリーファースト・再治療・咬合再建。「普通の矯正情報では答えが見つからない」方のための専門医による一次情報。',
};

const UPCOMING = [
  '外科矯正の全体像:手術までの流れ・入院期間・仕事復帰の目安',
  '下顎前突(受け口)は矯正だけで治せるか:骨格性と歯性の見分け方',
  '顎変形症でマウスピース矯正が使えないと言われる理由',
  '外科矯正のリスクと合併症:知覚麻痺・後戻り・再手術の実際',
  '顔面非対称(顎のゆがみ)の治療選択肢',
  '開咬(前歯が閉じない)の原因別治療法',
  '矯正の再治療:一度失敗した矯正をやり直すときの考え方',
  '咬合再建とは何か:すり減った噛み合わせを作り直す治療',
];

export default function JawSurgeryIndex() {
  const items = ARTICLES.filter((a) => a.category === 'jaw-surgery');
  return (
    <>
      <Breadcrumbs items={[{ label: '難症例・外科矯正' }]} />
      <div className="container">
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
