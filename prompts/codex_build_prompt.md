# Codex 用 実装プロンプト

このリポジトリは、歯科医院向けのWi-Fi/LTE対応音声インカム「MIRISE Intercom」のMVPです。
あなたの役割は、コードベースを読み、動作する最小実装に仕上げることです。

## 実装目的

スマホまたはPCブラウザからLiveKitに接続し、スタッフ同士が音声のみでグループ通話できるようにする。
まずは院内PoC用であり、録音・文字起こし・患者情報連携は実装しない。

## 優先順位

1. セキュアなLiveKit token発行
2. 音声通話の安定接続
3. Push to Talk
4. 常時ONモード
5. 緊急全体ルーム切替
6. UI改善
7. エラー処理
8. テストとREADME整備

## 守るべき制約

- API secretはサーバー側だけで使う
- 患者情報を扱うフィールドを作らない
- 音声データを保存しない
- 文字起こしを入れない
- 外部AI APIを呼ばない
- MVPはシンプルに保つ

## 実行してほしいこと

- npm install
- npm run build
- TypeScriptエラー修正
- ESLintエラー修正
- 2ブラウザ通話の手順をREADMEに追記
- 本番化TODOをdocsに追記

## 期待する最終状態

```bash
cd infra/livekit
docker compose up -d

cd ../../apps/web
cp .env.example .env.local
npm install
npm run dev
```

この手順で、http://localhost:3000 にアクセスし、複数ブラウザから同じルームに入ると音声通話ができる状態にしてください。

## レビュー観点

- LiveKit token発行は安全か
- 音声トラックの破棄漏れがないか
- ブラウザ権限拒否時に分かりやすいエラーが出るか
- PTTのマウス・タッチ操作が両方効くか
- 本番化時に認証を差し替えやすいか
