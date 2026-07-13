// ============================================================
// ★ 公開管理ファイル(ここだけ編集すれば記事を公開できます)
// ------------------------------------------------------------
// 使い方(エンジニア不要):
//   1. 各記事の values の「◯◯」を、先生が確定した数値に置き換える
//      例: '総額◯◯万円〜◯◯万円' → '総額40万円〜120万円'
//   2. その記事に「◯◯」「要確認」が1つも残っていない状態にする
//   3. publish を true にする
//      → その記事だけ、本番で「公開」かつ「検索エンジンの対象」になります
//      → ページ上部のドラフト注意バナーも消えます
//
//   ※ 安全装置: ◯◯ が残ったまま publish:true にしても、ビルド時の
//      チェック(scripts/check-publish.mjs)で止まります。未確定の数値が
//      そのまま公開されることはありません。
//
//   ここに載っている記事が、いま数値を入力して公開できる記事です。
//   ほかの記事も同じ形にできます(順次このファイルへ追加します)。
// ============================================================
export type ArticleReview = {
  publish: boolean;
  values: Record<string, string>;
};

export const REVIEW: Record<string, ArticleReview> = {
  // 開咬(前歯が閉じない)の原因別治療法
  kaikou: {
    publish: false,
    values: {
      // 自由診療の費用(◯◯を確定額に置き換える)
      cost: '全体矯正で総額◯◯万円〜◯◯万円程度。MFTや歯科矯正用アンカースクリューは別途費用となる場合があります',
    },
  },
};

// 未確定を表すプレースホルダ(これが残っていると「確定していない」と判定)
const PLACEHOLDER = /[◯○●]|要確認/;

// 記事が公開管理の対象か
export function hasReview(slug: string): boolean {
  return Boolean(REVIEW[slug]);
}

// 差し込み値を返す(未登録キーは空文字)
export function reviewValue(slug: string, key: string): string {
  return REVIEW[slug]?.values?.[key] ?? '';
}

// 公開可能か: publish=true かつ values に未確定プレースホルダが無い
export function isReviewPublished(slug: string): boolean {
  const r = REVIEW[slug];
  if (!r || !r.publish) return false;
  return !Object.values(r.values).some((v) => PLACEHOLDER.test(v));
}
