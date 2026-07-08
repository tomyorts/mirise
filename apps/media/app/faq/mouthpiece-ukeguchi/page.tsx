import Link from 'next/link';
import ArticleLayout from '@/components/ArticleLayout';
import { getArticle } from '@/lib/articles';
import { articleMetadata } from '@/lib/metadata';

const meta = getArticle('faq', 'mouthpiece-ukeguchi')!;

export const metadata = articleMetadata(meta);

export default function Page() {
  return (
    <ArticleLayout meta={meta}>
      <h2>答え:原因が「歯」か「骨格」かで決まります</h2>
      <p>
        受け口(反対咬合)の原因は大きく2つに分かれます。前歯の傾きによるもの(歯性)と、下顎の骨格が上顎に対して前方にずれているもの(骨格性)です。
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>タイプ</th>
              <th>原因</th>
              <th>マウスピース矯正の位置づけ</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>歯性の受け口</td>
              <td>前歯の傾き・位置</td>
              <td>症例により矯正単独(装置の種類を問わず)で改善できる場合があります</td>
            </tr>
            <tr>
              <td>骨格性の受け口</td>
              <td>顎の骨格のずれ</td>
              <td>
                マウスピースに限らず、どの矯正装置でも骨格自体は変えられません。根本的な治療は外科手術の併用が標準です
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        つまり「マウスピースで治るか」は装置の問題ではなく<strong>診断の問題</strong>
        です。骨格性のずれが大きい症例で歯の移動だけで見た目を補う治療(カモフラージュ矯正)を選ぶ場合は、達成できるゴールに限界があることを理解した上での選択になります。
      </p>

      <h2>確認すべきこと</h2>
      <ul>
        <li>セファログラム(頭部X線規格写真)による骨格の分析を受けたか</li>
        <li>自分の受け口が歯性か骨格性か、その根拠は何か</li>
        <li>
          骨格性の場合、手術を併用する治療(
          <Link href="/jaw-surgery/hoken-tekiyo/">保険適用の可能性があります</Link>
          )と、カモフラージュ矯正のそれぞれのゴールの違い
        </li>
      </ul>
      <p>
        「マウスピースで治せます」という説明を受けた場合は、骨格の分析結果と、治療後に達成されるゴール(噛み合わせ・横顔)の説明を求めてください。説明が曖昧な場合は
        <Link href="/guide/second-opinion/">セカンドオピニオン</Link>を検討する場面です。
      </p>
    </ArticleLayout>
  );
}
