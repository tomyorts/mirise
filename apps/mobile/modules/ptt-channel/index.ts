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
  /**
   * ネイティブ側の「本当の参加状態」。JSのstateはアプリ再起動で消えるが、
   * ネイティブは復元後も参加済みのことがある(旧ビルドには無いのでoptional)。
   */
  getState?: () => { joined: boolean; channelUUID?: string };
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
