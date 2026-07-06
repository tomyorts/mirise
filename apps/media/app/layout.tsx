import type { Metadata } from 'next';
import Link from 'next/link';
import { SITE } from '@/lib/site';
import JsonLd from '@/components/JsonLd';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: `${SITE.name}|${SITE.tagline}`,
    template: `%s|${SITE.name}`,
  },
  description: SITE.description,
  robots: { index: false, follow: false }, // TODO: ローンチ時(監修・コンプラ完了後)に解除
};

const orgLd = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: SITE.name,
  url: SITE.url,
  parentOrganization: {
    '@type': 'MedicalClinic',
    name: SITE.operator.name,
    address: SITE.operator.address,
    telephone: SITE.operator.tel,
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>
        <JsonLd data={orgLd} />
        <header className="site-header">
          <div className="inner">
            <Link href="/" className="brand">
              {SITE.name}
              <small>{SITE.tagline}</small>
            </Link>
            <nav className="global-nav">
              <Link href="/guide/">意思決定ガイド</Link>
              <Link href="/jaw-surgery/">難症例・外科矯正</Link>
              <Link href="/faq/">よくある誤解と不安</Link>
              <Link href="/about/">運営者情報</Link>
            </nav>
          </div>
        </header>
        <main>{children}</main>
        <footer className="site-footer">
          <div className="inner">
            <nav>
              <Link href="/about/">運営者情報</Link>
              <Link href="/about/editorial-policy/">編集ポリシー</Link>
              <Link href="/consult/second-opinion/">オンラインセカンドオピニオン</Link>
              <Link href="/consult/complex-cases/">難症例のご相談</Link>
            </nav>
            <p>
              運営: {SITE.operator.name}
              <br />
              本サイトは医院のランキング・口コミの掲載、医院からの掲載料・紹介料の受け取りを行いません(
              <Link href="/about/editorial-policy/">編集ポリシー</Link>)。
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
