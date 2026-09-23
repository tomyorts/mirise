// スタッフ名(表示名)と、LiveKit上の identity(端末ごとに一意な内部ID)の規則。
// iPhoneアプリ・PC画面・/api/token で同じ規則を使う(identity_contract)。
//
// - identity: 端末/ブラウザごとに一意で変わらないID。同じIDで2台つなぐと先の1台が切断されるため、
//   スタッフ名に端末ごとのタグ(英小文字・数字6桁)を付けて作る。例: 佐藤_花子-a1b2c3
// - name: 画面に表示する名前。日本語名(全角スペース・「・」・1文字の姓)もそのまま使える。

export const DISPLAY_NAME_MAX_LENGTH = 32;

// 文字・数字・スペース(全角スペース含む)・「・」「_」「-」「.」
export const DISPLAY_NAME_PATTERN = /^[\p{L}\p{N}\p{Zs}・_\-.]+$/u;

export const DISPLAY_NAME_MESSAGES = {
  required: "スタッフ名を入力してください",
  tooLong: `スタッフ名は${DISPLAY_NAME_MAX_LENGTH}文字以内で入力してください`,
  invalidChars: "スタッフ名に使えるのは文字・数字・スペース・「・」「_」「-」「.」です",
} as const;

/** 表示名をチェックし、問題があれば日本語のメッセージを返す(問題なければ null)。 */
export function validateDisplayName(displayName: string): string | null {
  const trimmed = displayName.trim();
  if (!trimmed) return DISPLAY_NAME_MESSAGES.required;
  if (trimmed.length > DISPLAY_NAME_MAX_LENGTH) return DISPLAY_NAME_MESSAGES.tooLong;
  if (!DISPLAY_NAME_PATTERN.test(trimmed)) return DISPLAY_NAME_MESSAGES.invalidChars;
  return null;
}

/**
 * 文字列を UTF-16 の長さ maxLength までに切る。
 * 切れ目で絵文字や「𠮷」などのサロゲートペアが半分に割れないよう、末尾に残った上位サロゲートは除く。
 */
function sliceWithoutBrokenPair(value: string, maxLength: number): string {
  return value.slice(0, maxLength).replace(/[\uD800-\uDBFF]$/, "");
}

/**
 * 表示名と端末タグから identity を作る。
 * 結果は現在の本番 /api/token の identity 規則(/^[\p{L}\p{N}_\-. ]+$/u, 2〜64文字)を必ず満たす。
 */
export function buildIdentity(displayName: string, tag: string): string {
  const cleaned = displayName
    .normalize("NFKC")
    .trim()
    .replace(/[\s　]+/g, "_") // 全角を含む空白 → "_"
    .replace(/[^\p{L}\p{N}_\-.]/gu, ""); // identity に使えない文字を除く
  // NFKC で長くなる文字(ﬃ → ffi など)があるため 40 に切る。サロゲートペアは割らない。
  const base = sliceWithoutBrokenPair(cleaned, 40);
  return `${base || "staff"}-${tag}`;
}

/**
 * 規則に合わない表示名から使えない文字を除き、表示名として使える形にする(できなければ null)。
 * 名前の文字種を確かめない旧バージョンのiPhoneアプリ向けに、/api/token でだけ使う。
 * 例: 「佐藤(DH)」→「佐藤DH」
 */
export function sanitizeDisplayName(displayName: string): string | null {
  const cleaned = displayName
    .normalize("NFC")
    .replace(/[\t\n\r\v\f\u2028\u2029]+/g, " ") // タブ・改行はスペースに
    .replace(/[^\p{L}\p{N}\p{Zs}・_\-.]/gu, "")
    .trim();
  const result = sliceWithoutBrokenPair(cleaned, DISPLAY_NAME_MAX_LENGTH).trim();
  return validateDisplayName(result) === null ? result : null;
}
