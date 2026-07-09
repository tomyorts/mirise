import type { ReactNode } from 'react';
import Link from 'next/link';
import { AUTHORS } from '@/lib/authors';
import { articlePath, CATEGORY_LABEL, type ArticleMeta } from '@/lib/articles';
import { REVIEW_STATUS_LABEL, SITE } from '@/lib/site';
import Breadcrumbs from './Breadcrumbs';
import Cta from './Cta';
import JsonLd from './JsonLd';
import RelatedArticles from './RelatedArticles';

// 記事共通テンプレート(docs/media/02 2.1)
// パンくず→ヘッダー(執筆・監修・日付)→リード→目次→本文→FAQ→参考文献→執筆者→固定CTA
export default function ArticleLayout({
  meta,
  children,
}: {
  meta: ArticleMeta;
  children: ReactNode;
}) {
  const author = AUTHORS[meta.authorId];
  const reviewer = AUTHORS[meta.reviewerId];
  const isDraft = meta.reviewStatus !== 'published';

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'MedicalWebPage',
    headline: meta.title,
    description: meta.summary,
    url: `${SITE.url}${articlePath(meta)}`,
    inLanguage: 'ja',
    // AI検索・音声アシスタントへの引用ターゲット指定(要点リード)
    speakable: { '@type': 'SpeakableSpecification', cssSelector: ['.article-lead'] },
    ...(meta.condition
      ? { about: { '@type': 'MedicalCondition', name: meta.condition } }
      : {}),
    author: { '@type': 'Person', name: author.name, jobTitle: author.title },
    reviewedBy: {
      '@type': 'Physician',
      '@id': `${SITE.url}/about/authors/${reviewer.id}/#person`,
      name: reviewer.name,
      medicalSpecialty: 'https://schema.org/Dentistry',
      worksFor: { '@type': 'MedicalClinic', '@id': `${SITE.url}/about/#clinic`, name: SITE.operator.name },
    },
    datePublished: meta.publishedAt,
    dateModified: meta.updatedAt,
    lastReviewed: meta.updatedAt,
    publisher: { '@id': `${SITE.url}/about/#organization` },
  };

  const faqLd = meta.faq.length
    ? {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: meta.faq.map((f) => ({
          '@type': 'Question',
          name: f.question,
          acceptedAnswer: { '@type': 'Answer', text: f.answer },
        })),
      }
    : null;

  return (
    <>
      <Breadcrumbs
        items={[
          { label: CATEGORY_LABEL[meta.category], href: `/${meta.category}/` },
          { label: meta.title },
        ]}
      />
      <article className="container">
        <JsonLd data={jsonLd} />
        {faqLd && <JsonLd data={faqLd} />}

        <header className="article-header">
          <h1>{meta.title}</h1>

          {isDraft && (
            <p className="draft-banner">
              この記事は{REVIEW_STATUS_LABEL[meta.reviewStatus]}
              です。歯科医師監修とコンプライアンス確認(docs/media/04)が完了するまで一般公開しないでください。
            </p>
          )}

          <div className="article-meta">
            <span>
              執筆: <b>{author.name}</b>({author.qualifications[0]})
            </span>
            <span>
              監修: <b>{reviewer.name}</b>({reviewer.qualifications[0]})
            </span>
            <span>公開日: {meta.publishedAt}</span>
            <span>
              最終更新日: {meta.updatedAt}
              {meta.updateNote ? `(${meta.updateNote})` : ''}
            </span>
          </div>
        </header>

        <div className="article-lead">
          <span className="label">この記事の要点</span>
          {meta.summary}
        </div>

        {meta.toc && meta.toc.length > 0 && (
          <nav className="toc" aria-label="目次">
            <span className="label">目次</span>
            <ol>
              {meta.toc.map((t) => (
                <li key={t.id}>
                  <a href={`#${t.id}`}>{t.label}</a>
                </li>
              ))}
              {meta.faq.length > 0 && (
                <li>
                  <a href="#faq">この記事に関するよくある質問</a>
                </li>
              )}
            </ol>
          </nav>
        )}

        <div className="article-body">{children}</div>

        {meta.faq.length > 0 && (
          <section id="faq">
            <h2>この記事に関するよくある質問</h2>
            {meta.faq.map((f) => (
              <div className="faq-item" key={f.question}>
                <h3>{f.question}</h3>
                <p>{f.answer}</p>
              </div>
            ))}
          </section>
        )}

        {meta.references.length > 0 && (
          <section className="references">
            <h2>参考文献</h2>
            <ol>
              {meta.references.map((r) => (
                <li key={r.name}>
                  {r.url ? <a href={r.url}>{r.name}</a> : r.name}
                  {r.note ? `(${r.note})` : ''}
                </li>
              ))}
            </ol>
          </section>
        )}

        <RelatedArticles meta={meta} />

        <aside className="author-box">
          <span className="avatar" aria-hidden="true">
            医
          </span>
          <div className="body">
            <span className="name">
              <Link href={`/about/authors/${reviewer.id}/`}>{reviewer.name}</Link>
            </span>
            <span className="role">{reviewer.title}</span>
            <p>{reviewer.bio}</p>
            <p>
              <Link href={`/about/authors/${reviewer.id}/`}>監修者プロフィール</Link> /{' '}
              <Link href="/about/editorial-policy/">監修体制について</Link>
            </p>
          </div>
        </aside>

        <Cta />
      </article>
    </>
  );
}
