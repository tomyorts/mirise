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
- 記事25本の**監修前ドラフト**(難症例・外科矯正12/意思決定ガイド7/治療法3/FAQ3。90日計画の記事をすべて網羅)
- 3分セルフチェック(/check/): 状況に応じて推奨記事と相談導線を出し分けるCVツール
- 矯正用語集(/glossary/): 30語をAI引用最適化(定義文先頭)で解説+DefinedTermSet構造化データ
- カウンセリング準備チェックリスト(/guide/counseling-checklist/): 印刷可能なリード獲得ツール
- 監修者E-E-A-Tプロフィール(/about/authors/): Physician構造化データを実体化
- 透明性ページ(運営者情報・編集ポリシー ※原本は docs/media/03)
- 相談導線2種(オンラインSO・難症例相談。限定解除4要件を意識した構成)
- 記事テンプレート: 執筆/監修表示、公開日・更新日、リード要約、FAQ、参考文献、固定CTA
- JSON-LD: MedicalWebPage / FAQPage / Physician / MedicalClinic / Organization / MedicalCondition / speakable
- 関連記事による回遊、OGP/canonical(lib/metadata.ts)、llms.txt
- 自由診療の定型ブロック(DisclosureBlock)
- OGP画像の自動生成(全ページ+記事別の日本語カード。`lib/og.tsx`+各`opengraph-image.tsx`)
- GA4計測基盤+CV相談導線(`lib/analytics.ts` / `components/Analytics.tsx` ほか。docs/media/08)

### OGP画像について
`next/og`で日本語カードを静的生成する。日本語フォントは`assets/fonts/ipagp-og.ttf`
(IPAゴシックのサブセット。ライセンスは同ディレクトリ)。
記事タイトルを変更・追加したら次を実行して再生成する:

```bash
python3 scripts/subset-og-font.py   # 新しい漢字が増えた場合のみ(IPAフォントが必要)
python3 scripts/gen-og-routes.py    # 記事別 opengraph-image.tsx を再生成
```

`npm run build`の後処理(`scripts/fix-og-extensions.mjs`)で、拡張子なしの
OGP画像を`.png`にリネームしHTML参照も書き換える(Apache/WordPress配信対応)。

## 公開前に必須の作業(このままでは公開しない)

1. **全記事の歯科医師監修**(本文中の「要確認」マーカーの確定)と docs/media/04 のコンプラチェック
   → 確認すべき箇所は **[docs/media/10_supervision_checklist.md](../../docs/media/10_supervision_checklist.md)**(33件/16記事)に記事別で一覧化済み
2. ~~`lib/site.ts` / `lib/authors.ts` の実名・住所・電話・ドメインの確定~~ ✅ 確定済
   (ドメイン: mirise-ortho.com のサブディレクトリ `/media/`。監修者: 富田大介 院長。
   住所・電話・略歴は staff ページより反映。※公開時に本人最終確認)
3. `app/layout.tsx` の `robots: noindex` の解除(監修・コンプラ完了後のみ)
4. 相談フォーム実装+GA4計測(docs/media/08 の仕様)
5. **既存WordPress(mirise-ortho.com)への設置**: `npm run build` の `out/` を
   ドキュメントルート直下の `media/` フォルダへアップロード(basePath `/media` 済)。
   ルート `robots.txt` に `Sitemap: .../media/sitemap.xml` を追記し `/media/` を塞がないこと。

記事の `reviewStatus` が `published` 以外の場合、ページ上部にドラフトバナーが表示される。
監修・コンプラ完了ごとに `lib/articles.ts` のステータスを更新すること。
