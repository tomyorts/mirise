'use client';

import { useEffect, useRef } from 'react';
import { track } from '@/lib/analytics';

// 記事の実質完読を計測(docs/media/08 3.1: 90%スクロール+60秒滞在で article_read_90)。
// 中間KPI「記事完読率」の取得源。1記事につき1回だけ発火する。
export default function ScrollDepth({
  articleId,
  category,
}: {
  articleId: string;
  category: string;
}) {
  const fired = useRef(false);
  const start = useRef(0);

  useEffect(() => {
    start.current = Date.now();
    const onScroll = () => {
      if (fired.current) return;
      const doc = document.documentElement;
      const denom = doc.scrollHeight - window.innerHeight;
      const ratio = denom > 0 ? window.scrollY / denom : 1;
      const dwell = (Date.now() - start.current) / 1000;
      if (ratio >= 0.9 && dwell >= 60) {
        fired.current = true;
        track('article_read_90', { article_id: articleId, category });
        window.removeEventListener('scroll', onScroll);
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [articleId, category]);

  return null;
}
