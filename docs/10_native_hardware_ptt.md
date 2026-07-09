# 10 ネイティブアプリ Phase 3: ハードボタンPTT（イヤホンのボタンで話す）

このドキュメントは、ネイティブアプリ（`apps/mobile`, Expo/React Native）で
**Bluetoothイヤホンのボタンを「押して話す（PTT）」に割り当てる**ための実装設計です。

> ✅ **実装済み（2026-07）**: 本設計はコードに反映済みです。
> - ネイティブモジュール: `apps/mobile/modules/remote-ptt/`（Swift + TS）
> - フック: `apps/mobile/hooks/useRemotePtt.ts`
> - 画面組み込み: `apps/mobile/App.tsx`（接続中のみ購読 + 30秒自動OFF）
>
> あとは開発ビルド（`npx eas-cli build --profile development --platform ios`）を作って実機で
> §5 の手順どおり動作確認するだけです。以下は仕組みと確認手順のリファレンスです。

---

## 1. 何を実現するか / できる・できない

| やりたいこと | 可否 | 方法 |
|---|---|---|
| 🎧 イヤホンの再生/停止ボタンで送信ON/OFF | ✅ 可能 | iOS の Remote Command（MPRemoteCommandCenter） |
| 📴 画面OFF・ポケットの中でも動く | ✅ 可能 | バックグラウンド音声モード（`UIBackgroundModes: ["audio"]`／設定済み） |
| ⏱️ 「押している間だけ」送信（ホールド） | ⚠️ 不可 | イヤホンのボタンは「押した瞬間」しか送れない → **トグル**（押すたびON/OFF）で実装 |
| 📲 スマホの音量ボタンでPTT | △ 技術的に可能・App Store審査で不利 | 院内配布（社内アプリ）なら可。App Store公開なら避ける |
| 🔘 キーを送るBLEリモコン（ページめくり器・指輪型） | ✅ **可能・推奨** | GameController のキーボード入力（実装済み） |

**動作イメージ:** イヤホンのボタン／BLEリモコンを押す → 送信開始（🔴送信中）。もう一度押す → 送信停止。
止め忘れ防止に「一定時間で自動オフ」＋「画面の赤いバナー」を併用する。

### ✅ 推奨: キーを送るBLEリモコン（セパレート型）
イヤホンの再生/停止ボタンは、通話中の音声モード（HFP）と競合して届かないことがある。
これに対し「Bluetoothキーボードとしてキーを送るBLEリモコン」は、音声モードに影響されず
**確実にアプリへ届く**。耳に触れないため衛生的で、白衣の胸ポケット等に付けられる。

- **仕組み**: iOS の GameController フレームワーク（`GCKeyboard`）で、接続されたBLEリモコンの
  キー押下を検知。`Enter / スペース / 矢印 / PageUp / PageDown` のいずれかで送信トグル。
- **買うべきもの**: 「プレゼン用ページめくり器（プレゼンター/クリッカー）」「指輪型BLEリモコン」など、
  **キーボードとして矢印やPageUp/Downを送るタイプ**。
- **避けるもの**: カメラのシャッターリモコン（iOSでは"音量アップ"を送る個体が多く、扱いにくい）。
  購入前に商品説明で「Bluetoothキーボードとして認識」「矢印/ページ送りキーを送る」旨を確認。
- **確認方法**: 買ったリモコンを iPhone にBluetooth接続し、メモ帳アプリでカーソルが動く/改行が
  入るなら「キーを送るタイプ」。何も入力されないなら別のキー割当か非対応。

---

## 2. 仕組み（なぜブラウザでは無理でネイティブなら可能か）

iOS は、Bluetoothヘッドセットの再生/停止ボタンを「**リモートコマンド**」としてアプリに配送する。
音楽アプリがイヤホンのボタンで再生/停止できるのと同じ仕組み。
- ブラウザ（Safari）はこのコマンドを受け取れない → だからWeb版では不可だった
- ネイティブアプリは `MPRemoteCommandCenter` で受け取れる → **これがアプリ化の目的**

ただしコマンドが届く条件がある:
1. アプリが**アクティブな音声セッション**を持っている（LiveKit接続中はOK）
2. アプリが**「再生中」相当の状態**（`MPNowPlayingInfoCenter` に情報をセット）

---

## 3. 実装方針（推奨: 小さな専用ネイティブモジュール）

フル再生エンジン（react-native-track-player 等）は目的に対して重い。
**「リモートコマンドを受け取ってJSに通知するだけ」の小さな Expo ネイティブモジュール**を作るのが最小で確実。

### 3-1. Expoモジュールを作る
```bash
# apps/mobile で
npx create-expo-module@latest --local modules/remote-ptt
```

### 3-2. iOS側（Swift）: modules/remote-ptt/ios/RemotePttModule.swift
```swift
import ExpoModulesCore
import MediaPlayer

public class RemotePttModule: Module {
  public func definition() -> ModuleDefinition {
    Name("RemotePtt")
    Events("onToggle")

    // リモートコマンド（イヤホンの再生/停止ボタン）を購読
    Function("start") {
      let center = MPRemoteCommandCenter.shared()
      // 最小のNow Playing情報（これが無いとボタンが届かない）
      MPNowPlayingInfoCenter.default().nowPlayingInfo = [
        MPMediaItemPropertyTitle: "MIRISE Intercom"
      ]
      let handler: (MPRemoteCommandEvent) -> MPRemoteCommandHandlerStatus = { [weak self] _ in
        self?.sendEvent("onToggle", [:])
        return .success
      }
      center.togglePlayPauseCommand.isEnabled = true
      center.togglePlayPauseCommand.addTarget(handler: handler)
      center.playCommand.isEnabled = true
      center.playCommand.addTarget(handler: handler)
      center.pauseCommand.isEnabled = true
      center.pauseCommand.addTarget(handler: handler)
    }

    Function("stop") {
      let center = MPRemoteCommandCenter.shared()
      center.togglePlayPauseCommand.removeTarget(nil)
      center.playCommand.removeTarget(nil)
      center.pauseCommand.removeTarget(nil)
      MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }
  }
}
```

### 3-3. JS側フック: apps/mobile/hooks/useRemotePtt.ts
```ts
import { useEffect } from "react";
import RemotePtt from "../modules/remote-ptt";

/** イヤホン等のボタン押下で onToggle を呼ぶ */
export function useRemotePtt(onToggle: () => void, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    RemotePtt.start();
    const sub = RemotePtt.addListener("onToggle", () => onToggle());
    return () => {
      sub.remove();
      RemotePtt.stop();
    };
  }, [enabled, onToggle]);
}
```

### 3-4. App.tsx への組み込み（接続中だけ有効化）
```ts
// 送信トグル + 止め忘れ自動オフ(例: 30秒)
const toggleWithSafety = useCallback(() => {
  setMic((prev) => {
    const next = !micOn;
    if (next) {
      // 30秒で自動オフ(安全)
      clearTimeout(autoOffRef.current);
      autoOffRef.current = setTimeout(() => setMic(false), 30_000);
    }
    return next;
  });
}, [micOn]);

useRemotePtt(() => void setMic(!micOn), connected);
```
（実際は `setMic` を state と揃えて実装。接続中 `connected===true` のときだけボタンを購読する）

---

## 4. app.json（設定済み＋確認事項）
- ✅ `ios.infoPlist.UIBackgroundModes: ["audio"]`（バックグラウンド動作・設定済み）
- ✅ `ios.infoPlist.NSMicrophoneUsageDescription`（マイク権限・設定済み）
- ローカルExpoモジュールは `expo prebuild` / EASビルドで自動的に取り込まれる

---

## 5. 実機での確認手順（Apple有効化後）
1. `npx eas-cli build --profile development --platform ios` で開発ビルド（Phase 2の音声込み）
2. まず**画面のボタン**で送信ON/OFFできることを確認（Phase 2）
3. 本モジュールを追加して再ビルド
4. **Hmusicを接続 → イヤホンのボタンを押す → 🔴送信中 になるか**確認
   - 効かない場合の切り分け:
     - Now Playing情報がセットされているか（他の音楽アプリを完全終了して再試行）
     - イヤホンが「再生/停止」信号を送るタイプか（機種により single/double/long press の割当が違う）
     - LiveKitの `AudioSession` 設定と競合していないか（category/mode）
5. 動いたら「30秒自動オフ」「赤バナー」を調整

---

## 6. 注意・リスク
- **機種依存**: すべてのBTイヤホンが標準の再生/停止コマンドを送るわけではない。Hmusicは通話・物理ボタン対応なので有望だが、実機確認が必須
- **トグル方式**: 押している間だけ、はできない。止め忘れ対策（自動オフ・赤表示）を必ず入れる
- **音量ボタンPTT**: App Store公開では規約違反リスク。院内(Ad Hoc/社内)配布なら可
- **バックグラウンド継続**: iOSは長時間バックグラウンドのマイク使用を制限する場合あり。実運用テストで確認（必要なら CallKit 連携を検討）

---

## 6.5 ポケット運用（バックグラウンド動作）— Phase A 実装

要件: 画面OFF・ポケットの中でも「聞ける／話せる／ボタンで送信」できること。

### 実装済み（Phase A）
- `app.json`: `UIBackgroundModes: ["audio"]`（設定済み）
- `App.tsx` 接続時に音声セッションをVoIP向けに設定:
  ```ts
  await AudioSession.configureAudio({ ios: { defaultOutput: "earpiece" } });
  await AudioSession.setAppleAudioConfiguration({
    audioCategory: "playAndRecord",
    audioMode: "voiceChat",
    audioCategoryOptions: ["allowBluetooth", "allowBluetoothA2DP"],
  });
  await AudioSession.startAudioSession();
  ```

### 実地テスト（再ビルド後・これで判断する）
1. iPhoneをBLEイヤホンに接続してルームに接続
2. **画面をロック（またはアプリを裏に）してポケットへ**
3. 別端末（Web版）から話す → **ロック中でも聞こえるか**（=バックグラウンド"受信"）
4. **ボタンを押す → 🔴送信 → 相手に届くか**（=バックグラウンド"送信"＋"ボタン"）
   - ここが本命の検証ポイント
5. これを**数分〜1シフト**続けて、途中で切れないか（iOSの省電力停止が起きないか）

### 想定される結果と次の一手
| 結果 | 判断 |
|---|---|
| ✅ ロック中も聞ける・話せる・ボタンも効く | Phase Aで実運用可。自動オフ時間等を調整して完成 |
| △ 聞けるが、**ロック中はボタンが効かない** | iOSはキー入力を前面アプリに送るため（既知の制約）。→ **Phase B（Push to Talk フレームワーク）**へ。ボタンとバックグラウンドが正規サポートされる |
| ❌ 数分でロック中に切れる | iOSの省電力。→ Phase B（PTTフレームワーク／CallKit）が必要 |

> 注: バックグラウンドで確実に効くボタンは iOS では **メディア再生/停止（MPRemoteCommandCenter）系**。
> キーボード式BLEリモコン（矢印/Enter）は**前面時は確実**だが**バックグラウンドでは届かない**可能性が高い。
> ポケット運用で確実にしたい場合の本命は **Phase B: PushToTalk フレームワーク**。

---

## 7. まとめ
- ネイティブなら**ボタンでPTT（トグル）が実現可能**。これがアプリ化の目的。
- 実装は「小さな専用ネイティブモジュール（MPRemoteCommandCenter＋GameControllerキーボード）」が最小・確実。
- **前面利用**は実装済みで確実。**ポケット運用（バックグラウンド）**は Phase A を実装済み、実地テストで可否を判断 → 必要なら **Phase B（Push to Talk フレームワーク）** へ。
