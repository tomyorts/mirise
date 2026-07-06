import type { Metadata } from 'next';
import ArticleLayout from '@/components/ArticleLayout';
import { getArticle } from '@/lib/articles';

const meta = getArticle('faq', 'otona-nenrei')!;

export const metadata: Metadata = { title: meta.title, description: meta.summary };

export default function Page() {
  return (
    <ArticleLayout meta={meta}>
      <h2>答え:年齢の上限はありません。ただし設計が変わります</h2>
      <p>
        歯の移動は骨の代謝(リモデリング)によって起こるため、年齢を問わず歯は動きます。50代・60代で矯正を始める方も珍しくありません。一方で、年齢とともに次の条件が治療計画に影響します。
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>条件</th>
              <th>治療への影響</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>歯周病の有無</td>
              <td>
                コントロールされていない歯周病がある状態での矯正は、歯を支える骨のさらなる喪失につながるリスクがあります。歯周治療が必ず先行します
              </td>
            </tr>
            <tr>
              <td>被せ物・欠損</td>
              <td>
                矯正単独ではなく、補綴(被せ物・インプラント等)と組み合わせた咬合再建の設計になる場合があります
              </td>
            </tr>
            <tr>
              <td>歯の移動速度</td>
              <td>成長期に比べゆっくりになる傾向があり、治療期間が長めになることがあります</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>大人の矯正で大切なのは「何のためにやるか」</h2>
      <p>
        中高年の矯正は「すべての歯を理想的に並べる」ことだけがゴールではありません。「奥歯で噛める状態を長く保つ」「清掃しやすい歯並びにして歯の寿命を延ばす」「補綴治療の前提を整える」など、
        <strong>目的に応じてゴールを設計する</strong>
        ことで、治療の負担と得られる価値のバランスが取れます。カウンセリングでは「私の場合、どこまでやる価値がありますか」と目的から相談することをおすすめします。
      </p>
    </ArticleLayout>
  );
}
