import type { Metadata } from 'next';
import Breadcrumbs from '@/components/Breadcrumbs';

export const metadata: Metadata = {
  title: '治療法を正しく理解する',
  description:
    'ワイヤー矯正・マウスピース矯正の適応の科学、デジタル矯正・3Dシミュレーションで分かること、抜歯・非抜歯の判断基準。',
};

const UPCOMING = [
  {
    title: 'ワイヤー矯正とマウスピース矯正:適応の科学',
    desc: '「どちらが良いか」ではなく「自分の症例にどちらが適応か」。装置ごとの得意な歯の動きから解説します。',
  },
  {
    title: '3Dシミュレーションで分かること・分からないこと',
    desc: '実際のシミュレーション画面を使って、事前に可視化できる範囲と予測の限界を示します。',
  },
  {
    title: '抜歯・非抜歯の判断基準:スペース分析の実際',
    desc: '診断の現場でどのような数値に基づいて判断しているかを公開します。',
  },
];

export default function TreatmentIndex() {
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
          {UPCOMING.map((t) => (
            <li key={t.title}>
              <span className="list-title list-coming" style={{ display: 'block', padding: '14px 6px' }}>
                {t.title}
                <span className="badge">準備中</span>
                <p className="list-desc">{t.desc}</p>
              </span>
            </li>
          ))}
        </ul>
        <p className="note">
          このカテゴリの記事は、90日コンテンツ計画(docs/media/05)に基づき順次公開されます。
        </p>
      </div>
    </>
  );
}
