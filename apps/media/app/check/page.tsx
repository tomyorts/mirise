import type { Metadata } from 'next';
import { abs } from '@/lib/site';
import Breadcrumbs from '@/components/Breadcrumbs';
import SelfCheck from '@/components/SelfCheck';

export const metadata: Metadata = {
  title: '3分セルフチェック:あなたが今読むべき記事',
  description:
    '3つの質問に答えると、あなたの状況(受け口・開咬・抜歯・費用・治療中の不安など)に合った記事と、相談すべきかどうかの目安が分かります。',
  alternates: { canonical: abs('/check/') },
};

export default function CheckPage() {
  return (
    <>
      <Breadcrumbs items={[{ label: '3分セルフチェック' }]} />
      <div className="container">
        <header className="page-header">
          <p className="eyebrow">SELF CHECK</p>
          <h1>3分セルフチェック</h1>
          <p className="page-lead">
            3つの質問に答えると、あなたの状況に合った記事と、いま相談すべきかどうかの目安をご案内します。個人情報の入力は不要です。
          </p>
        </header>
        <SelfCheck />
      </div>
    </>
  );
}
