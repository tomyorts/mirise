'use client';

import Script from 'next/script';
import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { GA_ID, captureFirstTouch } from '@/lib/analytics';

// GA4計測基盤(docs/media/08)。計測ID(NEXT_PUBLIC_GA_ID)が設定されている時だけ
// gtagを読み込む。初回接触記事の記録はIDの有無に関わらず行う(CVアトリビューション用)。
export default function Analytics() {
  const pathname = usePathname();

  useEffect(() => {
    if (pathname) captureFirstTouch(pathname);
  }, [pathname]);

  if (!GA_ID) return null;

  return (
    <>
      <Script
        src={`https://www.googletagmanager.com/gtag/js?id=${GA_ID}`}
        strategy="afterInteractive"
      />
      <Script id="ga4-init" strategy="afterInteractive">
        {`window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${GA_ID}',{anonymize_ip:true});`}
      </Script>
    </>
  );
}
