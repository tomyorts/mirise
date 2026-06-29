# Claude Code 用 実装プロンプト

あなたはシニアフルスタックエンジニアとして振る舞ってください。
以下の要件に基づき、院内スタッフ用のWi-Fi/LTE対応音声インカムMVPを実装してください。

## プロダクト概要

MIRISE Intercomは、歯科医院・医療現場のスタッフがスマホとBluetoothイヤホンを使い、BONXのように距離に依存せずクリアに会話するための音声インカムです。
最初のMVPでは、専用ハードは作らず、WebアプリとLiveKit/WebRTCで検証します。

## 技術要件

- Next.js App Router
- TypeScript
- livekit-client
- livekit-server-sdk
- LiveKit self-hosted Docker
- 音声のみ
- 録音なし
- 文字起こしなし
- APIシークレットはサーバー側のみ

## MVP機能

- スタッフ名入力
- ルーム選択
- ルーム一覧
  - front: 受付
  - clinic: 診療室
  - surgery: オペ
  - sterilization: 滅菌
  - all: 全体
- LiveKit接続
- 音声受信
- Push to Talk
- 常時ONモード
- ミュート
- 緊急全体ルーム切替
- 接続状態表示
- エラー表示

## 実装タスク

1. 既存ファイル構成を確認する
2. 依存関係を確認する
3. apps/web のNext.jsアプリを完成させる
4. infra/livekit のDocker ComposeでLiveKitを起動できるようにする
5. .env.example を整備する
6. READMEに起動手順を追加する
7. TypeScript型エラーを解消する
8. npm run buildが通る状態にする
9. PTT操作をPCとスマホ両方で使えるようにする
10. 緊急全体ルーム切替のUXを分かりやすくする

## セキュリティ制約

- LIVEKIT_API_SECRETをブラウザ側に出さない
- 患者情報を保存しない
- 音声録音を実装しない
- ログには会話内容を残さない
- MVPの簡易ログインであっても、将来の認証差し替えを容易にする

## 成果物

- 動作するコード
- 起動手順
- テスト手順
- 既知の制約
- 次にReact Native化する際の TODO

## 実装後に必ず確認すること

- 2つのブラウザで同じルームに入り、音声が届くこと
- PTTでマイクON/OFFが切り替わること
- 常時ONモードが動くこと
- 全体ルーム切替が動くこと
- APIシークレットがクライアントバンドルに含まれていないこと
