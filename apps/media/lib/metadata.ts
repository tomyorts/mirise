import type { Metadata } from 'next';
import { articlePath, type ArticleMeta } from './articles';
import { SITE, abs } from './site';
import { hasReview, isReviewPublished } from '@/content/review';

// 記事ページ共通のSEOメタデータ(OGP/canonical)。全記事ページで使用する
export function articleMetadata(meta: ArticleMeta): Metadata {
  const path = articlePath(meta);
  // 公開済みの記事だけを検索エンジンの対象にする(サイト全体のnoindexを上書き)。
  // 未確定・未公開の記事はnoindexのまま(誤って公開・インデックスされない)。
  const published = hasReview(meta.slug)
    ? isReviewPublished(meta.slug)
    : meta.reviewStatus === 'published';
  return {
    title: meta.title,
    description: meta.summary,
    robots: published ? { index: true, follow: true } : { index: false, follow: false },
    alternates: { canonical: abs(path) },
    openGraph: {
      title: meta.title,
      description: meta.summary,
      url: abs(path),
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
