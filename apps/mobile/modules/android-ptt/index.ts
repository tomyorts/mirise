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
  addListener(
    eventName: "onMediaButton",
    listener: (payload: { key: string }) => void,
  ): EventSubscription;
};

const AndroidPtt = requireOptionalNativeModule<AndroidPttModuleType>("AndroidPtt");

export default AndroidPtt;
