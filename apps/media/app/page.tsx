import Link from 'next/link';
import { ARTICLES, articlePath, CATEGORY_LABEL } from '@/lib/articles';
import { SITE } from '@/lib/site';

// トップ=「意思決定の入口」。新着一覧ではなく、読者の状況から入る(docs/media/02)
export default function Home() {
  return (
    <div className="container">
      <h1 style={{ marginTop: 40 }}>
        矯正を「始める前」「決める前」に、
        <br />
        知っておくべきことを専門医が整理します。
      </h1>
      <p>
        {SITE.name}は、{SITE.description}
      </p>
      <p style={{ fontSize: '0.88rem', color: 'var(--ink-soft)' }}>
        私たちはあなたを特定の医院に誘導しません。このサイトを読んだあなたが、どこで治療する場合でも納得して決められることが目的です(
        <Link href="/about/editorial-policy/">編集ポリシー</Link>)。
      </p>

      <h2>あなたの状況から探す</h2>
      <ul className="card-list">
        <li>
          <span className="cat">これから相談に行く</span>
          <br />
          <Link href="/guide/second-opinion/">
            矯正のセカンドオピニオンの受け方:失礼にならない切り出し方と準備
          </Link>
          <p>抜歯・手術・やり直しなど、不可逆な判断の前に読んでください。</p>
        </li>
        <li>
          <span className="cat">受け口・顎のずれを指摘された</span>
          <br />
          <Link href="/jaw-surgery/hoken-tekiyo/">
            顎変形症の手術に健康保険は使えるか:適用条件の完全ガイド
          </Link>
          <p>保険が使える条件・使えないケース・自己負担の目安を整理します。</p>
        </li>
        <li>
          <span className="cat">手術を提案された</span>
          <br />
          <Link href="/jaw-surgery/surgery-first/">
            サージェリーファーストの適応と限界:向いている人・向いていない人
          </Link>
          <p>治療期間短縮の仕組みと、適応できない症例の条件を解説します。</p>
        </li>
      </ul>

      <h2>すべての記事</h2>
      <ul className="card-list">
        {ARTICLES.map((a) => (
          <li key={articlePath(a)}>
            <span className="cat">{CATEGORY_LABEL[a.category]}</span>
            <br />
            <Link href={articlePath(a)}>{a.title}</Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
