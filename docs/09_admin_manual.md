# 09 管理者マニュアル（MIRISE Intercom）

システム管理者向けの詳細マニュアルです。アカウント・パスワード・ルーム・スタッフの管理、
構成要素、トラブル対応、セキュリティ方針をまとめています。

---

## 1. システム構成（全体像）

```
スタッフのスマホ/PC ──HTTPS──▶ Webアプリ (Vercel: mirisevoicelink.vercel.app)
                                   │  Next.js / ログイン / 管理画面 / トークン発行API
                                   ├──wss──▶ LiveKit Cloud（音声のリアルタイム中継）
                                   └──REST─▶ Upstash Redis（ルーム・スタッフ設定の保存）
コード管理: GitHub (tomyorts/mirise) — main ブランチが本番。mainに入ると自動デプロイ
```

| 役割 | サービス | 管理画面URL |
|---|---|---|
| アプリ本体・公開 | Vercel（プロジェクト `mirisevoicelink`） | https://vercel.com |
| 音声中継（SFU） | LiveKit Cloud | https://cloud.livekit.io |
| 設定データ保存 | Upstash Redis（`mirise`・東京） | https://console.upstash.com |
| ソースコード | GitHub `tomyorts/mirise` | https://github.com |

---

## 2. アカウントと権限

ログインは**共通パスワード方式**（2種類）:

| 種別 | 環境変数 | できること |
|---|---|---|
| スタッフ | `CLINIC_PASSWORD` | インカムの利用 |
| 管理者 | `ADMIN_PASSWORD` | インカム利用 ＋ **管理画面(/admin)** |

- セッションは署名付きCookieで**12時間**有効
- 将来、個人別ログインに移行できる設計になっています（コード側は差し替え可能）

### パスワードの変更方法
1. Vercel → プロジェクト → **Settings → Environment Variables**
2. `CLINIC_PASSWORD` または `ADMIN_PASSWORD` の値を編集 → Save
3. 保存すると自動で再デプロイされ、新パスワードが有効になります
4. **退職者が出たら共通パスワードを変更**するのが運用ルールです

---

## 3. 管理画面の使い方（/admin）

1. アプリに **`ADMIN_PASSWORD`** でログイン
2. 右上の**「管理画面」**リンク → `https://mirisevoicelink.vercel.app/admin`

### 3-1. ルームの編集
- **ルーム名（表示名）**: 全員のアプリに表示される名前（例: 「診療室」→「2F診療室」）
- **説明**: ボタン長押しで出るヒント（任意）
- **ID**: 内部識別子（英数字・ハイフン・アンダースコア）。**通常は変更しない**
  - 緊急全体呼び出しは ID `all` のルームに切り替わる仕様。**`all` は残す**こと
- 「＋ルームを追加」「削除」で増減可能（1〜50件）
- **「保存する」**で即時反映（スタッフはページ再読み込みで新ルームが見えます）

### 3-2. スタッフの登録（CSV取り込み）
- 形式: **1行に「名前,職種」**（職種は省略可・UTF-8）

  ```csv
  名前,職種
  佐藤,歯科医師
  田中,歯科衛生士
  鈴木,受付
  ```

- ヘッダー行（名前/氏名/name等）は自動でスキップされます
- ファイル選択 or テキスト貼り付け →「CSVを読み込む」→ 内容確認 →**「保存する」**
- 登録したスタッフ名は、インカムの名前入力欄で**候補表示**されます
- ⚠️ CSV取り込みは**全置き換え**です（追記ではありません）。現名簿に追加したい場合は、全員分を含むCSVを取り込んでください

### 3-3. 「保存先データベースが未設定です」と出る場合
Upstash Redis の環境変数が未設定です。→ §4 参照

---

## 4. 環境変数一覧（Vercel → Settings → Environment Variables）

| 変数名 | 用途 | 秘密度 |
|---|---|---|
| `NEXT_PUBLIC_LIVEKIT_URL` | LiveKit CloudのURL（`wss://〜.livekit.cloud`） | 公開可 |
| `LIVEKIT_API_KEY` | LiveKit APIキー | 🔒 |
| `LIVEKIT_API_SECRET` | LiveKit APIシークレット | 🔒🔒 |
| `CLINIC_PASSWORD` | スタッフ共通パスワード | 🔒 |
| `ADMIN_PASSWORD` | 管理者パスワード | 🔒🔒 |
| `AUTH_SECRET` | ログインCookieの署名鍵（長いランダム文字列） | 🔒🔒 |
| `UPSTASH_REDIS_REST_URL` | 設定保存DBのURL | 🔒 |
| `UPSTASH_REDIS_REST_TOKEN` | 設定保存DBのトークン | 🔒🔒 |
| `INTERCOM_API_KEY`（任意） | ネイティブアプリ用のトークンAPIキー | 🔒🔒 |

- 変更・追加したら**自動再デプロイ**で反映（数分）
- 🔒の値はスクリーンショット・チャット・メールに**絶対に貼らない**

---

## 5. 日常運用・監視

- **料金**: Vercel(Hobby)・LiveKit Cloud(Free)・Upstash(Free)の無料枠で運用中
  - LiveKit Cloud無料枠の目安を超える利用（大人数・長時間常用）になったら有料プラン検討
- **利用状況**: LiveKit Cloudのダッシュボードで同時接続・分数を確認できます
- **デプロイ履歴**: Vercel → Deployments。異常時は直前の正常版に「⋯ → Promote to Production」で即ロールバック可能

---

## 6. トラブルシューティング（管理者向け）

| 症状 | 原因の目安 | 対処 |
|---|---|---|
| 全員つながらない | LiveKit Cloud障害 or 環境変数変更ミス | Vercelのデプロイ状況・LiveKitステータスを確認。直前の変更をロールバック |
| ログイン画面が出ない/403 | Vercel Deployment ProtectionがON | Settings → Deployment Protection → Vercel Authentication をOFF |
| 「サーバー設定が未完了」 | `AUTH_SECRET`等の環境変数漏れ | §4の一覧と照合して追加 → 再デプロイ |
| 管理画面で保存できない | Upstash未設定/トークン誤り | `UPSTASH_REDIS_REST_URL/TOKEN` を確認 |
| 特定の人だけ声が出ない | 端末のマイク許可/イヤホン相性 | ブラウザのマイク許可、通話対応イヤホンか確認 |
| 音が途切れる | Wi-Fi品質 | アクセスポイントの位置・チャンネル・帯域を確認（docs/03参照） |

---

## 7. セキュリティ・プライバシー方針（要点）

- 会話に**患者情報を乗せない**運用（チェア番号・セット名で会話）
- **録音・文字起こし機能なし**（実装しない方針）
- 音声はLiveKit経由で**暗号化(WSS/SRTP)**して転送。サーバーに保存されない
- `LIVEKIT_API_SECRET` はサーバー側のみ。クライアントに露出しないことを確認済み
- 端末紛失時: 共通パスワードを変更すれば以後その端末からは接続不可
- 詳細は `docs/04_security_privacy_medical.md` を参照

---

## 8. 今後のロードマップ（現状メモ）

- ✅ Web版: ログイン・管理画面・PTT改良まで完了
- 🔄 **ネイティブアプリ（iOS）**: Expoで開発中
  - Phase 1（iPhoneで起動）完了 / Phase 2（音声）コード準備済み
  - Apple Developer Programの有効化待ち → 有効化後 `npx eas-cli build --profile development --platform ios`
  - ネイティブ版はバックグラウンド動作・ハードボタンPTT対応が目標
- ⬜ 個別ログインへの移行、施設別ルーム、全院展開（docs/05参照）
