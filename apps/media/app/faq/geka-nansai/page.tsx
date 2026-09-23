import Link from 'next/link';
import ArticleLayout from '@/components/ArticleLayout';
import { getArticle } from '@/lib/articles';
import { articleMetadata } from '@/lib/metadata';

const meta = getArticle('faq', 'geka-nansai')!;

export const metadata = articleMetadata(meta);

// 監修前ドラフト。
export default function Page() {
  return (
    <ArticleLayout meta={meta}>
      <h2>答え:骨格の成長が終わってから、一般には10代後半以降が目安です</h2>
      <p>
        顎変形症(あごの骨格のずれが原因で、噛み合わせや顔立ちに影響が出ている状態)の手術は、あごの骨の成長が終わってから行うのが原則です。成長が続いている時期に手術をすると、その後の成長によってあごのずれが再び現れることがあるためです。成長の終了時期は一般に10代後半以降とされますが、個人差が大きいため、年齢だけで手術できるかどうかが決まるわけではありません。
      </p>
      <p>
        実際には、手のX線写真(骨の成熟の程度を調べる検査)や、セファロ(頭部X線規格写真)を一定の間隔で撮影して重ね合わせる経年比較などによって、成長が止まったことを確かめてから手術の時期を決めるのが一般的です。
      </p>
      <p>
        一方で、手術が可能になる年齢の前に相談を始める意味はあります。成長の経過観察を早くから始められること、術前矯正を含む治療計画を余裕をもって立てられること、そして骨格性の受け口は成長とともにずれが大きくなる場合があることが理由です。
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>年代</th>
              <th>治療との関わり方</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>小中学生</td>
              <td>成長の経過観察が中心。成長のコントロールを目的とした矯正治療を検討することもあります(適応には個人差があります)</td>
            </tr>
            <tr>
              <td>高校生</td>
              <td>検査で成長の終了を確認しながら、術前矯正を含む治療計画を立てる時期に入ります</td>
            </tr>
            <tr>
              <td>成人</td>
              <td>成長による時期の制約はなく、生活の予定と治療計画に合わせて手術時期を相談しながら決められます</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>確認すべきこと</h2>
      <ul>
        <li>成長の終了をどのような検査で確認するのか(手のX線写真、セファロの経年比較など)</li>
        <li>手術が可能になるまでの間に何をするのか(経過観察の間隔、先に始める治療の有無)</li>
        <li>健康保険での治療を視野に入れる場合、どの医療機関で診断・治療を受けるか</li>
      </ul>
      <p>
        受け口の骨格的な診断がどのように行われるかは
        <Link href="/jaw-surgery/ukeguchi-shindan/">受け口の診断</Link>
        を、術前矯正から手術・術後矯正までの流れは
        <Link href="/jaw-surgery/geka-nagare/">外科矯正の全体像</Link>
        を参照してください。健康保険が適用される条件は
        <Link href="/jaw-surgery/hoken-tekiyo/">保険適用の条件</Link>
        で解説しています。
      </p>
    </ArticleLayout>
  );
}
