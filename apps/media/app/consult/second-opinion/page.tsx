import type { Metadata } from 'next';
import Breadcrumbs from '@/components/Breadcrumbs';
import JsonLd from '@/components/JsonLd';
import Link from 'next/link';
import { SITE } from '@/lib/site';

export const metadata: Metadata = {
  title: 'オンラインセカンドオピニオン',
  description:
    '矯正の診断・治療計画について、資料に基づき第三者の専門医が意見をお伝えします。抜歯・手術の要否、治療中の不安、再治療のご相談に。自由診療・費用明記。',
  alternates: { canonical: '/consult/second-opinion/' },
};

const FAQ = [
  {
    q: '相談したことは今の主治医に伝わりますか?',
    a: '伝わりません。ご相談内容を主治医や他の医療機関に共有することはありません。安心してご相談ください。',
  },
  {
    q: '資料がなくても相談できますか?',
    a: '可能です。ただしX線や治療計画書があるほど具体的な意見をお伝えできます。資料の借り方は「セカンドオピニオンの受け方」の記事をご覧ください。',
  },
  {
    q: '相談したら、そちらで治療しないといけませんか?',
    a: 'いいえ。セカンドオピニオンは意思決定のための情報提供であり、当院での治療を前提としません。今の医院で治療を続ける判断も含めて、あなたの決定を支援します。',
  },
];

// 限定解除4要件を1ページで満たす構成(docs/media/04):
// 問い合わせ先/自由診療の内容・費用/リスク・副作用(限界)/読者が自ら閲覧するページ
export default function SecondOpinionConsult() {
  const faqLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: FAQ.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  };
  return (
    <>
      <Breadcrumbs items={[{ label: 'オンラインセカンドオピニオン' }]} />
      <div className="container policy">
        <JsonLd data={faqLd} />
        <header className="page-header">
          <p className="eyebrow">CONSULT</p>
          <h1>オンラインセカンドオピニオン(自由診療)</h1>
        </header>
        <p className="draft-banner">
          提供体制準備中: 価格・所要時間・同意書・予約枠は docs/media 07章のとおり確定後に公開する。以下は仮の記載。
        </p>
        <p>
          {SITE.operator.name}
          の矯正歯科医師が、現在の診断・治療計画について、資料に基づき第三者としての意見をお伝えします。診療(診断・処方)ではなく、意思決定のための情報提供・意見の提示です。
        </p>

        <h2>こんな迷いに、契約・手術の前に</h2>
        <ul>
          <li>抜歯・非抜歯、外科手術の要否について別の専門医の意見を聞きたい</li>
          <li>顎変形症の保険適用の可能性を確認したい</li>
          <li>治療中だが計画に不安があり、継続か転院かを考えたい</li>
          <li>一度治療した歯並びの後戻り・再治療について相談したい</li>
        </ul>

        <h2>相談の流れ(3ステップ)</h2>
        <ol>
          <li>
            <strong>お申し込み</strong> — フォーム(準備中)または電話で予約。現在の状況と相談したいことをお知らせください
          </li>
          <li>
            <strong>資料の共有</strong> — お手元のX線・治療計画書等を事前に送付(
            <Link href="/guide/second-opinion/">資料の借り方はこちら</Link>)
          </li>
          <li>
            <strong>オンライン相談</strong> — ビデオ通話で専門医が意見をお伝えし、質問にお答えします
          </li>
        </ol>

        <h2>費用・時間(自由診療)</h2>
        <table className="info-table">
          <tbody>
            <tr>
              <th>料金</th>
              <td>◯◯,◯◯◯円(税込)/ 1回(確定後に記載)</td>
            </tr>
            <tr>
              <th>時間</th>
              <td>約◯◯分・オンライン(ビデオ通話)</td>
            </tr>
            <tr>
              <th>お支払い</th>
              <td>クレジットカード等(確定後に記載)</td>
            </tr>
          </tbody>
        </table>
        <p style={{ fontSize: '0.88rem' }}>
          セカンドオピニオンは公的医療保険適用外(自費)です。オンラインでの意見提示には、資料の精度による限界があります。対面での精密検査が必要と判断した場合は、その旨をお伝えします(当院以外の医療機関での検査でも構いません)。
        </p>

        <h2>よくあるご質問</h2>
        {FAQ.map((f) => (
          <div className="faq-item" key={f.q}>
            <h3>{f.q}</h3>
            <p>{f.a}</p>
          </div>
        ))}

        <h2>お申し込み・お問い合わせ</h2>
        <p>
          予約フォーム(準備中)/ 電話: {SITE.operator.tel}({SITE.operator.name})
        </p>
      </div>
    </>
  );
}
