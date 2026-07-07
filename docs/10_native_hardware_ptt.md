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
| 🔘 専用BLEボタン（指輪型等） | ✅ 可能（別途） | CoreBluetooth連携。将来オプション |

**動作イメージ:** イヤホンのボタンを押す → 送信開始（🔴送信中）。もう一度押す → 送信停止。
止め忘れ防止に「一定時間で自動オフ」＋「画面の赤いバナー」を併用する。

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

## 7. まとめ
- ネイティブなら**イヤホンのボタンでPTT（トグル）が実現可能**。これがアプリ化の目的。
- 実装は「小さな専用ネイティブモジュール（MPRemoteCommandCenter）」が最小・確実。
- コードは本ドキュメントに用意済み。**Apple有効化 → Phase 2実機確認 → 本モジュール追加 → 実機でボタン確認**、の順で進める。
