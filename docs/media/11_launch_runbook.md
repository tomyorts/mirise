# 11. 公開当日の段取り書(ローンチ・ランブック)

対象: 「キョウセイの前に」(apps/media)を mirise-ortho.com/media/ へ公開する作業。
登場人物: **先生**(監修者・富田院長)/ **CEO** / **Web担当**(WordPressサーバーを触れる人)/ **Claude**(ビルド・設定変更・検証)。

公開には2つのモードがある。どちらも同じ手順書でカバーする。

- **A. 段階公開**: 監修が終わった記事から1本ずつ公開(記事単位でindex化)。サイトの枠(トップ・カテゴリ)はnoindexのまま
- **B. 全体ローンチ**: サイト全体を公開(「バーンと公開」)。全記事の監修完了が前提

---

## フェーズ0: 公開ブロッカー(これが終わるまで公開しない)

| # | 項目 | 担当 | 状態確認 |
|---|---|---|---|
| 0-1 | 監修チェックリスト34項目の数値確定 | 先生 | チェックリスト(Artifact)の進捗100% |
| 0-2 | 確定数値の反映(content/review.ts) | Claude | 全記事 `publish: true` かつ ◯◯ 残ゼロ |
| 0-3 | 参考文献URLの確定(「監修時にURL確定」の解消) | Claude+先生 | `grep -r "監修時にURL確定" lib/ app/` がゼロ |
| 0-4 | 監修記録(監修者名・確認日)の記録 | CEO | docs/media/07 の運用フローに従う |
| 0-5 | コンプライアンス外部確認(docs/media/04) | CEO | 確認者と日付を記録 |

## フェーズ1: 前日までの準備

1. **公開日付の設定**(Claude): `lib/articles.ts` の `publishedAt` / `updatedAt` を実際の公開日に更新(現在はプレースホルダ日付)
2. **最終ビルドと機械検査**(Claude):
   ```
   npm run build            # check-publish(未確定数値の混入防止)込み
   node scripts/preflight-check.mjs   # リンク切れ・sitemap・OGP・重複
   node scripts/compliance-lint.mjs   # 広告表現の最終スイープ(ヒットは文脈確認)
   ```
3. **目視確認**(CEO): トップ/完全ガイド/保険適用/相談ページ/用語集をスマホとPCで確認
4. **サーバー情報の確認**(Web担当): WordPressサーバーのファイルマネージャまたはFTP接続情報、ドキュメントルートのパスを手元に用意
5. **退避フォルダの用意**(Web担当): 既存の `/media/` フォルダがある場合は `media_bak_YYYYMMDD` にリネームして退避(ロールバック用)

## フェーズ2: 公開スイッチ(Claude)

- **モードA(段階公開)**: 作業不要。`content/review.ts` で `publish: true` にした記事だけが自動で index 化される(それ以外とサイト枠はnoindexのまま)
- **モードB(全体ローンチ)**: `app/layout.tsx` の `robots: noindex` を解除 → トップ・カテゴリ・用語集などの枠ページも index 化される

いずれも変更後に `npm run build` し、フェーズ1-2の機械検査を再実行する。

## フェーズ3: サーバー設置(Web担当、15〜30分)

1. ビルド成果物 `apps/media/out/` の**中身**を、WordPressのドキュメントルート直下の `media/` フォルダへアップロード(`out/index.html` が `/media/index.html` になる配置。basePath `/media` は設定済み)
2. `https://mirise-ortho.com/media/` をブラウザで開き、トップが表示されることを確認
3. ルートの `robots.txt` に次の1行を追記(既にあればスキップ):
   ```
   Sitemap: https://mirise-ortho.com/media/sitemap.xml
   ```
   あわせて `Disallow: /media/` のような記述が**ない**ことを確認
4. WordPress側にパーマリンク `/media/...` を奪う固定ページ・リダイレクトがないことを確認

## フェーズ4: 公開直後の確認(30分以内)

| チェック | 方法 |
|---|---|
| 主要URLが200で表示される | トップ/完全ガイド/保険適用/相談/用語集/sitemap.xml を直接開く |
| 公開記事にドラフトバナーが出ていない | 公開対象記事を目視 |
| 非公開記事が noindex のまま | 該当ページのソースで `noindex` を確認 |
| OGPカード | X(Twitter)のCard Validator等に保険適用記事のURLを入れて画像が出るか |
| スマホ表示 | 実機でトップと記事1本 |

## フェーズ5: 検索エンジン登録(当日〜翌日)

1. Google Search Console にプロパティ(ドメインまたはURLプレフィックス)を登録済みか確認(Web担当)
2. sitemap を送信: `https://mirise-ortho.com/media/sitemap.xml`
3. 柱記事(保険適用・完全ガイド)はURL検査から個別にインデックス登録をリクエスト
4. GA4 の計測確認(docs/media/08 の設定に従う): リアルタイムで自分のアクセスが見えるか

## フェーズ6: 公開後1週間

- Search Console のカバレッジ(インデックス登録状況)とクエリを確認
- 表示崩れ・誤りの報告窓口(問い合わせフォーム)の動作確認
- 反響を見て次の公開記事(段階公開の場合)を決める

## ロールバック手順

問題が起きたら: Web担当が `/media/` を削除し、退避しておいた `media_bak_YYYYMMDD` を `media` に戻す(所要5分)。原因修正後に再アップロードする。

## 更新の運用(公開後)

記事の追加・修正は毎回同じ流れ:
数値確定(先生)→ 反映(Claude)→ `npm run build` + 機械検査 → `out/` を `/media/` に上書きアップロード(Web担当)。
`updatedAt` と更新内容(updateNote)を記録し、記事に最終更新日が表示されることを確認する。
