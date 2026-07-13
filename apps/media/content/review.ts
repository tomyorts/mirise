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

  // 外科矯正のリスクと合併症
  'geka-risk': {
    publish: false,
    values: {
      cost: '顎変形症の診断のもと、指定を受けた医療機関で手術を前提とした治療を行う場合は健康保険が適用され、自己負担3割で矯正治療と手術を合わせて総額◯◯万円程度が目安です。高額療養費制度の対象になる場合があります。保険適用の条件を満たさない場合は全額自己負担となります。',
    },
  },

  // 顔の左右非対称(顎のゆがみ)は治せるか
  'ganmen-hitaishou': {
    publish: false,
    values: {
      cost: '総額◯◯万円〜◯◯万円。装置の種類や症例の難易度によって変動します。検査・診断料、通院ごとの調整料が別途かかる場合があります。',
    },
  },

  // 3Dシミュレーションで分かること・分からないこと
  '3d-simulation': {
    publish: false,
    values: {
      cost: '精密検査・診断料(シミュレーション作成を含む):◯万円程度、矯正治療総額:◯◯万円〜◯◯万円',
    },
  },

  // ワイヤー矯正とマウスピース矯正:適応の科学
  'wire-aligner': {
    publish: false,
    values: {
      cost: '全体矯正の総額目安:ワイヤー矯正 ◯◯万円〜◯◯万円/マウスピース矯正 ◯◯万円〜◯◯万円。検査・診断料、毎回の調整料、保定装置の費用が別途かかる場合があります。',
    },
  },

  // 抜歯矯正と非抜歯矯正の判断基準
  'basshi-hibassi': {
    publish: false,
    values: {
      cost: '検査・診断料 ◯◯万円、装置・技術料 ◯◯万円〜◯◯万円、調整料 月◯◯円程度',
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
