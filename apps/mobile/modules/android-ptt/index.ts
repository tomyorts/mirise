import { requireOptionalNativeModule, type EventSubscription } from "expo-modules-core";

// Android版の「勤務中サービス」。iPhone では存在しない(null)。
export type AndroidPttModuleType = {
  /** どのネイティブビルドが入っているかを判別するタグ */
  buildTag?: string;
  /** 出勤時に呼ぶ(画面が前面にある時のみ開始できる)。通知を出して常駐する */
  start(title: string): boolean;
  /** 退勤時に呼ぶ */
  stop(): boolean;
  isRunning(): boolean;
  /** 音楽アプリなどに取られたイヤホンのボタンの受け取り先を取り戻す */
  reclaim(): void;
  /**
   * 送信の自動停止(切り忘れ防止)の予約。ms ミリ秒後に onAutoOff { id } が届く(前の予約は取り消し)。
   * 画面ロック中は JS の setTimeout が発火しない(React Native の仕様)ため、ネイティブで時間を測る。
   * 旧ビルドでは無し。
   */
  armAutoOff?(ms: number, id: number): void;
  /** 自動停止の予約を取り消す。旧ビルドでは無し */
  cancelAutoOff?(): void;
  addListener(
    eventName: "onMediaButton",
    listener: (payload: { key: string }) => void,
  ): EventSubscription;
  addListener(
    eventName: "onAutoOff",
    listener: (payload: { id?: number }) => void,
  ): EventSubscription;
};

const AndroidPtt = requireOptionalNativeModule<AndroidPttModuleType>("AndroidPtt");

export default AndroidPtt;
