import { requireOptionalNativeModule, type EventSubscription } from "expo-modules-core";

// ネイティブモジュール本体。
// Expo Go や未ビルド環境では存在しないため requireOptional で「無ければ null」にする
// （import 時点でアプリごとクラッシュするのを防ぐ）。
export type RemotePttModuleType = {
  /** リモートコマンド(イヤホンの再生/停止ボタン)の購読を開始 */
  start(): void;
  /** 購読を停止 */
  stop(): void;
  /** onToggle イベントの購読 */
  addListener(
    eventName: "onToggle",
    listener: (payload: Record<string, never>) => void,
  ): EventSubscription;
};

const RemotePtt = requireOptionalNativeModule<RemotePttModuleType>("RemotePtt");

export default RemotePtt;
