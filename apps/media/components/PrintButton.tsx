'use client';

import { track, getFirstTouch } from '@/lib/analytics';

// 印刷ボタン。任意で計測イベントを発火(チェックリストDL=CVの中間指標, docs/media/08)。
export default function PrintButton({ label, event }: { label: string; event?: string }) {
  const onClick = () => {
    if (event) track(event, { first_article: getFirstTouch() });
    window.print();
  };
  return (
    <button type="button" className="print-btn" onClick={onClick}>
      {label}
    </button>
  );
}
