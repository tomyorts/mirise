// GA4計測ユーティリティ(docs/media/08 3章)。
// 重要: 個人情報・医療情報はGA4に送らない。送るのは記事ID・カテゴリ・導線種別のみ。
// 計測IDは環境変数 NEXT_PUBLIC_GA_ID(静的エクスポート時にビルドへ埋め込む)。未設定なら無効。
export const GA_ID = process.env.NEXT_PUBLIC_GA_ID || '';

type Params = Record<string, string | number | boolean | undefined>;

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
    dataLayer?: unknown[];
  }
}

// 記事アトリビューションの根幹: 初回接触ページをlocalStorageに保存し、
// 相談・DL等のCV時に「きっかけ記事(first_article)」として付与する(docs/media/08 3.1)。
const FIRST_TOUCH_KEY = 'kyousei_first_touch';

export function captureFirstTouch(path: string) {
  if (typeof window === 'undefined' || !path) return;
  try {
    if (!window.localStorage.getItem(FIRST_TOUCH_KEY)) {
      window.localStorage.setItem(FIRST_TOUCH_KEY, path);
    }
  } catch {
    /* localStorage不可(プライベートモード等)でも計測以外は動作させる */
  }
}

export function getFirstTouch(): string {
  if (typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(FIRST_TOUCH_KEY) || '';
  } catch {
    return '';
  }
}

// GA4イベント送信。gtag未ロード(計測ID未設定)なら安全に何もしない。
export function track(event: string, params: Params = {}) {
  if (typeof window === 'undefined' || typeof window.gtag !== 'function') return;
  window.gtag('event', event, params);
}
