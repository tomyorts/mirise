import { useEffect } from "react";
import RemotePtt from "../modules/remote-ptt";

/**
 * キーボード型BLEリモコン（ページめくり器・シャッターリモコン等）のキー押下で onToggle を呼ぶ。
 * 画面がONの時だけ届く（ロック中はiOSがFace IDを要求するため使えない）。
 * イヤホンのボタンはここではなく、PushToTalk(PttChannel)が直接受け取る。
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
