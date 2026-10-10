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
>
> ⚠️ **訂正（2026-10・実機で確認）**: 下の §1 で「可能・推奨」としていた **キーを送るBLEリモコン
> （ページめくり器・指輪型・シャッターリモコン等のキーボード/HID型）は、画面ロック中は使えません**。
> ロック中にキーを押すと iOS が Face ID / パスコード画面を出し、アプリにはキーが届かないためです（OSの仕様で回避不可）。
> ロック中・ポケットの中で使える物理ボタンは、**GATT通知を送るBLEボタン（iTag型 / PTTボタン型）** です
> （§1-2）。実装は `apps/mobile/modules/ble-button/`（iOS: Swift / Android: Kotlin）、使い方は `docs/08_user_manual.md` §3。

---

## 1. 何を実現するか / できる・できない

| やりたいこと | 可否 | 方法 |
|---|---|---|
| 🎧 イヤホンの再生/停止ボタンで送信ON/OFF | ✅ 可能 | iOS の Remote Command（MPRemoteCommandCenter） |
| 📴 画面OFF・ポケットの中でも動く | ✅ 可能 | バックグラウンド音声モード（`UIBackgroundModes: ["audio"]`／設定済み） |
| ⏱️ 「押している間だけ」送信（ホールド） | ⚠️ 不可 | イヤホンのボタンは「押した瞬間」しか送れない → **トグル**（押すたびON/OFF）で実装 |
| 📲 スマホの音量ボタンでPTT | △ 技術的に可能・App Store審査で不利 | 院内配布（社内アプリ）なら可。App Store公開なら避ける |
| 🔘 キーを送るBLEリモコン（ページめくり器・指輪型・シャッターリモコン） | ❌ **ロック中は不可**（画面表示中のみ・実機で確認済み） | GameController のキーボード入力（実装済み・前面時の補助） |
| 🔘 GATT通知型のBLEボタン（iTag型・Zello用PTTボタン） | ✅ **可能・推奨**（ロック中・ポケットの中でも可） | BleButton モジュール（CoreBluetooth / Android BLE。§1-2） |

**動作イメージ:** イヤホンのボタン／BLEボタンを押す → 送信開始（🔴送信中）。もう一度押す → 送信停止。
（離した通知を送るPTTボタン型は「押している間だけ」送信も可能）
止め忘れ防止に「一定時間で自動オフ」＋「画面の赤いバナー」を併用する。

### 1-1. ❌ 訂正: キーを送るBLEリモコン（キーボード/HID型）はロック中に使えない
以前の版では「音声モードに影響されず確実にアプリへ届く」として推奨していたが、**実機で確認した結果、
画面ロック中は使えない**ため推奨を取り消す。

- **理由**: キーボード（HID）として接続される機器のキー入力は、iOS では「前面のアプリ」にしか
  配送されない。ロック中にキーを押すと iOS は Face ID / パスコード画面を出し、アプリには届かない
  （OSの仕様で回避不可）。スタッフはスマホをロックしてポケットに入れたまま使うため、実運用に合わない。
- **現状の扱い**: GameController（`GCKeyboard`）での受信コード（`modules/remote-ptt` / `hooks/useRemotePtt.ts`）は
  残しているが、**画面を表示している時だけの補助**。押下はトグル（BLEボタンと同じ経路）として扱う。
- **買わないもの**: プレゼン用ページめくり器・指輪型リモコン・カメラのシャッターリモコンなど、
  キーボードとして認識されるもの全般。

### 1-2. ✅ 推奨: GATT通知型のBLEボタン（iTag型 / PTTボタン型）
キーボードではなく **GATT通知（Notify）という生の信号を送るBLEボタン** は、
`bluetooth-central` バックグラウンドモード（iOS）／勤務中サービス（Android）があれば、
**ロック中・バックグラウンドでもアプリが直接受信できる**。耳に触れず、髪で隠れることもない。

| 機器 | 通知 | 押下の扱い |
|---|---|---|
| **iTag型（紛失防止タグ）** | サービス `FFE0` / 特性 `FFE1`（一部の互換品は `FFF0`/`FFF1`）。押すたびに `0x01`。離した通知は無い | 押すたびにON/OFF（トグル。0.8秒のデバウンス、30秒で自動停止） |
| **Zello用PTTボタン（PTT-Z01 / YPC21 等、名前が「PTT」で始まる）** | `FFE0`/`FFE1`。押すと `0x01`、離すと `0x00` | 既定は「押している間だけ」（down/up、60秒が上限）。「押すたびにON/OFF」にも切替可 |
| **Pryme型** | 押すと非0、離すと `0x00` | PTTボタン型と同じ |

- **実装**: `apps/mobile/modules/ble-button/`（iOS: `ios/BleButtonModule.swift` / Android: `android/.../BleButtonClient.kt`）。
  JS からは `index.ts` の共通API（`start` / `getStatus` / `startSetup` / `unregister` / `setMode`、
  イベント `onPress {kind: "toggle"|"down"|"up"}` / `onStateChanged`）で使う。画面は `App.tsx` の「🔘 物理ボタン」カード。
- **登録（前面のみ）**: 近くの候補（`FFE0`/`FFF0` を広告、または名前が「iTAG」「PTT」で始まる。HID `1812` は除外）に接続し、
  `FFE1`/`FFF1` だけを購読して「ボタンを短く2回押してください」と案内。**0.3秒以上離れた2回の通知**で確定する
  （近くの無関係な機器を誤登録しない）。押した後に `0x00` が来たボタンは「押している間だけ」対応として保存。
  登録直後の10秒間は確認モード（押すと「反応しました ✅」と出るだけで送信しない）。
- **ホットマイク（送信の開きっぱなし）対策**:
  - 登録した機器・登録時に確定した特性・購読が有効になった後の通知だけを押下として扱う
  - 2秒間に4回を超える通知は故障/押しっぱなしとみなし、30秒間ボタンを止める
  - 押している最中にリンクが切れた等の場合は「離す(up)」を合成して送る。JS側も切断・異常・登録解除・方式変更の時に、
    ボタンで始めた送信を止める
  - トグルは30秒、「押している間だけ」は60秒で必ず自動停止。送信開始の確定が5秒以内に来なければ押下を取り消す。退勤後の押下は無視
    （Android は画面ロックでアクティビティが一時停止すると JS の `setTimeout` が発火しないため、自動停止の時間は
    `android-ptt` の `armAutoOff`（ネイティブの Handler）でも測り、`onAutoOff` で止める。イヤホンのボタンの45秒も同じ）
  - JSの購読前に届いた押下の再送は3秒以内のものだけ受け付ける（「離す」は常に受け付ける）
- **紛失防止タグの警報**: 接続のたびに Link Loss（`1803`/`2A06`）と Immediate Alert（`1802`/`2A06`）へ `0x00` を書き、
  切断時にタグが鳴らないようにする（押下特性の購読より先に書く。購読に失敗して切断する場合も鳴らないように）。
- **買ってはいけないもの**: シャッターリモコン・キーボード型・Find My（「探す」）対応タグ・Tuya（Smart Life）対応タグ。
- **運用上の注意（スタッフへ周知）**: アプリを上スワイプで終了しない／Bluetoothをオフにしない／
  再起動後は一度アプリを開く／iTag型は長押ししない（3〜5秒で電源が切れる）。

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
        MPMediaItemPropertyTitle: "MIRAI LINK"
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

> 注: キーボード式BLEリモコン（矢印/Enter）は**前面時は確実**だが、**ロック中・バックグラウンドでは届かない**
> （実機で確認済み。ロック中は iOS が Face ID / パスコード画面を出す）。
> ポケット運用の本命は **Phase B: PushToTalk フレームワーク**＋**GATT通知型のBLEボタン（§1-2）**。

---

## 7. まとめ
- ネイティブなら**ボタンでPTT（トグル）が実現可能**。これがアプリ化の目的。
- 実装は「小さな専用ネイティブモジュール（MPRemoteCommandCenter＋GameControllerキーボード）」が最小・確実。
- ただしキーボード型リモコンは**ロック中に使えない**（実機で確認済み）。ロック中・ポケットの中で使う物理ボタンは
  **GATT通知型のBLEボタン（iTag型 / PTTボタン型、§1-2）** を推奨する。
- **前面利用**は実装済みで確実。**ポケット運用（バックグラウンド）**は Phase A を実装済み、実地テストで可否を判断 → 必要なら **Phase B（Push to Talk フレームワーク）** へ。
