import type { MetadataRoute } from 'next';
import { ARTICLES, articlePath } from '@/lib/articles';
import { SITE } from '@/lib/site';

export const dynamic = 'force-static';

export default function sitemap(): MetadataRoute.Sitemap {
  const staticPaths = [
    '/',
    '/guide/',
    '/jaw-surgery/',
    '/treatment/',
    '/faq/',
    '/about/',
    '/about/editorial-policy/',
    '/consult/second-opinion/',
    '/consult/complex-cases/',
  ];
  return [
    ...staticPaths.map((p) => ({ url: `${SITE.url}${p}` })),
    // lastModifiedは実際の更新時のみ変える方針(docs/media/06 技術チェックリスト)
    ...ARTICLES.map((a) => ({
      url: `${SITE.url}${articlePath(a)}`,
      lastModified: a.updatedAt,
    })),
  ];
}
