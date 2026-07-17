import { requireOptionalNativeModule, type EventSubscription } from "expo-modules-core";

// iTag型(紛失防止タグ)BLEボタンのネイティブモジュール。
// キーボード(HID)型リモコンと違い、GATT通知はロック中でもアプリに届くため、
// 画面ロック中のPTT送信開始/停止に使える。
// Expo Go や未ビルド環境では存在しないため requireOptional で「無ければ null」。

export type BleButtonState =
  | "idle"
  | "scanning"
  | "connecting"
  | "confirming"
  | "connected"
  | "disconnected"
  | "error";

export type BleButtonStatus = {
  registered: boolean;
  connected: boolean;
  name?: string;
};

export type BleButtonModuleType = {
  /** どのネイティブビルドが入っているかを判別するタグ */
  buildTag?: string;
  /** 登録済みボタンへの接続維持を(再)開始 */
  start(): void;
  /** 現在の状態を取得 */
  getStatus(): BleButtonStatus;
  /** 近くのiTag型ボタンを探して登録(前面での初期設定用)。成功で { name } */
  startSetup(): Promise<{ name: string }>;
  /** 登録解除+切断 */
  unregister(): void;
  addListener(
    eventName: "onPress",
    listener: (payload: { replayed?: boolean }) => void,
  ): EventSubscription;
  addListener(
    eventName: "onStateChanged",
    listener: (payload: { state: BleButtonState; detail: string; name?: string }) => void,
  ): EventSubscription;
};

const BleButton = requireOptionalNativeModule<BleButtonModuleType>("BleButton");

export default BleButton;
