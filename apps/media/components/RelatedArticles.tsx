import Link from 'next/link';
import { ARTICLES, articlePath, CATEGORY_LABEL, type ArticleMeta } from '@/lib/articles';

// 回遊設計の要。related指定があればそれを、なければ同カテゴリから自動選出(最大4件)
export default function RelatedArticles({ meta }: { meta: ArticleMeta }) {
  const selfPath = articlePath(meta);
  const paths =
    meta.related && meta.related.length > 0
      ? meta.related
      : ARTICLES.filter((a) => a.category === meta.category)
          .map(articlePath)
          .filter((p) => p !== selfPath)
          .slice(0, 3);

  const items = paths
    .map((p) => ARTICLES.find((a) => articlePath(a) === p))
    .filter((a): a is ArticleMeta => Boolean(a) && articlePath(a!) !== selfPath)
    .slice(0, 4);

  if (items.length === 0) return null;

  return (
    <section className="related">
      <h2>あわせて読みたい</h2>
      <ul className="article-list">
        {items.map((a) => (
          <li key={a.slug}>
            <Link href={articlePath(a)}>
              <span className="list-title">{a.title}</span>
              <span className="badge">{CATEGORY_LABEL[a.category]}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
