# キョウセイの前に — メディアMVPサイト

矯正治療の意思決定支援メディア「キョウセイの前に」のMVP実装。
設計・運用の原本は [docs/media/](../../docs/media/README.md) を参照(特に 02: 情報設計、04: コンプラ運用)。

## 起動

```bash
cd apps/media
npm install
npm run dev   # http://localhost:3100
npm run build # 静的エクスポート(out/)
```

## 実装済み

- トップ(意思決定の入口)、カテゴリ一覧(guide / jaw-surgery / faq)
- 柱記事3本の**監修前ドラフト**(顎変形症の保険適用/サージェリーファースト/セカンドオピニオンの受け方)
- 透明性ページ(運営者情報・編集ポリシー ※原本は docs/media/03)
- 相談導線2種(オンラインSO・難症例相談。限定解除4要件を意識した構成)
- 記事テンプレート: 執筆/監修表示、公開日・更新日、リード要約、FAQ、参考文献、固定CTA
- JSON-LD: MedicalWebPage / FAQPage / Physician / MedicalClinic / Organization
- 自由診療の定型ブロック(DisclosureBlock)

## 公開前に必須の作業(このままでは公開しない)

1. **全記事の歯科医師監修**(本文中の「要確認」マーカーの確定)と docs/media/04 のコンプラチェック
2. `lib/site.ts` / `lib/authors.ts` の実名・住所・電話・ドメインの確定
3. `app/layout.tsx` の `robots: noindex` の解除(監修・コンプラ完了後のみ)
4. 相談フォーム実装+GA4計測(docs/media/08 の仕様)
5. Vercelプロジェクトの新規作成(独自ドメイン。mirisevoicelinkとは別プロジェクト)

記事の `reviewStatus` が `published` 以外の場合、ページ上部にドラフトバナーが表示される。
監修・コンプラ完了ごとに `lib/articles.ts` のステータスを更新すること。
