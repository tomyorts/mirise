import type { MetadataRoute } from 'next';
import { ARTICLES, articlePath } from '@/lib/articles';
import { AUTHORS } from '@/lib/authors';
import { SITE } from '@/lib/site';

export const dynamic = 'force-static';

export default function sitemap(): MetadataRoute.Sitemap {
  const staticPaths = [
    '/',
    '/check/',
    '/guide/',
    '/guide/counseling-checklist/',
    '/jaw-surgery/',
    '/treatment/',
    '/faq/',
    '/about/',
    '/about/editorial-policy/',
    '/glossary/',
    '/consult/second-opinion/',
    '/consult/complex-cases/',
  ];
  const authorPaths = Object.keys(AUTHORS).map((id) => `/about/authors/${id}/`);
  return [
    ...staticPaths.map((p) => ({ url: `${SITE.url}${p}` })),
    ...authorPaths.map((p) => ({ url: `${SITE.url}${p}` })),
    // lastModifiedは実際の更新時のみ変える方針(docs/media/06 技術チェックリスト)
    ...ARTICLES.map((a) => ({
      url: `${SITE.url}${articlePath(a)}`,
      lastModified: a.updatedAt,
    })),
  ];
}
