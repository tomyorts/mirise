# 02. サイト情報設計・技術仕様

## 1. URL設計

```
/                             トップ(最新記事ではなく「意思決定の入口」を提示)
/guide/                       意思決定ガイド(柱・常設コンテンツ)
/guide/10-questions/          矯正を始める前の10の質問
/guide/counseling-checklist/  カウンセリングで聞くべきことチェックリスト
/guide/second-opinion/        セカンドオピニオンの受け方
/guide/transfer-and-money/    転院・中断・返金の考え方
/jaw-surgery/                 難症例・外科矯正(差別化の核)
/jaw-surgery/<slug>/          個別記事
/cases/                       症例解説ライブラリ
/cases/<case-id>/             個別症例(限定解除準拠テンプレート)
/treatment/                   治療法を正しく理解する
/treatment/<slug>/
/faq/                         よくある誤解と不安(質問1つ=1ページ)
/faq/<slug>/
/about/                       運営者情報(ミライズ矯正歯科南青山)
/about/editorial-policy/      編集ポリシー
/about/authors/<author-id>/   執筆者・監修者プロフィール
/consult/second-opinion/      オンラインセカンドオピニオン(費用明記)
/consult/complex-cases/       難症例相談(適応条件明記)
```

原則:
- 日付をURLに入れない(更新し続ける常設コンテンツのため)
- カテゴリは上記5つで固定。増やす判断は12か月レビューまで凍結(IAの安定はSEO・GEO両方の資産)
- 1FAQ=1ページ=1つの質問文(AI検索の引用単位に合わせる)

## 2. ページテンプレート仕様

### 2.1 記事テンプレート(共通)

```
[ヘッダー]
  記事タイトル(H1: 質問文または結論文)
  執筆: 氏名(資格) / 監修: 氏名(資格) — 顔写真+プロフィールページへのリンク
  公開日 / 最終更新日(+「更新内容」ポップオーバー)
[リード]
  結論の要約(3〜5行。この記事だけで完結する要約=AI引用のターゲット)
[目次(自動生成)]
[本文]
  H2ごとに「定義 → 条件分岐 → 数字 → 出典」の順(06章参照)
[自由診療ブロック(該当記事のみ・定型)]
  治療名 / 費用総額の目安と内訳 / 標準的な期間・回数 / 公的医療保険適用外である旨 /
  主なリスク・副作用 / 未承認機器を使う場合は所定の記載
[まとめFAQ(3〜5問、FAQPageスキーマ)]
[参考文献]
  学会ガイドライン・論文・公的資料(リンク+参照日)
[監修コメント(任意)]
  監修者の一言(実名で内容に責任を持つ形)
[固定フッターCTA(全記事共通・1か所のみ)]
  「自分の場合はどうか、専門医に確認したい方へ」→ /consult/ へ
```

### 2.2 症例テンプレート(限定解除準拠・全項目必須)

| 項目 | 内容 |
|---|---|
| 主訴・診断名 | 例: 骨格性下顎前突(顎変形症) |
| 患者背景 | 年齢層・性別(個人特定を避ける粒度)、書面同意取得済みの明記 |
| 治療内容 | 術式・装置・抜歯の有無を具体的に |
| 治療期間・通院回数 | 実際の期間と標準的な幅の両方 |
| 費用 | 総額(内訳含む)。保険適用症例は自己負担目安と適用条件 |
| リスク・副作用 | 一般的リスク+この症例で実際に説明したリスク |
| 経過写真 | 撮影条件を揃えた未加工写真。トリミング・明度調整の範囲をキャプションに明記 |
| 医師の考察 | なぜこの術式を選んだかの判断過程(このメディアの核心価値) |

### 2.3 執筆者・監修者ページ

氏名、顔写真、資格・所属学会、経歴、researchmap/学会プロフィール等の外部リンク、
執筆・監修記事一覧、`Physician` スキーマ。**外部プロフィールとの相互リンクがエンティティ確立の要**(06章)。

## 3. 構造化データ仕様(JSON-LD)

全ページ共通で `Organization`(運営者)+ページ種別ごとに以下を出力する。

```json
{
  "@context": "https://schema.org",
  "@type": "MedicalWebPage",
  "headline": "顎変形症の手術に健康保険は使えるか:適用条件の完全ガイド",
  "about": { "@type": "MedicalCondition", "name": "顎変形症" },
  "author": { "@type": "Person", "@id": "https://<domain>/about/authors/<id>/#person" },
  "reviewedBy": {
    "@type": "Physician",
    "name": "<監修者名>",
    "medicalSpecialty": "https://schema.org/Dentistry",
    "worksFor": { "@id": "https://<domain>/about/#clinic" }
  },
  "datePublished": "2026-08-01",
  "dateModified": "2026-08-01",
  "lastReviewed": "2026-08-01",
  "publisher": { "@id": "https://<domain>/about/#organization" },
  "citation": [ { "@type": "CreativeWork", "name": "<学会ガイドライン名>", "url": "..." } ]
}
```

- FAQセクション: `FAQPage`(1ページ内のまとめFAQ)、/faq/ 配下は `Question`/`Answer`
- 運営者ページ: `MedicalClinic`(名称・住所・電話・診療科・地図)— 公式サイトの `MedicalClinic` と `sameAs` で相互参照
- パンくず: `BreadcrumbList` 全ページ

## 4. 技術選定

| 項目 | 推奨 | 理由 |
|---|---|---|
| フレームワーク | Next.js(App Router、SSG+ISR) | 本リポジトリ `apps/web` と同スタックで開発リソースを流用可能。CWV最適化が容易 |
| CMS | ヘッドレスCMS(microCMS または Newt) | 監修ステータス・更新履歴・定型ブロックをモデル化できる。編集部が非エンジニアでも運用可 |
| ホスティング | Vercel | 既存のVercel連携(mirisevoicelink)と同一チームで管理 |
| 分析 | GA4 + Search Console + Looker Studio | 08章の計測仕様に対応 |
| フォーム | 自前実装(相談内容の構造化項目が必要なため) | 08章参照 |

### CMSコンテンツモデル(最低限)

- `article`: title, slug, category, body(リッチテキスト+定型ブロック参照), author, reviewer, reviewStatus(draft/監修済/コンプラ済/公開), publishedAt, updatedAt, updateNote, references[]
- `caseStudy`: 2.2の全項目を個別フィールド化(必須バリデーションで限定解除要件の抜けを構造的に防ぐ)
- `author`: プロフィール項目一式
- `disclosureBlock`(自由診療定型ブロック): 治療名ごとにマスタ管理し記事から参照(費用改定時に一括更新)

**設計思想: 限定解除要件・監修記録をCMSのスキーマとワークフローで強制し、「人の注意力」に依存させない。**

## 5. パフォーマンス・品質基準

- Core Web Vitals: LCP < 2.0s / CLS < 0.1 / INP < 200ms(モバイル実測)
- 画像: AVIF/WebP、症例写真は原寸保存+表示用最適化(改変履歴の保全)
- アクセシビリティ: WCAG 2.1 AA(医療情報の公共性に見合う水準)
- 全ページHTTPS、公開前にステージングでコンプラレビュー(04章のフロー)
