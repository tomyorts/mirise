import { requireOptionalNativeModule, type EventSubscription } from "expo-modules-core";

/**
 * onError の payload.kind。参加・送信の要求がシステムに拒否された時に届く
 * (polish-1 以降のビルド)。
 */
export type PttErrorKind = "join" | "leave" | "begin" | "stop";

export type PttChannelEvent =
  | "onJoin"
  | "onLeave"
  | "onBeginTransmitting"
  | "onEndTransmitting"
  | "onActivateAudio"
  | "onDeactivateAudio"
  | "onPushToken"
  | "onAccessoryButton"
  | "onError";

export type PttChannelModuleType = {
  /**
   * ネイティブ側の「本当の状態」。JSのstateはアプリ再起動で消えるが、
   * ネイティブは復元後も参加済みのことがある(旧ビルドには無いのでoptional)。
   * transmitting/audioActive/source は polish-1 以降のビルドのみ。JSの購読前に
   * 始まった送信(終了されていたアプリをイヤホンで起こした場合)の引き継ぎに使う。
   */
  getState?: () => {
    joined: boolean;
    channelUUID?: string;
    transmitting?: boolean;
    audioActive?: boolean;
    source?: string;
  };
  /** PTTチャンネルに参加(バックグラウンド送信が可能になる)。channelUUIDを返す */
  join(name: string): Promise<string>;
  /** チャンネルから退出 */
  leave(): Promise<void>;
  /** 送信開始を要求(成功で onBeginTransmitting が発火) */
  beginTransmitting(): Promise<void>;
  /** 送信停止 */
  endTransmitting(): Promise<void>;
  /**
   * イヤホンのボタンをPTTの送信操作に割り当てるか(iOS17+、旧ビルドには無い)。
   * アプリ側でメディアボタンを横取りする方式と併用しないよう排他制御に使う。
   */
  setAccessoryButtonEnabled?: (enabled: boolean) => Promise<void>;
  addListener(
    event: PttChannelEvent,
    listener: (payload: Record<string, unknown>) => void,
  ): EventSubscription;
};

/**
 * 送信の起点(onBeginTransmitting / onEndTransmitting の payload.source)。
 * PttChannelModule.swift の sourceName() が返す文字列と必ず一致させること。
 * - handsfree: Bluetoothイヤホン等のボタン(PushToTalk の handsfreeButton)
 * - systemUi : ロック画面/Dynamic Island のトークボタン(押している間だけ)
 * - app      : アプリが beginTransmitting を呼んだもの(画面のボタン・BLEボタン)
 */
export const PTT_SOURCE = {
  handsfree: "イヤホンのボタン",
  systemUi: "システムUIのトークボタン",
  app: "アプリ内のボタン",
} as const;

// iOS 16+ かつ開発ビルドでのみ存在。未対応環境では null。
const PttChannel = requireOptionalNativeModule<PttChannelModuleType>("PttChannel");

export default PttChannel;
