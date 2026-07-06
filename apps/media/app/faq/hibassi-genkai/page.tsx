import type { Metadata } from 'next';
import Link from 'next/link';
import ArticleLayout from '@/components/ArticleLayout';
import { getArticle } from '@/lib/articles';

const meta = getArticle('faq', 'hibassi-genkai')!;

export const metadata: Metadata = { title: meta.title, description: meta.summary };

export default function Page() {
  return (
    <ArticleLayout meta={meta}>
      <h2>答え:抜歯・非抜歯は「優劣」ではなく「診断の結果」です</h2>
      <p>
        矯正治療の設計は、歯を並べるために必要なスペースと、確保できるスペースの収支計算です。スペースの不足量が小さければ、歯列の拡大や歯の表面をわずかに削る処置(IPR)、奥歯の後方移動などで非抜歯の治療が成立します。不足量が大きい場合にこれらの手段だけで無理に並べると、次のような問題が起こり得ます。
      </p>
      <ul>
        <li>前歯が外に傾き、口元の突出感が強くなる</li>
        <li>歯を支える骨の範囲を超えて歯が移動し、歯茎の退縮のリスクが上がる</li>
        <li>並べきれず治療期間が延びる、または後戻りしやすい仕上がりになる</li>
      </ul>
      <p>
        逆に、抜歯が過剰であれば口元が下がりすぎるなどの問題が起こり得ます。
        <strong>どちらが正解かは症例ごとの分析でしか決まりません。</strong>
      </p>

      <h2>「非抜歯専門」をうたう医院を検討するときの確認点</h2>
      <ul>
        <li>スペース不足量の分析結果(模型・スキャン・X線に基づく数値)の提示があるか</li>
        <li>非抜歯で治療した場合の口元(側貌)の変化予測の説明があるか</li>
        <li>非抜歯で達成できるゴールと、抜歯した場合のゴールの違いの説明があるか</li>
      </ul>
      <p>
        方針(非抜歯)が先にあり、診断がそれに合わせて説明される場合は注意が必要です。判断に迷う場合は
        <Link href="/guide/second-opinion/">セカンドオピニオン</Link>
        で、抜歯・非抜歯それぞれの治療ゴールを比較してください。
      </p>
    </ArticleLayout>
  );
}
