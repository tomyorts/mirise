import { requireOptionalNativeModule, type EventSubscription } from "expo-modules-core";

// 物理BLEボタン(iTag型の紛失防止タグ / PTTボタン型)のネイティブモジュール。
// キーボード(HID)型リモコンと違い、GATT通知はロック中でもアプリに届くため、
// 画面ロック中のPTT送信開始/停止に使える。
// Expo Go や未ビルド環境では存在しないため requireOptional で「無ければ null」。
//
// iOS/Android の両ネイティブ実装がこの型(共通の契約)に従う。古いネイティブビルドでも
// 型チェックと実行が壊れないよう、後から増えた項目はすべて省略可能にしている。

/**
 * 押し方の方式。
 * - "hold": 押している間だけ送信(離した通知 0x00 を送るボタンのみ)
 * - "toggle": 押すたびに送信ON/OFF(iTag等、押した通知しか無いボタンは常にこれ)
 */
export type BleButtonMode = "toggle" | "hold";

/**
 * 押下イベントの種類。
 * - "toggle": 押すたびにON/OFFを切り替える
 * - "down": 押した(ホールド方式の送信開始)
 * - "up": 離した(送信停止)。リンク切断・異常連打での無効化時などにも、
 *   送信が開いたまま残らないようネイティブ側が合成して送ることがある。
 */
export type BlePressKind = "toggle" | "down" | "up";

export type BleButtonState =
  | "idle"
  | "scanning"
  | "connecting"
  | "confirming"
  /** 押下通知の購読が実際に有効になった(=ボタンとして使える)時だけ送られる */
  | "connected"
  | "disconnected"
  | "error"
  /** 診断ログ専用(画面の案内文は更新しない) */
  | "debug";

export type BleButtonStatus = {
  registered: boolean;
  /** リンクが繋がっている(まだ押下を受けられるとは限らない) */
  connected: boolean;
  /** 押下通知の購読が有効(これが true の時だけボタンが使える)。旧ビルドでは無し */
  ready?: boolean;
  name?: string;
  /** 離した通知(0x00)を別に送るボタンか(=押している間だけ送信が可能) */
  holdCapable?: boolean;
  /** 現在の方式(ホールド非対応のボタンは常に "toggle") */
  mode?: BleButtonMode;
  /**
   * 購読設定(CCCD)が無く、購読なしで押下が届くボタン(安価なiTagの一部・iOSのみ)。
   * 登録時に実際の押下が届くことを確認済み。旧ビルドでは無し
   */
  noCccd?: boolean;
};

export type BlePressEvent = {
  /** 無ければ旧ネイティブビルド = "toggle" として扱う */
  kind?: BlePressKind;
  /** JSの購読開始前に届いた押下を後から再送したもの */
  replayed?: boolean;
  /** 再送時: 実際に押されてからの経過ミリ秒 */
  ageMs?: number;
  /**
   * ネイティブが押下を受け取って送り出した時刻(1970年からのミリ秒・端末の時計)。
   * 診断ログの所要時間の記録で「JSが起こされるまでの遅れ」を測るためだけに使う。旧ビルドでは無し
   */
  atMs?: number;
};

export type BleButtonStateEvent = {
  state: BleButtonState;
  detail: string;
  name?: string;
};

export type BleButtonModuleType = {
  /** どのネイティブビルドが入っているかを判別するタグ */
  buildTag?: string;
  /** 登録済みボタンへの接続維持を(再)開始(前面復帰のたびに呼ぶと、失敗からの再試行にもなる) */
  start(): void;
  /** 現在の状態を取得 */
  getStatus(): BleButtonStatus;
  /**
   * 近くのBLEボタンを探して登録(前面での初期設定用)。接続後に「ボタンを短く2回」
   * 押してもらって確定する。成功で { name, holdCapable }
   * (旧ネイティブビルドは holdCapable を返さない)。
   */
  startSetup(): Promise<{ name: string; holdCapable: boolean; noCccd?: boolean }>;
  /** 登録解除+切断 */
  unregister(): void;
  /** 押し方の方式を保存(ホールド非対応のボタンでは無視され、常に "toggle")。旧ビルドでは無し */
  setMode?(mode: BleButtonMode): void;
  addListener(eventName: "onPress", listener: (payload: BlePressEvent) => void): EventSubscription;
  addListener(
    eventName: "onStateChanged",
    listener: (payload: BleButtonStateEvent) => void,
  ): EventSubscription;
};

const BleButton = requireOptionalNativeModule<BleButtonModuleType>("BleButton");

export default BleButton;
