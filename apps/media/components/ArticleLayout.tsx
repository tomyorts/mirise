import Link from 'next/link';
import type { ReactNode } from 'react';
import { AUTHORS } from '@/lib/authors';
import { articlePath, CATEGORY_LABEL, type ArticleMeta } from '@/lib/articles';
import { REVIEW_STATUS_LABEL, SITE } from '@/lib/site';
import Cta from './Cta';
import JsonLd from './JsonLd';

// 記事共通テンプレート(docs/media/02 2.1)
// ヘッダー(執筆・監修・日付)→リード→本文→FAQ→参考文献→固定CTA
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
    author: { '@type': 'Person', name: author.name, jobTitle: author.title },
    reviewedBy: {
      '@type': 'Physician',
      name: reviewer.name,
      medicalSpecialty: 'https://schema.org/Dentistry',
      worksFor: { '@type': 'MedicalClinic', name: SITE.operator.name },
    },
    datePublished: meta.publishedAt,
    dateModified: meta.updatedAt,
    lastReviewed: meta.updatedAt,
    publisher: { '@type': 'Organization', name: SITE.name },
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
    <article className="container">
      <JsonLd data={jsonLd} />
      {faqLd && <JsonLd data={faqLd} />}

      <p style={{ fontSize: '0.78rem', marginTop: 24 }}>
        <Link href={`/${meta.category}/`}>{CATEGORY_LABEL[meta.category]}</Link>
      </p>
      <h1>{meta.title}</h1>

      {isDraft && (
        <p className="draft-banner">
          この記事は{REVIEW_STATUS_LABEL[meta.reviewStatus]}
          です。歯科医師監修とコンプライアンス確認(docs/media/04)が完了するまで一般公開しないでください。
        </p>
      )}

      <div className="article-meta">
        <span>
          執筆: {author.name}({author.qualifications[0]})
        </span>
        <span>
          監修: {reviewer.name}({reviewer.qualifications[0]})
        </span>
        <span>公開日: {meta.publishedAt}</span>
        <span>
          最終更新日: {meta.updatedAt}
          {meta.updateNote ? `(${meta.updateNote})` : ''}
        </span>
      </div>

      <div className="article-lead">{meta.summary}</div>

      <div className="article-body">{children}</div>

      {meta.faq.length > 0 && (
        <section>
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

      <Cta />
    </article>
  );
}
