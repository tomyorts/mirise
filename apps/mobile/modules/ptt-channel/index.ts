import { requireOptionalNativeModule, type EventSubscription } from "expo-modules-core";

export type PttChannelEvent =
  | "onJoin"
  | "onLeave"
  | "onBeginTransmitting"
  | "onEndTransmitting"
  | "onActivateAudio"
  | "onDeactivateAudio"
  | "onPushToken"
  | "onError";

export type PttChannelModuleType = {
  /** PTTチャンネルに参加(バックグラウンド送信が可能になる)。channelUUIDを返す */
  join(name: string): Promise<string>;
  /** チャンネルから退出 */
  leave(): Promise<void>;
  /** 送信開始を要求(成功で onBeginTransmitting が発火) */
  beginTransmitting(): Promise<void>;
  /** 送信停止 */
  endTransmitting(): Promise<void>;
  addListener(
    event: PttChannelEvent,
    listener: (payload: Record<string, unknown>) => void,
  ): EventSubscription;
};

// iOS 16+ かつ開発ビルドでのみ存在。未対応環境では null。
const PttChannel = requireOptionalNativeModule<PttChannelModuleType>("PttChannel");

export default PttChannel;
