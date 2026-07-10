import Link from 'next/link';
import type { Metadata } from 'next';
import TrackedLink from '@/components/TrackedLink';
import CheckNudge from '@/components/CheckNudge';
import { ARTICLES, articlePath, CATEGORY_LABEL } from '@/lib/articles';
import { SITE, abs } from '@/lib/site';

export const metadata: Metadata = {
  title: { absolute: `${SITE.name}|${SITE.tagline}` },
  alternates: { canonical: abs('/') },
};

// トップ=「意思決定の入口」。新着一覧ではなく、読者の状況から入る(docs/media/02)
const SITUATIONS = [
  {
    label: 'これから相談・カウンセリングに行く',
    href: '/guide/second-opinion/',
    title: '矯正のセカンドオピニオンの受け方',
    desc: '抜歯・手術・やり直しなど、不可逆な判断の前に。切り出し方と準備をまとめました。',
  },
  {
    label: '受け口・顎のずれ・顎変形症を指摘された',
    href: '/jaw-surgery/hoken-tekiyo/',
    title: '顎変形症の手術に健康保険は使えるか',
    desc: '保険が使える3つの条件・使えないケース・自己負担の目安を整理します。',
  },
  {
    label: '手術を提案された・検討している',
    href: '/jaw-surgery/surgery-first/',
    title: 'サージェリーファーストの適応と限界',
    desc: '治療期間短縮の仕組みと、適応できない症例の条件を専門医が解説します。',
  },
  {
    label: 'マウスピース矯正を検討している',
    href: '/faq/mouthpiece-ukeguchi/',
    title: 'マウスピース矯正で受け口は治りますか?',
    desc: '装置の問題ではなく診断の問題です。歯性と骨格性の違いから説明します。',
  },
  {
    label: '「歯を抜かない矯正」に惹かれている',
    href: '/faq/hibassi-genkai/',
    title: '「歯を抜かない矯正」は常に良い選択ですか?',
    desc: '抜歯・非抜歯は優劣ではなく診断の結果。確認すべきポイントを解説します。',
  },
  {
    label: '年齢的に迷っている',
    href: '/faq/otona-nenrei/',
    title: '大人の矯正に年齢の上限はありますか?',
    desc: '歯は何歳でも動きます。変わるのは「できるか」ではなく「設計」です。',
  },
];

export default function Home() {
  return (
    <>
      <section className="hero">
        <h1>
          矯正を「始める前」「決める前」に、
          <br />
          知っておくべきことを専門医が整理します。
        </h1>
        <p className="hero-lead">
          キョウセイの前には、矯正治療を始めるかどうか、誰に任せるかを考えている方のための意思決定支援メディアです。顎変形症・外科矯正・再治療など、普通の矯正情報では答えが見つからない方のための一次情報を、矯正歯科医師の実名監修でお届けします。
        </p>
        <div className="hero-policy" aria-label="編集方針">
          <span>医院ランキングなし</span>
          <span>口コミ掲載なし</span>
          <span>掲載料・紹介料なし</span>
          <span>
            <Link href="/about/editorial-policy/">編集ポリシー</Link>
          </span>
        </div>
      </section>

      <aside className="check-banner">
        <div className="inner">
          <div>
            <p className="title">どの記事から読めばいいか分からない方へ</p>
            <p>3つの質問に答えると、あなたの状況に合った記事と相談の目安をご案内します(個人情報の入力は不要)。</p>
          </div>
          <TrackedLink
            className="cta-button"
            href="/check/"
            event="cta_click"
            params={{ cta_position: 'home_hero', cta_target: 'self_check' }}
          >
            3分セルフチェックを始める
          </TrackedLink>
        </div>
      </aside>

      <section className="section">
        <h2>あなたの状況から探す</h2>
        <p className="section-lead">
          いま向き合っている判断に近いものからお読みください。
        </p>
        <ul className="card-grid">
          {SITUATIONS.map((s) => (
            <li className="card" key={s.href}>
              <Link href={s.href}>
                <span className="situation">{s.label}</span>
                <span className="card-title">{s.title}</span>
                <p className="card-desc">{s.desc}</p>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section className="section">
        <h2>カテゴリから探す</h2>
        <p className="section-lead">
          このサイトは5つの常設カテゴリで構成されています。
        </p>
        <ul className="card-grid">
          <li className="card">
            <Link href="/guide/">
              <span className="cat">GUIDE</span>
              <span className="card-title">意思決定ガイド</span>
              <p className="card-desc">
                始める前の質問、カウンセリングの聞き方、セカンドオピニオン、転院とお金。判断を前に進める道具です。
              </p>
            </Link>
          </li>
          <li className="card">
            <Link href="/jaw-surgery/">
              <span className="cat">COMPLEX CASES</span>
              <span className="card-title">難症例・外科矯正</span>
              <p className="card-desc">
                顎変形症・外科矯正・サージェリーファースト・再治療・咬合再建。このサイトの中心となる一次情報です。
              </p>
            </Link>
          </li>
          <li className="card">
            <Link href="/treatment/">
              <span className="cat">TREATMENT</span>
              <span className="card-title">治療法を正しく理解する</span>
              <p className="card-desc">
                ワイヤー・アライナーの適応、デジタル矯正で分かること・分からないこと、抜歯の判断基準。
              </p>
            </Link>
          </li>
          <li className="card">
            <Link href="/faq/">
              <span className="cat">FAQ</span>
              <span className="card-title">よくある誤解と不安</span>
              <p className="card-desc">
                カウンセリングで実際にいただく質問に、1つずつ専門医が答えます。
              </p>
            </Link>
          </li>
        </ul>
      </section>

      <section className="section">
        <h2>すべての記事</h2>
        <ul className="article-list">
          {ARTICLES.map((a) => (
            <li key={articlePath(a)}>
              <Link href={articlePath(a)}>
                <span className="list-title">{a.title}</span>
                <span className="badge">{CATEGORY_LABEL[a.category]}</span>
                <p className="list-desc">{a.summary.slice(0, 90)}…</p>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <CheckNudge position="home_bottom" />
    </>
  );
}
