import { requireOptionalNativeModule, type EventSubscription } from "expo-modules-core";

// ネイティブモジュール本体。
// Expo Go や未ビルド環境では存在しないため requireOptional で「無ければ null」にする
// （import 時点でアプリごとクラッシュするのを防ぐ）。
export type RemotePttModuleType = {
  /** どのネイティブビルドが入っているかを判別するタグ */
  buildTag?: string;
  /** リモートコマンド(イヤホンの再生/停止ボタン)の購読を開始 */
  start(): void;
  /** 購読を停止 */
  stop(): void;
  /**
   * イヤホンの再生/一時停止ボタンを送信トグルとして使うか(旧ビルドには無い)。
   * 有効にするとロック画面のPTTトークボタンは表示されなくなる。
   */
  setMediaButtonEnabled?: (enabled: boolean) => void;
  /** イヤホンボタンが現在有効か(旧ビルドには無い) */
  isMediaButtonEnabled?: () => boolean;
  /** onToggle イベントの購読 */
  addListener(
    eventName: "onToggle",
    listener: (payload: { source?: string }) => void,
  ): EventSubscription;
};

const RemotePtt = requireOptionalNativeModule<RemotePttModuleType>("RemotePtt");

export default RemotePtt;
