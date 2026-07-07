import { useEffect } from "react";
import RemotePtt from "../modules/remote-ptt";

/**
 * イヤホン等のハードボタン（再生/停止）押下で onToggle を呼ぶ。
 * enabled のときだけ購読する（＝LiveKit接続中だけ有効化する想定）。
 * ネイティブモジュールが無い環境（Expo Go 等）では何もしない。
 */
export function useRemotePtt(onToggle: () => void, enabled: boolean) {
  useEffect(() => {
    const mod = RemotePtt;
    if (!enabled || !mod) return;

    try {
      mod.start();
    } catch {
      return;
    }

    const sub = mod.addListener("onToggle", () => onToggle());

    return () => {
      try {
        sub?.remove();
      } catch {
        // noop
      }
      try {
        mod.stop();
      } catch {
        // noop
      }
    };
  }, [enabled, onToggle]);
}
