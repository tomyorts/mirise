import Link from 'next/link';
import ArticleLayout from '@/components/ArticleLayout';
import { getArticle } from '@/lib/articles';
import { articleMetadata } from '@/lib/metadata';

const meta = getArticle('faq', 'gakuhenkei-nanika')!;

export const metadata = articleMetadata(meta);

// 監修前ドラフト。
export default function Page() {
  return (
    <ArticleLayout meta={meta}>
      <h2>答え:矯正歯科か、病院の歯科口腔外科が入口になります</h2>
      <p>
        顎変形症(あごの骨格のずれが原因で、噛み合わせや顔立ちに影響が出ている状態)が疑われるときの受診先は、矯正歯科または病院の歯科口腔外科です。顎変形症の治療は、歯並びを整える矯正歯科と、あごの骨の手術を担当する口腔外科が連携して進めるため、どちらから受診しても、治療が本格的に始まる段階では両方の診療科が関わることになります。
      </p>
      <p>
        健康保険を使って治療する可能性を考えるなら、顎口腔機能診断施設(保険での外科矯正に必要な施設基準を満たし、指定を受けた医療機関)である矯正歯科を最初に選ぶと、診断から保険での治療までが一貫します。指定の有無は医療機関のウェブサイトに記載されていることが多く、受診前に電話で確認しても差し支えありません。かかりつけの一般歯科がある場合は、そこから連携先の矯正歯科や口腔外科を紹介してもらうルートもあります。
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>気になっていること</th>
              <th>入口として適した受診先</th>
              <th>そこでできること</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>噛み合わせや見た目のずれが気になる</td>
              <td>矯正歯科</td>
              <td>セファロ(頭部X線規格写真)による骨格の分析から診断を進められます</td>
            </tr>
            <tr>
              <td>あごの変形が大きい・痛みなどの症状がある</td>
              <td>病院の歯科口腔外科</td>
              <td>手術の要否を含めた評価と、連携する矯正歯科の紹介が受けられます</td>
            </tr>
            <tr>
              <td>何から始めればよいか分からない・まず相談したい</td>
              <td>かかりつけの一般歯科</td>
              <td>口の中の状態を踏まえて、適切な専門機関を紹介してもらえます</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>確認すべきこと</h2>
      <ul>
        <li>
          その医療機関が顎口腔機能診断施設の指定を受けているか(保険での治療を視野に入れる場合)
        </li>
        <li>矯正歯科なら連携する口腔外科(手術先の病院)、口腔外科なら連携する矯正歯科はどこか</li>
        <li>顎変形症と診断された場合の、治療の流れと期間のおおまかな見通し</li>
      </ul>
      <p>
        健康保険が適用されるかどうかは、顎変形症の診断・指定医療機関での治療・外科手術を前提とした治療計画という条件に関わります。詳しくは
        <Link href="/jaw-surgery/hoken-tekiyo/">保険適用の条件</Link>
        を、診断から手術・保定までの流れは
        <Link href="/jaw-surgery/geka-nagare/">外科矯正の全体像</Link>
        を参照してください。
      </p>
    </ArticleLayout>
  );
}
