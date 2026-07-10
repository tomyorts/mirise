import type { Metadata } from 'next';
import Link from 'next/link';
import { SITE } from '@/lib/site';
import JsonLd from '@/components/JsonLd';
import Logo from '@/components/Logo';
import Analytics from '@/components/Analytics';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(SITE.url),
  title: {
    default: `${SITE.name}|${SITE.tagline}`,
    template: `%s|${SITE.name}`,
  },
  description: SITE.description,
  openGraph: {
    siteName: SITE.name,
    type: 'website',
    locale: 'ja_JP',
  },
  robots: { index: false, follow: false }, // TODO: ローンチ時(監修・コンプラ完了後)に解除
};

const orgLd = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  '@id': `${SITE.url}/about/#organization`,
  name: SITE.name,
  url: SITE.url,
  parentOrganization: {
    '@type': 'MedicalClinic',
    '@id': `${SITE.url}/about/#clinic`,
    name: SITE.operator.name,
    address: SITE.operator.address,
    telephone: SITE.operator.tel,
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>
        <Analytics />
        <JsonLd data={orgLd} />
        <a href="#main" className="skip-link">
          本文へスキップ
        </a>
        <header className="site-header">
          <div className="inner">
            <Link href="/" className="brand">
              <Logo />
              <span>
                <span className="brand-name">キョウセイの前に</span>
                <span className="brand-tag">{SITE.tagline}</span>
              </span>
            </Link>
            <nav className="global-nav" aria-label="グローバルナビゲーション">
              <Link href="/guide/">意思決定ガイド</Link>
              <Link href="/jaw-surgery/">難症例・外科矯正</Link>
              <Link href="/treatment/">治療法を知る</Link>
              <Link href="/faq/">よくある質問</Link>
              <Link href="/glossary/">用語集</Link>
              <Link href="/about/">運営者情報</Link>
              <Link href="/consult/second-opinion/" className="nav-consult">
                相談する
              </Link>
            </nav>
          </div>
        </header>
        <main id="main">{children}</main>
        <footer className="site-footer">
          <div className="inner">
            <div className="footer-grid">
              <div className="footer-brand">
                <span className="brand-name">キョウセイの前に</span>
                <span className="brand-tag">{SITE.tagline}</span>
                <p className="footer-note">
                  運営: {SITE.operator.name}
                  <br />
                  本サイトは、医院のランキング・口コミの掲載、医院からの掲載料・紹介料の受け取りを行いません。すべての記事は歯科医師が実名で監修しています。
                </p>
              </div>
              <div className="footer-col">
                <h3>コンテンツ</h3>
                <ul>
                  <li>
                    <Link href="/check/">3分セルフチェック</Link>
                  </li>
                  <li>
                    <Link href="/guide/">意思決定ガイド</Link>
                  </li>
                  <li>
                    <Link href="/jaw-surgery/">難症例・外科矯正</Link>
                  </li>
                  <li>
                    <Link href="/treatment/">治療法を正しく理解する</Link>
                  </li>
                  <li>
                    <Link href="/faq/">よくある誤解と不安</Link>
                  </li>
                  <li>
                    <Link href="/glossary/">矯正用語集</Link>
                  </li>
                  <li>
                    <Link href="/guide/counseling-checklist/">カウンセリング準備チェックリスト</Link>
                  </li>
                </ul>
              </div>
              <div className="footer-col">
                <h3>サイトについて</h3>
                <ul>
                  <li>
                    <Link href="/about/">運営者情報</Link>
                  </li>
                  <li>
                    <Link href="/about/editorial-policy/">編集ポリシー</Link>
                  </li>
                  <li>
                    <Link href="/consult/second-opinion/">オンラインセカンドオピニオン</Link>
                  </li>
                  <li>
                    <Link href="/consult/complex-cases/">難症例のご相談</Link>
                  </li>
                </ul>
              </div>
            </div>
            <div className="footer-legal">
              <span>
                © {SITE.operator.name}
              </span>
              <span>本サイトの情報は一般的な医療情報であり、個別の診断に代わるものではありません。</span>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
