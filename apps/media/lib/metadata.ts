import type { Metadata } from 'next';
import { articlePath, type ArticleMeta } from './articles';
import { SITE } from './site';

// 記事ページ共通のSEOメタデータ(OGP/canonical)。全記事ページで使用する
export function articleMetadata(meta: ArticleMeta): Metadata {
  const path = articlePath(meta);
  return {
    title: meta.title,
    description: meta.summary,
    alternates: { canonical: path },
    openGraph: {
      title: meta.title,
      description: meta.summary,
      url: path,
      type: 'article',
      siteName: SITE.name,
      locale: 'ja_JP',
      publishedTime: meta.publishedAt,
      modifiedTime: meta.updatedAt,
    },
    twitter: {
      card: 'summary_large_image',
      title: meta.title,
      description: meta.summary,
    },
  };
}
