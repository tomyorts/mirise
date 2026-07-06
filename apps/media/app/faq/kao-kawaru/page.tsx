import type { Metadata } from 'next';
import Link from 'next/link';
import ArticleLayout from '@/components/ArticleLayout';
import { getArticle } from '@/lib/articles';

const meta = getArticle('faq', 'kao-kawaru')!;

export const metadata: Metadata = { title: meta.title, description: meta.summary };

export default function Page() {
  return (
    <ArticleLayout meta={meta}>
      <h2>答え:変わるのは「口元」、変わらないのは「骨格」です</h2>
      <p>
        矯正治療で移動できるのは歯であり、変化が現れるのは主に唇の周囲(口元)です。特に前歯を後方に移動する治療(抜歯を伴うことが多い)では、口元の突出感が減り、横顔の印象が変わる場合があります。
      </p>
      <ul>
        <li>
          <strong>変わり得るもの</strong>: 口元の突出感、唇の閉じやすさ、笑ったときの歯の見え方
        </li>
        <li>
          <strong>矯正では変わらないもの</strong>: 輪郭、エラ、鼻の形、顎の骨格そのもの
        </li>
      </ul>
      <p>
        骨格に由来する顔貌の変化(受け口・顎のゆがみ・ガミースマイルの一部など)を目的とする場合は、
        <Link href="/jaw-surgery/">外科手術を併用する治療</Link>の領域です。
      </p>

      <h2>治療前に確認すべきこと</h2>
      <ul>
        <li>自分の治療計画で、口元がどの方向にどの程度変化する見込みか</li>
        <li>変化の予測(シミュレーション)は歯の移動に基づくものか、軟組織の変化まで含むか。軟組織の変化予測には限界があること</li>
        <li>「小顔になる」「輪郭が変わる」といった説明があった場合、その根拠</li>
      </ul>
      <p>
        顔の変化は矯正の目的にも不安にもなり得ます。期待と結果の齟齬を防ぐには、
        <strong>変わる範囲・変わらない範囲を治療前に言語化しておく</strong>ことが最も有効です。
      </p>
    </ArticleLayout>
  );
}
