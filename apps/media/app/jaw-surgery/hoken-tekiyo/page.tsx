import Link from 'next/link';
import ArticleLayout from '@/components/ArticleLayout';
import { getArticle } from '@/lib/articles';
import { articleMetadata } from '@/lib/metadata';
import { reviewValue } from '@/content/review';

const meta = getArticle('jaw-surgery', 'hoken-tekiyo')!;

export const metadata = articleMetadata(meta);

// ドラフト。数値・条件はすべて監修時に確定する(<要確認>マーカー)。
export default function Page() {
  return (
    <ArticleLayout meta={meta}>
      <h2 id="teigi">顎変形症とは:骨格のずれによる噛み合わせと顔貌の問題</h2>
      <p>
        顎変形症とは、上顎または下顎の骨格的な位置・大きさのずれにより、噛み合わせの機能と顔貌のバランスに問題が生じている状態を指します。代表的なものに、下顎が前に出ている骨格性下顎前突(受け口)、上顎が前に出ている骨格性上顎前突、上下の顎が左右にずれている顔面非対称、前歯が噛み合わない開咬があります。
      </p>
      <p>
        歯の位置だけの問題(歯性)であれば矯正治療単独が選択肢になりますが、骨格のずれが大きい場合(骨格性)は、矯正治療と顎の外科手術を組み合わせる「外科的矯正治療(外科矯正)」が標準的な治療になります。
      </p>

      <h2 id="joken">健康保険が適用される3つの条件</h2>
      <p>顎変形症の治療に健康保険が適用されるのは、次の条件をすべて満たす場合です。</p>
      <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>条件</th>
            <th>内容</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>1. 診断</td>
            <td>顎変形症(顎離断等の手術を必要とするもの)と診断されていること</td>
          </tr>
          <tr>
            <td>2. 医療機関</td>
            <td>
              顎口腔機能診断施設として指定された医療機関で矯正治療を行うこと(どの矯正歯科でも保険が使えるわけではありません)
            </td>
          </tr>
          <tr>
            <td>3. 治療計画</td>
            <td>顎の外科手術を治療計画に含むこと(手術をしない矯正単独の治療は対象外)</td>
          </tr>
        </tbody>
      </table>
      </div>
      <p>
        重要なのは、<strong>症状が同じでも、治療計画によって保険適用かどうかが変わる</strong>
        ことです。骨格性のずれがあっても、手術を行わず<Link href="/glossary/#camouflage">カモフラージュ矯正</Link>(歯の移動のみで見た目を補正する治療)を選ぶ場合、その治療は自由診療になります。
      </p>
      <figure className="article-fig">
        <svg viewBox="0 0 620 470" role="img" aria-label="健康保険が適用されるかどうかの判定フロー" style={{ minWidth: '540px' }}>
          <defs>
            <marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="var(--ink-soft)" />
            </marker>
          </defs>
          {/* メインの流れ */}
          <rect x="30" y="16" width="330" height="52" rx="8" fill="var(--paper)" stroke="var(--line-strong)" />
          <text x="195" y="38" textAnchor="middle" fontSize="14" fill="var(--ink)">骨格のずれを指摘された</text>
          <text x="195" y="57" textAnchor="middle" fontSize="12" fill="var(--ink-soft)">精密検査・セファロ分析を受ける</text>
          <line x1="195" y1="68" x2="195" y2="96" stroke="var(--ink-soft)" markerEnd="url(#ar)" />
          <rect x="30" y="100" width="330" height="52" rx="8" fill="var(--accent-soft)" stroke="var(--accent-line)" />
          <text x="195" y="124" textAnchor="middle" fontSize="14" fill="var(--ink)">条件1「顎変形症」と診断された?</text>
          <line x1="195" y1="152" x2="195" y2="192" stroke="var(--ink-soft)" markerEnd="url(#ar)" />
          <text x="205" y="177" fontSize="12" fill="var(--accent)">はい</text>
          <rect x="30" y="196" width="330" height="52" rx="8" fill="var(--accent-soft)" stroke="var(--accent-line)" />
          <text x="195" y="220" textAnchor="middle" fontSize="14" fill="var(--ink)">条件2 外科手術を含む治療計画?</text>
          <line x1="195" y1="248" x2="195" y2="288" stroke="var(--ink-soft)" markerEnd="url(#ar)" />
          <text x="205" y="273" fontSize="12" fill="var(--accent)">はい</text>
          <rect x="30" y="292" width="330" height="52" rx="8" fill="var(--accent-soft)" stroke="var(--accent-line)" />
          <text x="195" y="311" textAnchor="middle" fontSize="14" fill="var(--ink)">条件3 指定医療機関で治療する?</text>
          <text x="195" y="330" textAnchor="middle" fontSize="12" fill="var(--ink-soft)">(顎口腔機能診断施設)</text>
          <line x1="195" y1="344" x2="195" y2="384" stroke="var(--ink-soft)" markerEnd="url(#ar)" />
          <text x="205" y="369" fontSize="12" fill="var(--accent)">はい</text>
          <rect x="30" y="388" width="330" height="60" rx="8" fill="var(--accent)" />
          <text x="195" y="413" textAnchor="middle" fontSize="15" fontWeight="bold" fill="#ffffff">健康保険が適用</text>
          <text x="195" y="434" textAnchor="middle" fontSize="12" fill="#ffffff">自己負担3割・高額療養費制度の対象</text>
          {/* いいえ の分岐 */}
          <rect x="430" y="196" width="170" height="72" rx="8" fill="var(--warn-bg)" stroke="var(--warn-line)" />
          <text x="515" y="226" textAnchor="middle" fontSize="14" fill="var(--warn-ink)">自由診療</text>
          <text x="515" y="247" textAnchor="middle" fontSize="12" fill="var(--warn-ink)">(全額自己負担)</text>
          <polyline points="360,126 515,126 515,192" fill="none" stroke="var(--ink-soft)" strokeDasharray="4 3" markerEnd="url(#ar)" />
          <text x="368" y="120" fontSize="12" fill="var(--ink-soft)">いいえ</text>
          <line x1="360" y1="222" x2="426" y2="222" stroke="var(--ink-soft)" strokeDasharray="4 3" markerEnd="url(#ar)" />
          <text x="368" y="216" fontSize="12" fill="var(--ink-soft)">いいえ</text>
          <polyline points="360,318 515,318 515,272" fill="none" stroke="var(--ink-soft)" strokeDasharray="4 3" markerEnd="url(#ar)" />
          <text x="368" y="312" fontSize="12" fill="var(--ink-soft)">いいえ</text>
        </svg>
        <figcaption>
          保険適用の判定フロー(概要)。3つの条件をすべて満たす場合に健康保険が適用されます。実際の適用可否は指定医療機関での診断により決まります。
        </figcaption>
      </figure>

      <h2 id="tekiyogai">保険が適用されないケース</h2>
      <ul>
        <li>外科手術を行わない矯正単独の治療(カモフラージュ矯正を含む)</li>
        <li>指定医療機関以外での矯正治療</li>
        <li>
          マウスピース型カスタムメイド矯正装置による治療(保険診療で使用できる装置の要件を満たさないため。保険での術前・術後矯正は原則としてマルチブラケット装置で行います)
        </li>
        <li>美容目的のみの顎の手術</li>
      </ul>

      <h2 id="hiyou">自己負担の目安と高額療養費制度</h2>
      <p>
        保険適用(3割負担)の場合、術前矯正・手術・入院・術後矯正を合わせた自己負担の総額は、おおむね
        <strong>{reviewValue('hoken-tekiyo', 'hokenGaku')}</strong>
        が目安です。手術と入院の費用は<Link href="/guide/kougaku-ryouyouhi/">高額療養費制度</Link>の対象となるため、所得区分によっては手術月の自己負担がさらに軽減されます。対象範囲と手続きは同記事で詳しく解説しています。
      </p>
      <p>
        自由診療で外科矯正に相当する治療を行った場合の総額(矯正費用+手術費用)と比べると、負担額には大きな差が生じます。骨格性の問題を指摘された方は、
        <strong>治療を契約する前に</strong>
        、保険適用の可能性について指定医療機関で診断を受けることをおすすめします。
      </p>

      <h2 id="sagashikata">指定医療機関(顎口腔機能診断施設)の探し方</h2>
      <p>
        保険適用の条件のうち、自分で調べて確認できるのが「指定医療機関かどうか」です。<Link href="/glossary/#shitei-shisetsu">顎口腔機能診断施設</Link>の指定を受けているかは、次の方法で確認できます。
      </p>
      <ul>
        <li>
          <strong>医院に直接聞く</strong>
          :「顎口腔機能診断施設の指定を受けていますか」と電話やメールで確認して問題ありません。保険での外科矯正を扱う医院であれば、日常的に受けている質問です。
        </li>
        <li>
          <strong>学会・公的機関の一覧で調べる</strong>
          :関連学会が指定医療機関の一覧を公開しているほか、施設基準の届出状況は地方厚生局の公表資料でも確認できます。
        </li>
        <li>
          <strong>大学病院の矯正歯科</strong>
          :多くの大学病院の矯正歯科は指定を受けており、口腔外科との連携体制も院内で完結しやすいという特徴があります。通院距離と通院頻度(術前矯正中は月1回程度の通院が続きます)も合わせて検討してください。
        </li>
      </ul>
      <p>
        なお、指定を受けていない医院で相談した場合でも、顎変形症の疑いがあれば指定医療機関を紹介してもらえることがあります。
        <strong>契約前に「この治療計画は保険適用になるか」を文書で確認する</strong>
        ことが、あとから費用区分の認識違いに気づく事態を防ぎます。
      </p>

      <h2 id="nagare">相談から治療開始までの流れ</h2>
      <ol>
        <li>指定医療機関(顎口腔機能診断施設)で検査・診断を受ける</li>
        <li>顎変形症の診断と、手術を含む治療計画の説明を受ける</li>
        <li>連携する口腔外科(手術を行う病院)との治療計画のすり合わせ</li>
        <li>術前矯正(おおむね1〜2年)→ 入院・手術(1〜2週間程度)→ 術後矯正(おおむね半年〜1年)</li>
      </ol>
      <p>{reviewValue('hoken-tekiyo', 'kikan')}</p>
    </ArticleLayout>
  );
}
