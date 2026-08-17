import type { Metadata } from 'next';
import Link from 'next/link';
import Breadcrumbs from '@/components/Breadcrumbs';
import JsonLd from '@/components/JsonLd';
import { AUTHORS } from '@/lib/authors';
import { ARTICLES, articlePath } from '@/lib/articles';
import { SITE, abs } from '@/lib/site';

export function generateStaticParams() {
  return Object.keys(AUTHORS).map((id) => ({ id }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const a = AUTHORS[id];
  if (!a) return {};
  return {
    title: `${a.name}(監修者プロフィール)`,
    description: `${a.title}。${a.bio}`,
    alternates: { canonical: abs(`/about/authors/${a.id}/`) },
  };
}

// E-E-A-Tの要。監修者の資格・専門・経歴・監修記事を実名で示し、
// JSON-LDのPhysician(@id)を実体化する(記事側のreviewedByが参照する先)。
export default async function AuthorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const author = AUTHORS[id];
  if (!author) return null;

  const authored = ARTICLES.filter(
    (a) => a.reviewerId === author.id || a.authorId === author.id
  );

  const personLd = {
    '@context': 'https://schema.org',
    '@type': 'Physician',
    '@id': `${SITE.url}/about/authors/${author.id}/#person`,
    name: author.name,
    jobTitle: author.title,
    description: author.bio,
    medicalSpecialty: 'https://schema.org/Dentistry',
    worksFor: { '@type': 'MedicalClinic', '@id': `${SITE.url}/about/#clinic`, name: SITE.operator.name },
    url: `${SITE.url}/about/authors/${author.id}/`,
    ...(author.sameAs.length ? { sameAs: author.sameAs } : {}),
  };

  return (
    <>
      <Breadcrumbs
        items={[
          { label: '運営者情報', href: '/about/' },
          { label: `${author.name} プロフィール` },
        ]}
      />
      <div className="container policy">
        <JsonLd data={personLd} />
        <header className="page-header">
          <p className="eyebrow">SUPERVISOR</p>
          <h1>{author.name}</h1>
          <p className="page-lead">{author.title}</p>
        </header>

        <div className="author-box" style={{ marginTop: 8 }}>
          <span className="avatar" aria-hidden="true">
            医
          </span>
          <div>
            <p style={{ margin: 0 }}>{author.bio}</p>
          </div>
        </div>

        <h2>資格・所属</h2>
        <ul>
          {author.qualifications.map((q) => (
            <li key={q}>{q}</li>
          ))}
        </ul>

        {author.specialties && author.specialties.length > 0 && (
          <>
            <h2>専門領域</h2>
            <ul>
              {author.specialties.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </>
        )}

        {author.career && author.career.length > 0 && (
          <>
            <h2>経歴</h2>
            <ul>
              {author.career.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </>
        )}

        {author.sameAs.length > 0 && (
          <>
            <h2>外部プロフィール</h2>
            <ul>
              {author.sameAs.map((u) => (
                <li key={u}>
                  <a href={u} rel="me">
                    {u}
                  </a>
                </li>
              ))}
            </ul>
          </>
        )}

        <h2>監修・執筆した記事</h2>
        <ul className="article-list">
          {authored.map((a) => (
            <li key={a.slug}>
              <Link href={articlePath(a)}>
                <span className="list-title">{a.title}</span>
              </Link>
            </li>
          ))}
        </ul>

        <p className="note">
          監修体制と記事の作り方については
          <Link href="/about/editorial-policy/">編集ポリシー</Link>
          をご覧ください。
        </p>
      </div>
    </>
  );
}
