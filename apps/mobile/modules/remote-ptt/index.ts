import { requireOptionalNativeModule, type EventSubscription } from "expo-modules-core";

// ネイティブモジュール本体。
// Expo Go や未ビルド環境では存在しないため requireOptional で「無ければ null」にする
// （import 時点でアプリごとクラッシュするのを防ぐ）。
export type RemotePttModuleType = {
  /** どのネイティブビルドが入っているかを判別するタグ */
  buildTag?: string;
  /** キーボード型BLEリモコン(ページめくり器・シャッター等)のキー入力の購読を開始 */
  start(): void;
  /** 購読を停止 */
  stop(): void;
  /** onToggle イベントの購読 */
  addListener(
    eventName: "onToggle",
    listener: (payload: { source?: string }) => void,
  ): EventSubscription;
};

const RemotePtt = requireOptionalNativeModule<RemotePttModuleType>("RemotePtt");

export default RemotePtt;
