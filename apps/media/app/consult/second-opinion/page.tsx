import type { Metadata } from 'next';
import Link from 'next/link';
import { SITE } from '@/lib/site';

export const metadata: Metadata = { title: 'オンラインセカンドオピニオン' };

// 限定解除4要件を1ページで満たす構成(docs/media/04):
// 問い合わせ先/自由診療の内容・費用/リスク・副作用/読者が自ら閲覧するページ
export default function SecondOpinionConsult() {
  return (
    <div className="container policy">
      <h1>オンラインセカンドオピニオン(自由診療)</h1>
      <p className="draft-banner">
        提供体制準備中: 価格・所要時間・同意書・予約枠は docs/media 07章のとおり確定後に公開する。以下は仮の記載。
      </p>
      <p>
        {SITE.operator.name}
        の矯正歯科医師が、現在の診断・治療計画について、資料に基づき第三者としての意見をお伝えします。診療(診断・処方)ではなく、意思決定のための情報提供・意見の提示です。
      </p>

      <h2>ご相談内容の例</h2>
      <ul>
        <li>抜歯・非抜歯、外科手術の要否について別の専門医の意見を聞きたい</li>
        <li>顎変形症の保険適用の可能性を確認したい</li>
        <li>治療中だが計画に不安があり、継続か転院かを考えたい</li>
        <li>一度治療した歯並びの後戻り・再治療について相談したい</li>
      </ul>

      <h2>費用・時間(自由診療)</h2>
      <table>
        <tbody>
          <tr>
            <th style={{ textAlign: 'left', paddingRight: 16 }}>料金</th>
            <td>◯◯,◯◯◯円(税込)/ 1回(確定後に記載)</td>
          </tr>
          <tr>
            <th style={{ textAlign: 'left', paddingRight: 16 }}>時間</th>
            <td>約◯◯分・オンライン(ビデオ通話)</td>
          </tr>
          <tr>
            <th style={{ textAlign: 'left', paddingRight: 16 }}>資料</th>
            <td>
              X線・治療計画書等があると具体的な意見が可能です(
              <Link href="/guide/second-opinion/">持参資料の説明</Link>)
            </td>
          </tr>
        </tbody>
      </table>
      <p style={{ fontSize: '0.88rem' }}>
        セカンドオピニオンは公的医療保険適用外(自費)です。オンラインでの意見提示には、資料の精度による限界があります。対面での精密検査が必要と判断した場合は、その旨をお伝えします(当院以外の医療機関での検査でも構いません)。
      </p>

      <h2>お申し込み・お問い合わせ</h2>
      <p>
        予約フォーム(準備中)/ 電話: {SITE.operator.tel}({SITE.operator.name})
      </p>
    </div>
  );
}
