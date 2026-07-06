import type { Metadata } from 'next';
import Link from 'next/link';
import Breadcrumbs from '@/components/Breadcrumbs';
import JsonLd from '@/components/JsonLd';
import { AUTHORS } from '@/lib/authors';
import { SITE } from '@/lib/site';

export const metadata: Metadata = {
  title: '運営者情報',
  description: `「${SITE.name}」の運営医院、発行責任者、監修体制について。`,
};

const clinicLd = {
  '@context': 'https://schema.org',
  '@type': 'MedicalClinic',
  '@id': `${SITE.url}/about/#clinic`,
  name: SITE.operator.name,
  address: SITE.operator.address,
  telephone: SITE.operator.tel,
  url: SITE.operator.url,
  medicalSpecialty: 'https://schema.org/Dentistry',
};

export default function About() {
  const director = AUTHORS.director;
  return (
    <>
      <Breadcrumbs items={[{ label: '運営者情報' }]} />
      <div className="container policy">
        <JsonLd data={clinicLd} />
        <header className="page-header">
          <p className="eyebrow">ABOUT</p>
          <h1>運営者情報</h1>
          <p className="page-lead">
            「{SITE.name}」は、{SITE.operator.name}が運営する矯正治療の意思決定支援メディアです。
          </p>
        </header>

        <h2>運営医院</h2>
        <table className="info-table">
          <tbody>
            <tr>
              <th>名称</th>
              <td>{SITE.operator.name}</td>
            </tr>
            <tr>
              <th>所在地</th>
              <td>{SITE.operator.address}(番地まで確定して記載)</td>
            </tr>
            <tr>
              <th>お問い合わせ</th>
              <td>
                {SITE.operator.tel} / 相談フォーム(準備中)
              </td>
            </tr>
            <tr>
              <th>診療分野</th>
              <td>
                矯正歯科、顎変形症・外科的矯正治療、サージェリーファースト、デジタル矯正・3Dシミュレーション、咬合再建
              </td>
            </tr>
          </tbody>
        </table>

        <h2>発行責任者・監修</h2>
        <div className="author-box" style={{ marginTop: 16 }}>
          <span className="avatar" aria-hidden="true">
            医
          </span>
          <div className="body">
            <span className="name">{director.name}</span>
            <span className="role">{director.title}</span>
            <p>{director.bio}</p>
            <p>資格・所属: {director.qualifications.join('、')}</p>
          </div>
        </div>
        <p style={{ marginTop: 16 }}>
          すべての記事は、発行責任者または監修医が公開前に全文を確認し、確認日を記録しています。監修の流れと基準は
          <Link href="/about/editorial-policy/">編集ポリシー</Link>をご覧ください。
        </p>

        <h2>運営元とメディアの関係について</h2>
        <p>
          本メディアの運営元は矯正歯科医院であり、当院への相談窓口を設置しています。その意味で本メディアは当院の利益と無関係ではありません。私たちはこの事実を隠さず、
          <Link href="/about/editorial-policy/">編集ポリシー</Link>
          に定めたルール(記事内で当院を推奨しない・適応外のケースを明記する・相談導線は固定位置のみ)で中立性を担保します。
        </p>
      </div>
    </>
  );
}
