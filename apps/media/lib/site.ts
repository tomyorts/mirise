// メディアは既存クリニックサイト(mirise-ortho.com, WordPress, 月間約4万PV)の
// サブディレクトリ /media/ 配下で配信する。origin=ドメイン, basePath=サブパス, url=両者の連結。
// SITE.url は全JSON-LDの@id・canonical・OGP・sitemap の絶対URLの基点になる。
const ORIGIN = 'https://mirise-ortho.com';
const BASE_PATH = '/media'; // next.config.mjs の basePath と一致させること

export const SITE = {
  name: 'キョウセイの前に',
  tagline: '矯正治療の意思決定ガイド',
  origin: ORIGIN,
  basePath: BASE_PATH,
  url: `${ORIGIN}${BASE_PATH}`,
  operator: {
    name: 'ミライズ矯正歯科南青山',
    url: `${ORIGIN}/`, // 医院公式サイト(既存クリニックサイト)
    address: '〒107-0062 東京都港区南青山6丁目13-5 ポルトポヌール1階',
    tel: '03-5468-5585',
  },
  description:
    '矯正治療を始めるかどうか、誰に任せるかを考えている方のための意思決定支援メディア。顎変形症・外科矯正・再治療など、普通の矯正情報では答えが見つからない方のための一次情報を、矯正歯科専門医の実名監修でお届けします。',
} as const;

// canonical / OGP / JSON-LD 用の絶対URLを生成する(basePath /media を含む)。
export const abs = (path: string) => `${SITE.url}${path}`;

export type ReviewStatus = 'draft' | 'reviewed' | 'compliance_checked' | 'published';

export const REVIEW_STATUS_LABEL: Record<ReviewStatus, string> = {
  draft: '監修前ドラフト(公開不可)',
  reviewed: '歯科医師監修済み(コンプライアンス確認待ち)',
  compliance_checked: 'コンプライアンス確認済み',
  published: '公開済み',
};
