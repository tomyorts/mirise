import type { Metadata } from 'next';
import Breadcrumbs from '@/components/Breadcrumbs';
import JsonLd from '@/components/JsonLd';
import Link from 'next/link';
import { SITE } from '@/lib/site';

export const metadata: Metadata = {
  title: '難症例のご相談',
  description:
    '顎変形症・外科矯正・サージェリーファースト・再治療・咬合再建のご相談。診断と治療計画の設計が結果を左右するケースを、専門医が診察します。適応でない場合は率直にお伝えします。',
  alternates: { canonical: '/consult/complex-cases/' },
};

const FAQ = [
  {
    q: '他院で「難しい」と言われたのですが、相談できますか?',
    a: 'はい。難症例の相談はまさにこの窓口の対象です。ただし診察の結果、当院よりも適切な選択肢(大学病院での集学的治療など)がある場合は、その旨を率直にお伝えします。',
  },
  {
    q: '保険が使えるかどうかも相談できますか?',
    a: 'はい。顎変形症の保険適用には診断・医療機関・治療計画の条件があります。診察のうえで、あなたのケースでの可能性をご説明します。事前に「保険適用の完全ガイド」の記事を読んでおくと理解がスムーズです。',
  },
  {
    q: '相談したら治療を契約しないといけませんか?',
    a: 'いいえ。診断結果と選択肢のご説明までで持ち帰っていただき、ご自身のペースで判断していただけます。セカンドオピニオンを受けることも自由です。',
  },
];

// 「適応を明記した相談導線」。当院が適応でないケースも明記する(docs/media/01・03)
export default function ComplexCasesConsult() {
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
      <Breadcrumbs items={[{ label: '難症例のご相談' }]} />
      <div className="container policy">
        <JsonLd data={faqLd} />
        <header className="page-header">
          <p className="eyebrow">CONSULT</p>
          <h1>難症例のご相談</h1>
        </header>
        <p>
          {SITE.operator.name}
          では、次のようなケースのご相談をお受けしています。一般的な矯正相談よりも、診断と治療計画の設計が結果を左右するケースです。
        </p>
        <ul>
          <li>顎変形症(受け口・開咬・顔面非対称など骨格性の問題)と言われた、または疑いがある</li>
          <li>外科手術を伴う矯正治療(サージェリーファーストを含む)を検討している</li>
          <li>他院で「治療が難しい」と言われた</li>
          <li>過去の矯正の後戻り・仕上がりへの不満があり、再治療を検討している</li>
          <li>歯のすり減り・欠損を含む噛み合わせ全体の再建が必要と言われた</li>
        </ul>
        <p style={{ fontSize: '0.88rem' }}>
          事前に読んでおくと相談がスムーズです:
          <Link href="/jaw-surgery/hoken-tekiyo/">保険適用の完全ガイド</Link>/
          <Link href="/guide/counseling-questions/">カウンセリングで聞くべき15の質問</Link>
        </p>

        <h2>当院が適応とならない場合</h2>
        <p>
          診断の結果、当院での治療よりも適切な選択肢がある場合(例:
          大学病院での集学的治療が必要なケース、全身疾患の管理が優先されるケース、成長期の管理を近隣で継続すべきケースなど)は、その旨を率直にお伝えし、必要に応じて適切な医療機関への受診をご案内します。
        </p>

        <h2>ご相談の流れ</h2>
        <ol>
          <li>フォームまたは電話でお申し込み(現在の状況・これまでの経緯をお知らせください)</li>
          <li>初診カウンセリング・検査(検査内容と費用は事前にご説明します)</li>
          <li>診断結果と治療の選択肢(保険適用の可能性を含む)のご説明</li>
        </ol>
        <p style={{ fontSize: '0.88rem' }}>
          初診相談・検査の費用は確定後に記載(自由診療となる場合は費用・期間・リスクを事前に書面でご説明します)。
        </p>

        <h2>よくあるご質問</h2>
        {FAQ.map((f) => (
          <div className="faq-item" key={f.q}>
            <h3>{f.q}</h3>
            <p>{f.a}</p>
          </div>
        ))}

        <h2>お申し込み</h2>
        <p>
          予約フォーム(準備中)/ 電話: {SITE.operator.tel}
        </p>
      </div>
    </>
  );
}
