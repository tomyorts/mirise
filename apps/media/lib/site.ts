export const SITE = {
  name: 'キョウセイの前に',
  tagline: '矯正治療の意思決定ガイド',
  // TODO: ドメイン確定後に差し替え(docs/media/01_brand_positioning.md)
  url: 'https://example.com',
  operator: {
    name: 'ミライズ矯正歯科南青山',
    url: 'https://example.com/clinic', // TODO: 医院公式サイトURL
    address: '東京都港区', // TODO: 正式住所
    tel: '00-0000-0000', // TODO: 代表電話
  },
  description:
    '矯正治療を始めるかどうか、誰に任せるかを考えている方のための意思決定支援メディア。顎変形症・外科矯正・再治療など、普通の矯正情報では答えが見つからない方のための一次情報を、矯正歯科専門医の実名監修でお届けします。',
} as const;

export type ReviewStatus = 'draft' | 'reviewed' | 'compliance_checked' | 'published';

export const REVIEW_STATUS_LABEL: Record<ReviewStatus, string> = {
  draft: '監修前ドラフト(公開不可)',
  reviewed: '歯科医師監修済み(コンプライアンス確認待ち)',
  compliance_checked: 'コンプライアンス確認済み',
  published: '公開済み',
};
