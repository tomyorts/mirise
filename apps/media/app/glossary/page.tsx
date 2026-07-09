import type { Metadata } from 'next';
import Link from 'next/link';
import Breadcrumbs from '@/components/Breadcrumbs';
import JsonLd from '@/components/JsonLd';
import { GLOSSARY, GLOSSARY_CATEGORIES } from '@/lib/glossary';
import { SITE } from '@/lib/site';

export const metadata: Metadata = {
  title: '矯正歯科の用語集:患者向けにやさしく解説',
  description:
    '顎変形症・外科矯正・サージェリーファースト・咬合・保定など、矯正歯科でよく使われる用語を、矯正歯科医師がやさしく解説する用語集です。',
  alternates: { canonical: '/glossary/' },
};

// DefinedTermSet: 各用語を定義文とともにAI検索へ提示(docs/media/06)
const termSetLd = {
  '@context': 'https://schema.org',
  '@type': 'DefinedTermSet',
  name: '矯正歯科の用語集',
  url: `${SITE.url}/glossary/`,
  hasDefinedTerm: GLOSSARY.map((g) => ({
    '@type': 'DefinedTerm',
    '@id': `${SITE.url}/glossary/#${g.id}`,
    name: g.term,
    description: g.definition,
  })),
};

export default function GlossaryPage() {
  return (
    <>
      <Breadcrumbs items={[{ label: '矯正用語集' }]} />
      <div className="container">
        <JsonLd data={termSetLd} />
        <header className="page-header">
          <p className="eyebrow">GLOSSARY</p>
          <h1>矯正歯科の用語集</h1>
          <p className="page-lead">
            診察やカウンセリングで出てくる矯正歯科の用語を、患者向けにやさしく解説します。各用語は、より詳しい記事にもリンクしています。
          </p>
        </header>

        <nav className="glossary-toc" aria-label="カテゴリ">
          {GLOSSARY_CATEGORIES.map((c) => (
            <a key={c} href={`#cat-${encodeURIComponent(c)}`}>
              {c}
            </a>
          ))}
        </nav>

        {GLOSSARY_CATEGORIES.map((cat) => {
          const items = GLOSSARY.filter((g) => g.cat === cat);
          if (items.length === 0) return null;
          return (
            <section className="glossary-group" key={cat} id={`cat-${encodeURIComponent(cat)}`}>
              <h2>{cat}</h2>
              <dl>
                {items.map((g) => (
                  <div className="glossary-term" id={g.id} key={g.id}>
                    <dt>
                      {g.term}
                      <span className="reading">{g.reading}</span>
                    </dt>
                    <dd>
                      {g.definition}
                      {g.also ? <span className="also"> {g.also}</span> : null}
                      {g.link ? (
                        <span className="more">
                          {' '}
                          <Link href={g.link}>もっと詳しく →</Link>
                        </span>
                      ) : null}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          );
        })}
      </div>
    </>
  );
}
