'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { track, getFirstTouch } from '@/lib/analytics';

// GA4イベントを発火する内部リンク(<Link>にonClick計測を足しただけ)。
// CVの手前の導線(固定CTA・セルフチェック結果CTA等)に使う。
export default function TrackedLink({
  href,
  event,
  params,
  className,
  children,
}: {
  href: string;
  event: string;
  params?: Record<string, string | number | boolean | undefined>;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      className={className}
      onClick={() => track(event, { ...params, first_article: getFirstTouch() })}
    >
      {children}
    </Link>
  );
}
