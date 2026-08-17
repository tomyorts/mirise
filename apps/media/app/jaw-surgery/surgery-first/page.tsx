import ArticleLayout from '@/components/ArticleLayout';
import Link from 'next/link';
import DisclosureBlock from '@/components/DisclosureBlock';
import ProcessFlow from '@/components/ProcessFlow';
import { getArticle } from '@/lib/articles';
import { articleMetadata } from '@/lib/metadata';

const meta = getArticle('jaw-surgery', 'surgery-first')!;

export const metadata = articleMetadata(meta);

// ドラフト。適応条件・数値・費用は監修時に確定する。
export default function Page() {
  return (
    <ArticleLayout meta={meta}>
      <h2 id="teigi">サージェリーファーストとは:手術を先に行う外科矯正</h2>
      <p>
        サージェリーファースト(surgery-first
        approach)とは、外科的矯正治療において、通常は手術の前に行う術前矯正(おおむね1〜2年)を省略または大幅に短縮し、先に顎の手術を行う治療法です。手術で骨格のずれを先に解消し、その後の矯正治療で噛み合わせを仕上げます。
      </p>
      <p>
        従来法(オーソドックスアプローチ)では、術前矯正の期間中、手術に向けて歯を並べ直す過程で
        <strong>一時的に見た目や噛み合わせが悪化する</strong>
        ことがあります。サージェリーファーストはこの期間がないため、顔貌の改善が治療の早い段階で得られることが最大の特徴です。
      </p>

      <h2 id="hikaku">従来法との比較</h2>
      <div className="proc-compare">
        <ProcessFlow
          title="従来法(オーソドックス)"
          steps={[
            { label: '術前矯正', note: '手術に向けて歯を並べる(おおむね1〜2年)' },
            { label: '顎矯正手術', note: '骨格のずれを解消' },
            { label: '術後矯正', note: '噛み合わせの仕上げ' },
            { label: '保定', note: '後戻りを抑える' },
          ]}
        />
        <ProcessFlow
          title="サージェリーファースト"
          steps={[
            { label: '顎矯正手術', note: '術前矯正を省略・短縮し先に手術' },
            { label: '術後矯正', note: '噛み合わせを仕上げる' },
            { label: '保定', note: '後戻りを抑える' },
          ]}
        />
      </div>
      <p className="proc-cap" style={{ marginTop: 0 }}>
        治療の順序の違いを示した図です。どちらが適するかは症例の診断により、期間や結果には個人差があります。
      </p>
      <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>項目</th>
            <th>従来法</th>
            <th>サージェリーファースト</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>治療の順序</td>
            <td>術前矯正 → 手術 → 術後矯正</td>
            <td>手術 → 矯正</td>
          </tr>
          <tr>
            <td>全体期間の目安</td>
            <td>2〜3年</td>
            <td>1〜2年程度(症例による)</td>
          </tr>
          <tr>
            <td>見た目の改善時期</td>
            <td>治療後半(手術後)</td>
            <td>治療初期(手術直後)</td>
          </tr>
          <tr>
            <td>治療計画の精度要求</td>
            <td>術前矯正の結果を見て手術計画を調整できる</td>
            <td>
              手術後の歯の移動を最初から正確に予測する必要があり、3Dシミュレーションを含む精密な計画が前提
            </td>
          </tr>
        </tbody>
      </table>
      </div>

      <h2 id="tekio">適応と判断される主な条件</h2>
      <p>サージェリーファーストはすべての顎変形症に適応できるわけではありません。一般に、次のような条件が判断材料になります。</p>
      <ul>
        <li>歯列の叢生(でこぼこ)が比較的軽度で、手術後の歯の移動計画が立てやすいこと</li>
        <li>手術直後の噛み合わせ(術直後咬合)を安定して設定できること</li>
        <li>抜歯を伴う大きな歯の移動を術前に必要としないこと</li>
      </ul>
      <p>(要確認: 適応基準の記述は監修時に自院の診断基準に合わせて確定する)</p>

      <h2 id="genkai">限界とリスク:向いていないケース</h2>
      <ul>
        <li>
          叢生が強い・抜歯が必要など、術前に歯の位置をある程度整えないと手術後の噛み合わせが安定しない症例では、従来法が選択されます
        </li>
        <li>
          手術後の歯の移動が計画どおりに進まない場合、術後矯正が長引き、従来法との期間差が小さくなることがあります
        </li>
        <li>
          外科手術自体のリスク(知覚麻痺・出血・感染・後戻り等)は従来法と共通して存在します
        </li>
      </ul>
      <p>
        「期間が短い」という利点だけで選ぶ治療法ではなく、
        <strong>自分の症例が適応かどうかの診断が先</strong>
        です。適応外の症例に無理に適用すると、結果的に治療期間が延び、噛み合わせの仕上がりが損なわれる可能性があります。
      </p>

      <h2 id="hoken">保険適用との関係</h2>
      <p>
        顎変形症として保険診療の要件(診断・指定医療機関・手術を含む治療計画)を満たす場合、サージェリーファーストも保険適用の対象になり得ます。ただし、医療機関の体制や使用装置の要件によって扱いが異なるため、診断時に治療計画と費用区分を必ず確認してください。詳しくは
        <Link href="/jaw-surgery/hoken-tekiyo/">保険適用の完全ガイド</Link>
        をご覧ください。
      </p>

      <DisclosureBlock
        treatmentName="サージェリーファーストによる外科的矯正治療(自由診療で行う場合)"
        cost="総額 ◯◯◯万円〜◯◯◯万円(検査・診断料、矯正基本料、手術費用を含む。要確認: 監修時にdisclosureマスタの確定値を反映)"
        duration="全体でおおむね1〜2年、通院は月1回程度+手術入院1〜2週間(症例により異なります)"
        insuranceNote="保険診療の要件を満たす場合は保険適用の対象になり得ます。要件を満たさない治療計画は公的医療保険適用外(自由診療)です。"
        risks={[
          '手術に伴う腫れ・出血・感染・オトガイ部などの知覚麻痺(多くは時間とともに軽快しますが、残存する場合があります)',
          '骨格・歯の後戻り、再手術が必要になる可能性',
          '術後矯正期間が計画より延長する可能性',
          '装置装着中の痛み・違和感・むし歯や歯周病リスクの上昇',
        ]}
      />
    </ArticleLayout>
  );
}
