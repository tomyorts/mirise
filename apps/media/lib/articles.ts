import type { ReviewStatus } from './site';

export type FaqItem = { question: string; answer: string };

export type Reference = { name: string; url?: string; note?: string };

export type ArticleMeta = {
  slug: string; // カテゴリ配下のパス
  category: 'guide' | 'jaw-surgery' | 'treatment' | 'faq';
  title: string; // H1 = 質問文または結論文(docs/media/06)
  summary: string; // リード要約(AI引用ターゲット。3〜5行)
  authorId: string;
  reviewerId: string;
  publishedAt: string; // ISO date
  updatedAt: string;
  updateNote?: string;
  reviewStatus: ReviewStatus;
  hasPaidTreatmentBlock: boolean; // 自由診療定型ブロックの要否(docs/media/04 チェックB)
  faq: FaqItem[];
  references: Reference[];
};

// 記事レジストリ。本文は app/<category>/<slug>/page.tsx に置く。
// reviewStatus が 'published' 以外の記事は、本番ビルドでドラフトバナーを表示する。
export const ARTICLES: ArticleMeta[] = [
  {
    slug: 'hoken-tekiyo',
    category: 'jaw-surgery',
    title: '顎変形症の手術に健康保険は使えるか:適用条件の完全ガイド',
    summary:
      '顎変形症と診断され、指定された医療機関で外科手術を前提とした矯正治療を行う場合、健康保険が適用されます。適用には「顎変形症の診断」「顎口腔機能診断施設等の指定医療機関での治療」「外科手術を治療計画に含むこと」という条件があり、マウスピース型装置単独の治療は対象外です。この記事では、保険が適用される条件・適用されないケース・自己負担の目安を整理します。',
    authorId: 'director',
    reviewerId: 'director',
    publishedAt: '2026-08-01',
    updatedAt: '2026-08-01',
    reviewStatus: 'draft',
    hasPaidTreatmentBlock: false,
    faq: [
      {
        question: '顎変形症なら必ず保険で矯正できますか?',
        answer:
          'いいえ。顎変形症の診断に加えて、外科手術を前提とした治療計画であること、指定医療機関(顎口腔機能診断施設等)で治療することが条件です。手術をしない矯正単独の治療は、症状が同じでも自由診療になります。',
      },
      {
        question: '保険適用の場合、自己負担はどのくらいですか?',
        answer:
          '3割負担の場合、矯正治療と手術・入院を合わせた自己負担はおおむね数十万円台が目安です。高額療養費制度の対象となるため、所得区分によっては手術月の負担がさらに軽減されます。正確な金額は治療計画によって異なるため、指定医療機関での診断時に確認してください。',
      },
      {
        question: 'マウスピース矯正でも保険は使えますか?',
        answer:
          '顎変形症の保険診療では、使用できる装置に要件があり、マウスピース型カスタムメイド矯正装置による治療は保険適用外です。保険での治療は原則としてマルチブラケット装置(ワイヤー矯正)で行われます。',
      },
    ],
    references: [
      { name: '日本矯正歯科学会 顎変形症に関する情報', note: '参照日を記載して確定する' },
      { name: '厚生労働省 診療報酬点数表(歯科矯正診断料・顎口腔機能診断料)', note: '最新年度版を確認' },
    ],
  },
  {
    slug: 'surgery-first',
    category: 'jaw-surgery',
    title: 'サージェリーファーストの適応と限界:向いている人・向いていない人',
    summary:
      'サージェリーファーストは、通常1〜2年かかる術前矯正を省略または大幅に短縮し、先に顎の手術を行う外科矯正の治療法です。治療期間の短縮と、見た目の改善が早く得られることが利点ですが、適応できる症例には条件があり、術後の歯の移動計画の精度が従来法以上に重要になります。この記事では、適応条件・利点・限界・従来法との選び分けを専門医の視点で解説します。',
    authorId: 'director',
    reviewerId: 'director',
    publishedAt: '2026-08-01',
    updatedAt: '2026-08-01',
    reviewStatus: 'draft',
    hasPaidTreatmentBlock: true,
    faq: [
      {
        question: 'サージェリーファーストは誰でも受けられますか?',
        answer:
          'いいえ。歯列の状態・骨格のずれの方向と量・咬合の安定性などの条件により、適応が判断されます。術前矯正で歯の位置をある程度整えてからでないと手術後の噛み合わせが安定しない症例では、従来法が選択されます。',
      },
      {
        question: '治療期間はどのくらい短くなりますか?',
        answer:
          '従来法の全体期間がおおむね2〜3年であるのに対し、サージェリーファーストでは術前矯正を省略・短縮するぶん、全体期間が短くなる場合があります。短縮幅は症例により異なり、術後の矯正が長引くケースもあるため、「必ず半分になる」といった保証はできません。',
      },
      {
        question: 'サージェリーファーストは保険が使えますか?',
        answer:
          '顎変形症として保険診療の要件を満たす場合は保険適用の対象になり得ますが、医療機関の指定や使用装置の要件があります。美容目的の手術や、要件を満たさない治療計画は自由診療です。診断時に治療計画と費用区分を必ず確認してください。',
      },
    ],
    references: [
      { name: '日本顎変形症学会 関連ガイドライン', note: '参照文献を監修時に確定' },
      { name: 'サージェリーファーストに関する系統的レビュー', note: '引用論文を監修時に確定' },
    ],
  },
  {
    slug: 'second-opinion',
    category: 'guide',
    title: '矯正のセカンドオピニオンの受け方:失礼にならない切り出し方と準備',
    summary:
      '矯正治療のセカンドオピニオンは、患者の正当な権利であり、主治医に伝えることは失礼にはあたりません。特に、抜歯の要否・外科手術の要否・治療のやり直しといった不可逆な判断の前には、別の専門医の意見を聞く価値があります。この記事では、主治医への切り出し方、持参すべき資料、セカンドオピニオン先で聞くべきことを、準備シート付きで解説します。',
    authorId: 'director',
    reviewerId: 'director',
    publishedAt: '2026-08-01',
    updatedAt: '2026-08-01',
    reviewStatus: 'draft',
    hasPaidTreatmentBlock: false,
    faq: [
      {
        question: 'セカンドオピニオンを主治医に言い出しにくいのですが。',
        answer:
          '「治療方針を理解して納得したいので、別の先生の意見も聞いてみたい」と伝えれば十分です。セカンドオピニオンは医療において確立した仕組みであり、誠実な医師であれば資料の提供に応じます。言い出したことで不利益な扱いを受けるようであれば、それ自体が転院を検討する材料になります。',
      },
      {
        question: '何を持って行けばいいですか?',
        answer:
          '検査資料(レントゲン・セファロ・歯型または口腔内スキャンデータ)、治療計画書、これまでの経過が分かる資料が基本です。資料がない場合でも相談は可能ですが、再検査が必要になることがあります。',
      },
      {
        question: 'セカンドオピニオンは保険が使えますか?',
        answer:
          'セカンドオピニオンは一般に自由診療(自費)で、医療機関ごとに料金が設定されています。相談先に事前に費用と所要時間を確認してください。',
      },
    ],
    references: [
      { name: '厚生労働省 上手な医療のかかり方(セカンドオピニオン)', note: 'URL確定' },
    ],
  },
];

export function getArticle(category: string, slug: string): ArticleMeta | undefined {
  return ARTICLES.find((a) => a.category === category && a.slug === slug);
}

export function articlePath(a: ArticleMeta): string {
  return `/${a.category}/${a.slug}/`;
}

export const CATEGORY_LABEL: Record<ArticleMeta['category'], string> = {
  guide: '意思決定ガイド',
  'jaw-surgery': '難症例・外科矯正',
  treatment: '治療法を正しく理解する',
  faq: 'よくある誤解と不安',
};
