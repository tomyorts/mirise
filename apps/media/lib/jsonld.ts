import { SITE } from './site';
import { articlePath, type ArticleMeta } from './articles';

// 記事一覧の ItemList 構造化データ(AI検索・SERPでの記事群認識用)。
// カテゴリ一覧・トップの記事リストに付与する。
export function itemListLd(items: ArticleMeta[], name: string) {
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name,
    numberOfItems: items.length,
    itemListElement: items.map((a, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      url: `${SITE.url}${articlePath(a)}`,
      name: a.title,
    })),
  };
}
