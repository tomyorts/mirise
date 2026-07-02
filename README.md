# MIRISE Intercom MVP 開発パッケージ

院内スタッフ向けのWi-Fi/LTE対応インカムを内製するためのMVPパッケージです。
BONXのような体験を目指しますが、最初の開発対象は専用ハードではなく、スマホとBluetoothイヤホンを使った音声インカムです。

## このパッケージの中身

- docs/00_executive_summary.md
  - 経営判断用の要約
- docs/01_product_requirements.md
  - 要件定義
- docs/02_system_architecture.md
  - システム構成、技術選定、拡張方針
- docs/03_network_wifi_design.md
  - 院内Wi-Fi設計と現地検証項目
- docs/04_security_privacy_medical.md
  - 医療現場向けセキュリティ・プライバシー方針
- docs/05_development_roadmap.md
  - 開発ロードマップ
- docs/06_test_plan.md
  - 音質・遅延・運用テスト計画
- docs/07_operations_runbook.md
  - 運用手順
- docs/08_user_manual.md
  - スタッフ向け操作マニュアル（ログイン・話し方・ルール）
- docs/09_admin_manual.md
  - 管理者マニュアル（構成・パスワード管理・管理画面・トラブル対応）
- prompts/
  - Claude Code / Codex / Manusに投げるプロンプト
- infra/livekit/
  - LiveKitローカル検証用Docker設定
- apps/web/
  - Next.js + LiveKit ClientのMVP雛形

## MVPで実現すること

- スタッフ名で参加
- 受付、診療室、オペ、滅菌、全体ルームを選択
- LiveKitサーバーに接続
- 音声のみのグループ通話
- Push to Talk
- 常時ONモード
- 緊急全体ルームへの切替
- ブラウザで動作確認

## 最初の起動手順

### 1. LiveKitを起動

```bash
cd infra/livekit
docker compose up -d
```

### 2. Webアプリを起動

```bash
cd apps/web
cp .env.example .env.local
npm install
npm run dev
```

ブラウザで以下を開きます。

```text
http://localhost:3000
```

スマホ実機で試す場合は、PCとスマホを同じWi-Fiに接続し、PCのLAN内IPアドレスでアクセスしてください。
例: `http://192.168.1.10:3000`

## 本番化前の注意

このMVPは院内実証用です。本番運用前に以下が必須です。

- HTTPS/WSS化
- TURN/TLS対応
- 端末認証
- スタッフアカウント管理
- MDMまたは端末紛失時の無効化
- 院内Wi-Fiの現地測定
- 患者情報を音声に乗せない運用ルール
- 録音機能は原則オフ

## 推奨開発順序

1. 大磯または南青山など1院でPoC
2. Wi-Fi測定と5名同時通話テスト
3. 10名同時通話テスト
4. React Nativeアプリ化
5. 管理画面と施設別ルームを追加
6. 全院展開
