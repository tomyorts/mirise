import type { Metadata } from 'next';
import Link from 'next/link';
import { AUTHORS } from '@/lib/authors';
import { SITE } from '@/lib/site';
import JsonLd from '@/components/JsonLd';

export const metadata: Metadata = { title: '運営者情報' };

const clinicLd = {
  '@context': 'https://schema.org',
  '@type': 'MedicalClinic',
  name: SITE.operator.name,
  address: SITE.operator.address,
  telephone: SITE.operator.tel,
  url: SITE.operator.url,
  medicalSpecialty: 'https://schema.org/Dentistry',
};

export default function About() {
  const director = AUTHORS.director;
  return (
    <div className="container policy">
      <JsonLd data={clinicLd} />
      <h1>運営者情報</h1>
      <p>
        「{SITE.name}」は、{SITE.operator.name}が運営する矯正治療の意思決定支援メディアです。
      </p>

      <h2>運営医院</h2>
      <table>
        <tbody>
          <tr>
            <th style={{ textAlign: 'left', paddingRight: 16 }}>名称</th>
            <td>{SITE.operator.name}</td>
          </tr>
          <tr>
            <th style={{ textAlign: 'left', paddingRight: 16 }}>所在地</th>
            <td>{SITE.operator.address}(番地まで確定して記載)</td>
          </tr>
          <tr>
            <th style={{ textAlign: 'left', paddingRight: 16 }}>お問い合わせ</th>
            <td>{SITE.operator.tel} / 相談フォーム(準備中)</td>
          </tr>
          <tr>
            <th style={{ textAlign: 'left', paddingRight: 16 }}>診療分野</th>
            <td>矯正歯科、顎変形症・外科的矯正治療、サージェリーファースト、デジタル矯正・3Dシミュレーション、咬合再建</td>
          </tr>
        </tbody>
      </table>

      <h2>発行責任者・監修</h2>
      <p>
        {director.name}({director.title})
        <br />
        {director.bio}
      </p>

      <h2>運営元とメディアの関係について</h2>
      <p>
        本メディアの運営元は矯正歯科医院であり、当院への相談窓口を設置しています。その意味で本メディアは当院の利益と無関係ではありません。私たちはこの事実を隠さず、
        <Link href="/about/editorial-policy/">編集ポリシー</Link>
        に定めたルール(記事内で当院を推奨しない・適応外のケースを明記する・相談導線は固定位置のみ)で中立性を担保します。
      </p>
    </div>
  );
}
