# 11 スタッフのiPhoneへの配布手順（TestFlight）

スタッフ私物のiPhoneにアプリを入れる手順です。Appleの **TestFlight** を使うと、
スタッフは招待リンクを開いてインストールするだけで使えます（App Storeの公開審査より簡単）。

---

## 0. 事前に必要なもの

| もの | 状態 |
|---|---|
| Apple Developer Program（組織または個人） | 登録済みであること（年額 約1.3万円） |
| Expo アカウント（無料） | https://expo.dev で作成。クラウドでアプリを組み立てる（ビルド）ために使う |
| PC版の本番反映 | PR #7 が main に取り込まれていること（アプリの「端末登録」が本番サーバーの新機能を使うため） |
| 医院の共通パスワード | スタッフがアプリを最初に開いた時に入力する（PC版のログインと同じ） |

> ⚠️ `apps/mobile/.env` に `EXPO_PUBLIC_INTERCOM_KEY` が書かれている場合は、配布ビルドの前に削除してください。
> 残っていると、配布ビルドは安全のため自動で止まります（院外に渡ると誰でもサーバーを使えてしまうため）。

---

## 1. ビルドの準備（Macのターミナル・初回のみ）

```
npm install -g eas-cli
eas login
cd mirise/apps/mobile
eas init
```

- `eas login` は Expo アカウントでログインします
- `eas init` はこのアプリを Expo アカウントに登録します（app.json に projectId が追加されます。追加された内容はコミットしてください）

---

## 2. 配布用にビルドする

```
eas build --platform ios --profile production
```

途中で次のことを聞かれます。基本はすべて「Yes（おまかせ）」で大丈夫です。

- **Apple アカウントでのログイン** → Apple Developer Program に登録したアカウント
- **証明書・プロビジョニングプロファイルを作成するか** → Yes（EASが自動で作ります）
- **Push Notifications / Push to Talk などの機能を有効にするか** → Yes

ビルドはクラウドで行われ、20〜40分ほどかかります。終わるとURLが表示されます。

> もし「Push to Talk の機能が無い」というエラーが出たら、
> developer.apple.com → Certificates, IDs & Profiles → Identifiers →
> `jp.co.medident.mirailink` を開き、**Push to Talk** にチェックを入れて保存してから、もう一度ビルドしてください。

---

## 3. App Store Connect に送る（TestFlightへ）

```
eas submit --platform ios --latest
```

- 初回は App Store Connect にアプリの登録を自動で作ります（アプリ名: MIRAI LINK）
- 送信後、Apple側の処理に10〜30分ほどかかります

---

## 4. スタッフを招待する

App Store Connect（https://appstoreconnect.apple.com）→ アプリ → **TestFlight** タブ:

**おすすめ：外部テスト（公開リンク）**
1. 「外部テスト」の ＋ でグループを作る（例: スタッフ）
2. ビルドを追加 → 「テスト内容」に「院内インカムの動作確認」などを記入 → 審査へ提出
   （初回だけAppleの簡単な審査があり、通常1日以内）
3. 承認されたら **「公開リンク」を有効にする** → そのリンクをスタッフに送る

**スタッフ側の手順**
1. App Storeで **TestFlight** アプリを入れる
2. 送られた公開リンクを開く →「インストール」
3. MIRAI LINK を開き、医院のパスワードを入力 → 名前とルームを入れて「出勤する」

> TestFlightのビルドは **90日で期限切れ** になります。期限前に手順2〜3で新しいビルドを送れば、
> スタッフのアプリは自動で更新されます。長期運用では App Store 公開（または非公開配布）に切り替えます。

---

## 5. 端末を無効にしたい時（紛失・退職）

- PC版の管理者設定（Vercel の環境変数）で **医院の共通パスワード（CLINIC_PASSWORD）を変更** すると、
  すべての端末の登録が無効になります
- 残るスタッフには新しいパスワードを伝え、アプリで再登録してもらいます

---

## 6. 全員が新しいアプリになったら

旧方式の共通キーを無効にします。Vercel の環境変数 **INTERCOM_API_KEY を削除** して再デプロイしてください。
