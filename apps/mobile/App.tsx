import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { AudioSession, registerGlobals } from "@livekit/react-native";
import {
  AudioDeviceModule,
  AudioEngineMuteMode,
  audioDeviceModuleEvents,
} from "@livekit/react-native-webrtc";
import { ConnectionState, Room, RoomEvent, Track } from "livekit-client";
import { useRemotePtt } from "./hooks/useRemotePtt";
import BleButton, { type BleButtonStatus } from "./modules/ble-button";
import PttChannel from "./modules/ptt-channel";
import RemotePtt from "./modules/remote-ptt";

// 止め忘れ防止: トグルでONにしたら一定時間で自動OFF(ミリ秒)。
const AUTO_OFF_MS = 30_000;

// LiveKit(WebRTC)を使う前に一度だけグローバル初期化が必要。
// autoConfigureAudioSession(既定true)は、WebRTCの録音/再生ON・OFFに合わせて
// LiveKitライブラリ自身がAVAudioSessionを自動で構成・有効化してくれる仕組み。
// これに加えてアプリ側でも手動でAudioSession.startAudioSession()等を呼ぶと、
// 同じセッションに対して二重に有効化が走り、PTT起動時など際どいタイミングで
// "Session activation failed" を起こす原因になる。
// そのため既定の自動管理はオフにし、下のApp内useEffectで自前の
// エンジン連動ロジック(setupIOSAudioManagement相当)を登録する。
// (自前実装にした理由: ロック中はXcodeコンソールが見えず、ライブラリ内部の
// 動作がブラックボックスだったため。logDebugで各段階を画面に出すために
// ライブラリの実装を展開している)
registerGlobals({ autoConfigureAudioSession: false });

// 録音エンジンのミュートモードを「RestartEngine」に変更する。
// 実測統計で、既定モードではミュート解除後に録音エンジンの入力が再開されず
// (音量・送信パケットがウォームアップ時点の値で完全固定)、トラックを
// 作り直しても無音のままになることを確認した。RestartEngineモードは
// ミュート解除のたびにエンジン自体を止めて再起動するため、この
// 「入力が死んだまま」状態を毎回リセットできる。
if (Platform.OS === "ios") {
  AudioDeviceModule.setMuteMode(AudioEngineMuteMode.RestartEngine).catch((e) => {
    console.warn("setMuteMode failed", e);
  });
}

// Web版と同じトークン発行APIを再利用する(Vercelに公開済み)。
const TOKEN_ENDPOINT = "https://mirisevoicelink.vercel.app/api/token";

// ネイティブアプリ用のAPIキー(合言葉)。ビルド時に EXPO_PUBLIC_INTERCOM_KEY から埋め込む。
// Vercel 側の INTERCOM_API_KEY と同じ値にすること。
const INTERCOM_KEY = process.env.EXPO_PUBLIC_INTERCOM_KEY;

const ROOMS = [
  { id: "front", label: "受付" },
  { id: "clinic", label: "診療室" },
  { id: "surgery", label: "オペ" },
  { id: "sterilization", label: "滅菌" },
  { id: "all", label: "全体" },
];

export default function App() {
  const roomRef = useRef<Room | null>(null);
  const [identity, setIdentity] = useState("staff");
  const [roomId, setRoomId] = useState("clinic");
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [micOn, setMicOn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Phase B: ポケット/バックグラウンド送信(PushToTalkフレームワーク)。
  const [pttJoined, setPttJoined] = useState(false);
  const [pttBusy, setPttBusy] = useState(false);
  // BLEボタン(iTag型)の状態。ロック中でもGATT通知が届くため、押下でPTT送信をトグルする。
  const [bleStatus, setBleStatus] = useState<BleButtonStatus>(
    () => BleButton?.getStatus() ?? { registered: false, connected: false },
  );
  const [bleBusy, setBleBusy] = useState(false);
  // 最新値参照用(BLE押下ハンドラはイベント購読内から呼ばれるため、stateを直接見ると古い値になる)。
  const pttJoinedRef = useRef(false);
  const connectedRef = useRef(false);
  // BLEトグル送信の切り忘れ防止タイマー。
  const bleTxAutoOffRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // トグル判定を最新値で行うための参照 + 自動OFFタイマー。
  const micOnRef = useRef(false);
  const autoOffRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 進行中の接続を共有する(同時に呼ばれた側は同じ結果を待つ。押下の取りこぼし防止)。
  const connectPromiseRef = useRef<Promise<boolean> | null>(null);
  // PTT送信の意図(トークボタンを押している間true)。
  // 再接続完了時に既に離されていたら送信しない=ホットマイク(切り忘れ)防止の要。
  const txActiveRef = useRef(false);
  // PTTのシステム音声セッションが有効か(didActivate/didDeactivate)。
  const audioActiveRef = useRef(false);
  // JSハートビート。iOSがアプリを休止するとinterval が止まるので、
  // 大きな空白=休止明けと判定し、見かけ上「接続中」でも信用せず再接続する。
  const lastAliveRef = useRef(Date.now());
  // ロック中/バックグラウンドのPTT送信経路を後から確認するための診断ログ。
  // 画面が見えないタイミングの処理を、あとで(ロック解除後に)時系列で追える。
  const [debugLog, setDebugLog] = useState<string[]>([]);
  const logDebug = useCallback((msg: string) => {
    const t = new Date().toTimeString().slice(0, 8);
    setDebugLog((prev) => [...prev.slice(-24), `${t} ${msg}`]);
  }, []);

  // setupIOSAudioManagement相当を自前で実装し、各段階をlogDebugに出す。
  // WebRTCの録音/再生エンジンがON/OFFされる直前(willEnableEngine)・直後
  // (didDisableEngine)に呼ばれる。ここでAVAudioSessionのカテゴリ設定と
  // 有効化/無効化を行わないと、setMicrophoneEnabled自体は成功したように
  // 見えても実際には録音エンジンが起動しない。
  useEffect(() => {
    let audioEngineState = { isPlayoutEnabled: false, isRecordingEnabled: false };

    const handleEngineStateUpdate = async (newState: {
      isPlayoutEnabled: boolean;
      isRecordingEnabled: boolean;
    }) => {
      const oldState = audioEngineState;
      logDebug(
        `AudioEngine: 要求 playout=${newState.isPlayoutEnabled} recording=${newState.isRecordingEnabled}` +
          `(旧 playout=${oldState.isPlayoutEnabled} recording=${oldState.isRecordingEnabled})`,
      );
      try {
        if (
          !newState.isPlayoutEnabled &&
          !newState.isRecordingEnabled &&
          (oldState.isPlayoutEnabled || oldState.isRecordingEnabled)
        ) {
          logDebug("AudioEngine: stopAudioSession開始");
          await AudioSession.stopAudioSession();
          logDebug("AudioEngine: stopAudioSession完了");
        } else if (newState.isRecordingEnabled || newState.isPlayoutEnabled) {
          logDebug("AudioEngine: setAppleAudioConfiguration開始");
          await AudioSession.setAppleAudioConfiguration({
            audioCategory: "playAndRecord",
            audioMode: "voiceChat",
            audioCategoryOptions: ["allowBluetooth", "allowBluetoothA2DP"],
          });
          logDebug("AudioEngine: setAppleAudioConfiguration完了");
          if (!oldState.isPlayoutEnabled && !oldState.isRecordingEnabled) {
            logDebug("AudioEngine: startAudioSession開始");
            await AudioSession.startAudioSession();
            logDebug("AudioEngine: startAudioSession完了");
          }
        }
        audioEngineState = newState;
      } catch (e) {
        logDebug(`AudioEngine: エラー ${e instanceof Error ? e.message : String(e)}`);
        throw e;
      }
    };

    audioDeviceModuleEvents.setWillEnableEngineHandler(handleEngineStateUpdate);
    audioDeviceModuleEvents.setDidDisableEngineHandler(handleEngineStateUpdate);
    return () => {
      audioDeviceModuleEvents.setWillEnableEngineHandler(null);
      audioDeviceModuleEvents.setDidDisableEngineHandler(null);
    };
  }, [logDebug]);

  useEffect(() => {
    micOnRef.current = micOn;
  }, [micOn]);

  useEffect(() => {
    pttJoinedRef.current = pttJoined;
  }, [pttJoined]);

  useEffect(() => {
    connectedRef.current = connected;
  }, [connected]);

  useEffect(() => {
    const id = setInterval(() => {
      lastAliveRef.current = Date.now();
    }, 3000);
    return () => clearInterval(id);
  }, []);

  const clearAutoOff = useCallback(() => {
    if (autoOffRef.current) {
      clearTimeout(autoOffRef.current);
      autoOffRef.current = null;
    }
  }, []);

  const cleanup = useCallback(async () => {
    clearAutoOff();
    try {
      await roomRef.current?.disconnect();
    } catch {
      // noop
    }
    roomRef.current = null;
    // 音声セッションの有効化/無効化は registerGlobals の自動管理(WebRTCの録音/再生
    // ON・OFFに追従)に一本化しているため、ここでは手動で止めない
    // (手動でも止めると二重制御になり、PTT起動時などに活性化が失敗する原因になる)。
    setConnected(false);
    setMicOn(false);
  }, [clearAutoOff]);

  const connect = useCallback((): Promise<boolean> => {
    // 進行中の接続があれば同じ結果を待つ(PTT押下とUI操作が重なっても取りこぼさない)。
    if (connectPromiseRef.current) return connectPromiseRef.current;

    const attempt = (async (): Promise<boolean> => {
      const startedAt = Date.now();
      logDebug("connect: 開始");
      setError(null);
      setConnecting(true);
      try {
        await cleanup();
        logDebug("connect: cleanup完了");

        // イヤホン非接続時は受話口(プライベート)へ。スピーカーで患者に聞こえるのを防ぐ。
        // これは有効化(activate)ではなく経路の好み設定のみなので、自動管理と競合しない。
        try {
          await AudioSession.configureAudio({ ios: { defaultOutput: "earpiece" } });
        } catch (audioConfigError) {
          console.warn("audio route config skipped", audioConfigError);
        }

        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (INTERCOM_KEY) headers["x-intercom-key"] = INTERCOM_KEY;
        const response = await fetch(TOKEN_ENDPOINT, {
          method: "POST",
          headers,
          body: JSON.stringify({ identity: identity.trim() || "staff", room: roomId }),
        });
        const data = (await response.json()) as {
          token?: string;
          url?: string;
          error?: string;
        };
        if (!response.ok || !data.token || !data.url) {
          throw new Error(data.error ?? "トークン取得に失敗しました");
        }
        logDebug(`connect: トークン取得OK(+${Date.now() - startedAt}ms)`);

        const room = new Room();
        roomRef.current = room;
        room.on(RoomEvent.Disconnected, () => {
          logDebug("room: Disconnectedイベント");
          setConnected(false);
          setMicOn(false);
        });
        // サーバーが実際に計測した「自分の声の音量」。これが記録されれば、
        // 音声が確実にサーバーまで届いている証拠になる(ローカルの状態だけでは分からない)。
        room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
          const me = speakers.find((s) => s.sid === room.localParticipant.sid);
          if (me) {
            logDebug(`サーバー計測: 自分の音声を検出 level=${me.audioLevel.toFixed(3)}`);
          }
        });

        await room.connect(data.url, data.token);
        logDebug(`connect: room.connect完了(+${Date.now() - startedAt}ms)`);
        // マイクエンジンの「ウォームアップ」: setMicrophoneEnabledは初回のみ
        // createTracks()+publishTrack()という重い処理を行い、2回目以降は
        // track.mute()/unmute()という軽い処理になる(ライブラリの内部実装)。
        // 画面が確実に前面にあるこのタイミングで一度ON→OFFし、重い初回処理を
        // 済ませておく。これにより、ロック中のPTT操作は毎回軽いmute切替だけで
        // 済むようになり、ロック中に初回の重い処理が走って失敗するのを防ぐ。
        logDebug("connect: マイクウォームアップ開始");
        await room.localParticipant.setMicrophoneEnabled(true);
        await room.localParticipant.setMicrophoneEnabled(false);
        logDebug("connect: マイクウォームアップ完了");
        setConnected(true);
        setMicOn(false);
        lastAliveRef.current = Date.now();
        return true;
      } catch (e) {
        logDebug(`connect: エラー ${e instanceof Error ? e.message : String(e)}`);
        await cleanup();
        setError(e instanceof Error ? e.message : "接続に失敗しました");
        return false;
      } finally {
        setConnecting(false);
      }
    })().finally(() => {
      connectPromiseRef.current = null;
    });

    connectPromiseRef.current = attempt;
    return attempt;
  }, [cleanup, identity, roomId]);

  // マイクの実測統計(WebRTC統計)を診断ログに出す。「マイクが実際に音を拾えて
  // いるか(音量/累積エネルギー)」と「サーバーへパケットを送れているか」を
  // スマホ内部だけで確認できる。サーバー計測(ActiveSpeakersChanged)が出ない
  // 原因が『無音の録音』なのか『送信の失敗』なのかを切り分けるための計測。
  const logMicStats = useCallback(
    async (label: string) => {
      try {
        const room = roomRef.current;
        const pub = room?.localParticipant.getTrackPublication(Track.Source.Microphone);
        const track = pub?.track;
        if (!track) {
          logDebug(`統計(${label}): マイクトラックなし`);
          return;
        }
        const mst = track.mediaStreamTrack;
        logDebug(
          `統計(${label}): mute=${track.isMuted} track=${mst?.readyState}/${mst?.enabled ? "有効" : "無効"}`,
        );
        try {
          logDebug(
            `統計(${label}): エンジン=${AudioDeviceModule.isEngineRunning() ? "動作中" : "停止"} ` +
              `録音=${AudioDeviceModule.isRecording() ? "中" : "停止"} ` +
              `ADMミュート=${AudioDeviceModule.isMicrophoneMuted()}`,
          );
        } catch (e) {
          logDebug(`統計(${label}): エンジン状態取得不可 ${e instanceof Error ? e.message : String(e)}`);
        }
        const report = await track.getRTCStatsReport();
        if (!report) {
          logDebug(`統計(${label}): statsレポート取得不可`);
          return;
        }
        report.forEach((s) => {
          const stat = s as Record<string, unknown>;
          if (stat.type === "media-source") {
            const level = typeof stat.audioLevel === "number" ? stat.audioLevel.toFixed(4) : "?";
            const energy =
              typeof stat.totalAudioEnergy === "number" ? stat.totalAudioEnergy.toFixed(5) : "?";
            logDebug(`統計(${label}): マイク音量=${level} 累積=${energy}`);
          } else if (stat.type === "outbound-rtp") {
            logDebug(`統計(${label}): 送信packets=${stat.packetsSent ?? "?"}`);
          }
        });
      } catch (e) {
        logDebug(`統計(${label}): エラー ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [logDebug],
  );

  const setMic = useCallback(
    async (on: boolean) => {
      const room = roomRef.current;
      if (!room) {
        logDebug(`setMic(${on}): roomなしのため無視`);
        return;
      }
      try {
        // ミュート解除後の録音再開は、AudioDeviceModuleのミュートモードを
        // RestartEngine(アプリ起動時に設定)にすることでエンジンごと再起動させる。
        // トラックのrestartTrack()では直らないことを実測で確認済み
        // (トラック層ではなくエンジン層の問題のため)。
        await room.localParticipant.setMicrophoneEnabled(on);
        setMicOn(on);
        logDebug(`setMic(${on}): 完了`);
        if (on) {
          // 送信ONの2秒後に実測統計を自動で記録(押している間に計測される)。
          setTimeout(() => {
            void logMicStats("ON+2秒");
          }, 2000);
        }
        if (!on) clearAutoOff();
      } catch (e) {
        logDebug(`setMic(${on}): エラー ${e instanceof Error ? e.message : String(e)}`);
        setError(e instanceof Error ? e.message : "マイク操作に失敗しました");
      }
    },
    [clearAutoOff, logDebug, logMicStats],
  );

  // タップ/ハードボタン用トグル: ONにしたら AUTO_OFF_MS で自動OFF。
  const toggleMic = useCallback(() => {
    const next = !micOnRef.current;
    void setMic(next);
    clearAutoOff();
    if (next) {
      autoOffRef.current = setTimeout(() => {
        void setMic(false);
      }, AUTO_OFF_MS);
    }
  }, [setMic, clearAutoOff]);

  // 接続中だけイヤホンのハードボタンを購読する。
  useRemotePtt(toggleMic, connected);

  // PTTのシステム音声セッション(AVAudioSession)が実際に有効になるまで待つ。
  // 実機ログで、待ち時間が700msだと間に合わず(onActivateAudioが1秒以上後に
  // 発火)、activated=falseのままsetMic(true)してしまうケースを確認した。
  // その場合、iOS側の録音エンジンがまだ起動していない状態でLiveKitがミュート
  // 解除するため、APIレベルでは成功に見えてもサーバーには音声が届かない。
  // 最大3秒まで待ち、戻り値で成否を呼び出し元に伝える。
  const waitAudioActive = useCallback(async () => {
    for (let i = 0; i < 60; i++) {
      if (audioActiveRef.current) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  }, []);

  // PTT送信開始: Appleの設計では「待機中はアプリ休止 → 話す瞬間に起こされる」。
  // 休止中にLiveKitが切断されていたら、まず高速再接続してから送信ONにする。
  // 重要: 各段階で「まだ押されているか(txActiveRef)」を確認し、
  // 離された後にマイクONが発動する事故(ホットマイク)を防ぐ。
  const pttTransmitStart = useCallback(async () => {
    txActiveRef.current = true;

    // JSが休止していた直後は、見かけ上「接続中」でも実際は切れていることがある。
    // ハートビートの空白が大きければ接続を信用せず作り直す。
    const staleMs = Date.now() - lastAliveRef.current;
    const suspectedStale = staleMs > 8000;
    const room = roomRef.current;
    logDebug(
      `PTT開始要求: stale=${staleMs}ms room.state=${room?.state ?? "なし"} suspectedStale=${suspectedStale}`,
    );

    if (!suspectedStale && room && room.state === ConnectionState.Connected) {
      logDebug("PTT: 高速経路(再接続なし)");
      const activated = await waitAudioActive();
      logDebug(`PTT: audioActive待ち完了(activated=${activated})`);
      if (!txActiveRef.current) {
        logDebug("PTT: audioActive待ち中に離された");
        return;
      }
      if (!activated) {
        logDebug("PTT: 音声セッション未有効のため送信を中断(録音できない状態)");
        return;
      }
      await setMic(true);
      if (!txActiveRef.current) {
        logDebug("PTT: setMic中に離されたため再OFF");
        await setMic(false);
      }
      return;
    }

    logDebug("PTT: 再接続経路");
    const ok = await connect();
    logDebug(`PTT: connect結果=${ok}`);
    if (!ok || !txActiveRef.current) {
      logDebug(`PTT: 中断(ok=${ok} txActive=${txActiveRef.current})`);
      return;
    }
    const activated = await waitAudioActive();
    logDebug(`PTT: audioActive待ち完了(activated=${activated})`);
    if (!txActiveRef.current) {
      logDebug("PTT: audioActive待ち中に離された");
      return;
    }
    if (!activated) {
      logDebug("PTT: 音声セッション未有効のため送信を中断(録音できない状態)");
      return;
    }
    await setMic(true);
    if (!txActiveRef.current) {
      logDebug("PTT: setMic中に離されたため再OFF");
      await setMic(false);
    }
  }, [connect, logDebug, setMic, waitAudioActive]);

  const pttTransmitEnd = useCallback(async () => {
    logDebug("PTT: 終了要求");
    txActiveRef.current = false;
    await setMic(false);
  }, [logDebug, setMic]);

  // Phase B: PushToTalkフレームワークのイベントを購読。
  // システム(ロック画面/Dynamic Island)からの送信開始/停止で LiveKit のマイクをON/OFF。
  useEffect(() => {
    if (!PttChannel) return;
    const subs = [
      PttChannel.addListener("onJoin", () => {
        logDebug("PTTイベント: onJoin");
        setPttJoined(true);
      }),
      PttChannel.addListener("onLeave", () => {
        logDebug("PTTイベント: onLeave");
        setPttJoined(false);
      }),
      PttChannel.addListener("onBeginTransmitting", () => {
        logDebug("PTTイベント: onBeginTransmitting");
        void pttTransmitStart();
      }),
      PttChannel.addListener("onEndTransmitting", () => {
        logDebug("PTTイベント: onEndTransmitting");
        // BLEトグルの切り忘れ防止タイマーは、どの経路で終了しても解除する。
        if (bleTxAutoOffRef.current) {
          clearTimeout(bleTxAutoOffRef.current);
          bleTxAutoOffRef.current = null;
        }
        void pttTransmitEnd();
      }),
      PttChannel.addListener("onActivateAudio", () => {
        // 重要: AVAudioSessionを実際に有効化しているのはApple PushToTalk
        // フレームワーク(PTChannelManager)であり、WebRTC自身ではない。
        // 録音エンジン(オーディオユニット)を確実に起動させる処理
        // (RTCAudioSession.isAudioEnabled)はネイティブ側(PttChannelModule.swift
        // のdidActivate)で同期的に行うようにした。JS側からの
        // audioSessionDidActivate呼び出しは非同期でタイミングが遅れうる上、
        // 二重に有効化状態を操作すると不整合の原因になるため、ここでは
        // 状態フラグの更新とマイクON待ちの解除のみを行う。
        logDebug("PTTイベント: onActivateAudio");
        audioActiveRef.current = true;
        if (txActiveRef.current) {
          void setMic(true);
        }
      }),
      PttChannel.addListener("onDeactivateAudio", () => {
        logDebug("PTTイベント: onDeactivateAudio");
        audioActiveRef.current = false;
      }),
      PttChannel.addListener("onError", (payload) => {
        logDebug(`PTTイベント: onError ${JSON.stringify(payload)}`);
      }),
    ];
    return () => subs.forEach((s) => s?.remove());
  }, [logDebug, pttTransmitStart, pttTransmitEnd, setMic]);

  // PTTチャンネルに参加/退出。
  const joinPtt = useCallback(async () => {
    if (!PttChannel) {
      setError("この端末はPushToTalk未対応です(iOS16以上＋開発ビルドが必要)");
      return;
    }
    setPttBusy(true);
    try {
      logDebug("PTT参加: リクエスト開始");
      await PttChannel.join("MIRISE Intercom");
      // JSだけリロードされた直後などは、ネイティブ側は既に参加済みで
      // didJoinChannel(onJoinイベント)が再度発火しないことがある。
      // join()のリクエスト自体が成功した時点で画面も確実に更新する。
      logDebug("PTT参加: リクエスト成功(画面を更新)");
      setPttJoined(true);
    } catch (e) {
      logDebug(`PTT参加: エラー ${e instanceof Error ? e.message : String(e)}`);
      setError(e instanceof Error ? e.message : "PTT参加に失敗しました");
    } finally {
      setPttBusy(false);
    }
  }, [logDebug]);

  const leavePtt = useCallback(async () => {
    if (!PttChannel) return;
    setPttBusy(true);
    try {
      await PttChannel.leave();
      setPttJoined(false);
    } catch {
      // noop
    } finally {
      setPttBusy(false);
    }
  }, []);

  // 「話す」ホールド: 押している間だけ送信(PTKit経由)。
  const pttPressIn = useCallback(() => {
    void PttChannel?.beginTransmitting();
  }, []);
  const pttPressOut = useCallback(() => {
    void PttChannel?.endTransmitting();
  }, []);

  // BLEボタン(iTag型)押下: 送信ON/OFFのトグル。
  // PTT参加中はPTKit経由(ロック中でも動く)。未参加で通常接続中なら従来のトグル。
  const handleBlePress = useCallback(() => {
    if (pttJoinedRef.current && PttChannel) {
      if (txActiveRef.current) {
        logDebug("BLEボタン: 押下 → PTT送信停止");
        void PttChannel.endTransmitting();
      } else {
        logDebug("BLEボタン: 押下 → PTT送信開始");
        void PttChannel.beginTransmitting();
        // 切り忘れ防止: トグル開始からAUTO_OFF_MSで自動停止。
        if (bleTxAutoOffRef.current) clearTimeout(bleTxAutoOffRef.current);
        bleTxAutoOffRef.current = setTimeout(() => {
          logDebug("BLEボタン: 自動停止(切り忘れ防止)");
          void PttChannel?.endTransmitting();
        }, AUTO_OFF_MS);
      }
      return;
    }
    if (connectedRef.current) {
      logDebug("BLEボタン: 押下 → 送信トグル(通常経路)");
      toggleMic();
      return;
    }
    logDebug("BLEボタン: 押下(未接続のため無視)");
  }, [logDebug, toggleMic]);

  // BLEボタンのイベント購読 + 起動時の接続維持開始。
  useEffect(() => {
    if (!BleButton) return;
    BleButton.start();
    const subs = [
      BleButton.addListener("onPress", () => {
        handleBlePress();
      }),
      BleButton.addListener("onStateChanged", (payload) => {
        logDebug(`BLEボタン: ${payload.state} ${payload.detail}`);
        setBleStatus(BleButton?.getStatus() ?? { registered: false, connected: false });
      }),
    ];
    return () => subs.forEach((s) => s?.remove());
  }, [handleBlePress, logDebug]);

  // BLEボタンの登録(初期設定)。近くのiTag型ボタンを探して保存する。
  const setupBleButton = useCallback(async () => {
    if (!BleButton) {
      setError("このビルドはBLEボタン未対応です(再ビルドが必要)");
      return;
    }
    setBleBusy(true);
    setError(null);
    try {
      logDebug("BLEボタン: 登録スキャン開始");
      const result = await BleButton.startSetup();
      logDebug(`BLEボタン: 登録成功 ${result.name}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logDebug(`BLEボタン: 登録失敗 ${msg}`);
      setError(msg);
    } finally {
      setBleBusy(false);
      setBleStatus(BleButton?.getStatus() ?? { registered: false, connected: false });
    }
  }, [logDebug]);

  const unregisterBleButton = useCallback(() => {
    BleButton?.unregister();
    setBleStatus(BleButton?.getStatus() ?? { registered: false, connected: false });
  }, []);

  useEffect(() => {
    return () => {
      void cleanup();
    };
  }, [cleanup]);

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.brand}>MIRISE WELLMEDICAL GROUP</Text>
        <Text style={styles.title}>院内音声インカム</Text>

        {micOn ? (
          <View style={styles.liveBanner}>
            <Text style={styles.liveText}>🔴 送信中（マイクON）— 終わったら離す/停止</Text>
          </View>
        ) : null}

        <View style={styles.card}>
          <Text style={styles.cardLabel}>スタッフ名</Text>
          <TextInput
            style={styles.input}
            value={identity}
            onChangeText={setIdentity}
            placeholder="例: Dr.Sato / DH Tanaka"
            editable={!connected && !connecting}
            autoCapitalize="none"
          />

          <Text style={[styles.cardLabel, { marginTop: 16 }]}>参加ルーム</Text>
          <View style={styles.roomRow}>
            {ROOMS.map((room) => {
              const selected = room.id === roomId;
              return (
                <Pressable
                  key={room.id}
                  onPress={() => !connected && setRoomId(room.id)}
                  style={[styles.roomChip, selected && styles.roomChipOn]}
                >
                  <Text style={[styles.roomChipText, selected && styles.roomChipTextOn]}>
                    {room.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {!connected ? (
            <Pressable
              style={[styles.primary, connecting && styles.disabled]}
              onPress={() => void connect()}
              disabled={connecting}
            >
              <Text style={styles.primaryText}>{connecting ? "接続中..." : "接続する"}</Text>
            </Pressable>
          ) : (
            <Pressable style={styles.secondary} onPress={() => void cleanup()}>
              <Text style={styles.secondaryText}>切断する</Text>
            </Pressable>
          )}
        </View>

        {connected ? (
          <View style={styles.card}>
            <Text style={styles.status}>接続中</Text>

            <Pressable
              style={[styles.ptt, micOn && styles.pttOn]}
              onPressIn={() => void setMic(true)}
              onPressOut={() => void setMic(false)}
            >
              <Text style={styles.pttText}>押して話す</Text>
            </Pressable>

            <Pressable
              style={[styles.toggle, micOn && styles.toggleOn]}
              onPress={toggleMic}
            >
              <Text style={[styles.toggleText, micOn && styles.toggleTextOn]}>
                {micOn ? "■ 送信中 — タップで停止" : "● タップで送信開始 / 停止"}
              </Text>
            </Pressable>

            <Text style={styles.hint}>
              「押して話す」を押している間だけ声が流れます。常時ONにはなりません。
              🔘 キーボード型BLEリモコン（シャッター・ページめくり器など）でも送信ON/OFF
              （トグル）できます（画面ONのときのみ。ロック中はiTag型を使用）。
              切り忘れ防止のため、送信は約30秒で自動停止します。
              診療中は患者情報を言わず、チェア番号やセット名で運用してください。
            </Text>
          </View>
        ) : null}

        {connected ? (
          <View style={styles.card}>
            <Text style={styles.cardLabel}>📱 ポケット送信（実験・Phase B）</Text>
            <Text style={[styles.hint, { color: PttChannel ? "#0f8f4f" : "#c62030" }]}>
              PTTネイティブ: {PttChannel ? "有効（読み込み済み）" : "無効（未読み込み）"}
              {"\n"}RemotePtt: {RemotePtt ? "有効" : "無効"} / ビルドタグ:{" "}
              {RemotePtt?.buildTag ?? "（旧ビルド）"} / iOS {String(Platform.Version)}（診断用）
            </Text>
            <Text style={styles.hint}>
              使い方: 「PTTを有効化」→ 画面ONのときは下の「話す」ボタン。
              {"\n"}🔒 ロック中は、画面上部の【青いPTT表示（Dynamic Island）】をタップ →
              システムの「トーク」ボタンを長押しで話せます。切断されていても自動で再接続します
              （繋がるまで1〜3秒かかるので、押してひと呼吸おいてから話し始めてください）。
            </Text>

            {!pttJoined ? (
              <Pressable
                style={[styles.primary, pttBusy && styles.disabled]}
                onPress={() => void joinPtt()}
                disabled={pttBusy}
              >
                <Text style={styles.primaryText}>
                  {pttBusy ? "準備中..." : "PTTを有効化（参加）"}
                </Text>
              </Pressable>
            ) : (
              <>
                <Pressable
                  style={[styles.ptt, micOn && styles.pttOn]}
                  onPressIn={pttPressIn}
                  onPressOut={pttPressOut}
                >
                  <Text style={styles.pttText}>話す（PTT）</Text>
                </Pressable>
                <Pressable style={styles.secondary} onPress={() => void leavePtt()}>
                  <Text style={styles.secondaryText}>PTTを無効化（退出）</Text>
                </Pressable>
              </>
            )}

            <Text style={[styles.cardLabel, { marginTop: 16 }]}>
              🔘 BLEボタン（iTag型・ロック中もOK）
            </Text>
            <Text
              style={[
                styles.hint,
                { color: bleStatus.connected ? "#0f8f4f" : bleStatus.registered ? "#b76e00" : "#5a6478" },
              ]}
            >
              {BleButton
                ? bleStatus.registered
                  ? `${bleStatus.name ?? "BLEボタン"}: ${bleStatus.connected ? "接続中 ✅" : "未接続（再接続待ち）"}`
                  : "未登録"
                : "このビルドは未対応（再ビルドが必要）"}
            </Text>
            <Text style={styles.hint}>
              iTag型（紛失防止タグ）のボタンを登録すると、押すたびに送信ON/OFFできます。
              🔒 画面ロック中・ポケットの中でも動作します（切り忘れ防止のため約30秒で自動停止）。
              ※シャッターリモコン等のキーボード型はロック中は使えません（iOSの仕様）。
            </Text>
            {!bleStatus.registered ? (
              <Pressable
                style={[styles.secondary, bleBusy && styles.disabled]}
                onPress={() => void setupBleButton()}
                disabled={bleBusy}
              >
                <Text style={styles.secondaryText}>
                  {bleBusy ? "検索中...（ボタンを1回押してください）" : "BLEボタンを登録"}
                </Text>
              </Pressable>
            ) : (
              <Pressable style={styles.secondary} onPress={unregisterBleButton}>
                <Text style={styles.secondaryText}>BLEボタンの登録を解除</Text>
              </Pressable>
            )}

            <Text style={[styles.cardLabel, { marginTop: 16 }]}>
              🪵 診断ログ（ロック中の動作確認用・新しい順）
            </Text>
            <View style={styles.debugLogBox}>
              {debugLog.length === 0 ? (
                <Text style={styles.debugLogLine}>（まだログがありません）</Text>
              ) : (
                [...debugLog].reverse().map((line, i) => (
                  <Text key={i} style={styles.debugLogLine}>
                    {line}
                  </Text>
                ))
              )}
            </View>
          </View>
        ) : null}

        {error ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#f5f7fb" },
  container: { padding: 20, paddingTop: 36 },
  debugLogBox: {
    backgroundColor: "#10182b",
    borderRadius: 10,
    padding: 10,
    maxHeight: 220,
  },
  debugLogLine: {
    color: "#8fe3a0",
    fontSize: 11,
    fontFamily: "Menlo",
    marginBottom: 2,
  },
  brand: {
    fontSize: 12,
    letterSpacing: 1.5,
    color: "#8a8473",
    fontWeight: "600",
    marginBottom: 4,
  },
  title: { fontSize: 28, fontWeight: "800", color: "#1f2f58", marginBottom: 16 },
  liveBanner: {
    backgroundColor: "#c62030",
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 14,
  },
  liveText: { color: "#ffffff", fontWeight: "700", textAlign: "center" },
  card: {
    backgroundColor: "#ffffff",
    borderRadius: 20,
    padding: 18,
    borderWidth: 1,
    borderColor: "#e3e8f0",
    marginBottom: 16,
  },
  cardLabel: {
    fontSize: 12,
    letterSpacing: 1,
    color: "#667085",
    marginBottom: 8,
    textTransform: "uppercase",
  },
  input: {
    borderWidth: 1,
    borderColor: "#d6ddea",
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 14,
    fontSize: 16,
    color: "#172033",
    backgroundColor: "#ffffff",
  },
  roomRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  roomChip: {
    backgroundColor: "#edf1f8",
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  roomChipOn: { backgroundColor: "#27354f" },
  roomChipText: { color: "#27354f", fontWeight: "600" },
  roomChipTextOn: { color: "#ffffff" },
  primary: {
    backgroundColor: "#1f2f58",
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: "center",
    marginTop: 18,
  },
  primaryText: { color: "#ffffff", fontSize: 17, fontWeight: "700" },
  disabled: { opacity: 0.5 },
  secondary: {
    backgroundColor: "#e6eaf2",
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: "center",
    marginTop: 18,
  },
  secondaryText: { color: "#1f2f58", fontSize: 17, fontWeight: "700" },
  status: { color: "#0f6d3b", fontWeight: "700", marginBottom: 14 },
  ptt: {
    backgroundColor: "#263b69",
    borderRadius: 28,
    minHeight: 140,
    alignItems: "center",
    justifyContent: "center",
  },
  pttOn: { backgroundColor: "#0f8f4f" },
  pttText: { color: "#ffffff", fontSize: 34, fontWeight: "800" },
  toggle: {
    marginTop: 12,
    borderRadius: 16,
    paddingVertical: 16,
    alignItems: "center",
    backgroundColor: "#e6eaf2",
    borderWidth: 2,
    borderColor: "#c7d0e4",
  },
  toggleOn: { backgroundColor: "#c62030", borderColor: "#a20d1a" },
  toggleText: { color: "#1f2f58", fontSize: 17, fontWeight: "700" },
  toggleTextOn: { color: "#ffffff" },
  hint: { marginTop: 14, color: "#667085", lineHeight: 20, fontSize: 13 },
  errorBox: {
    backgroundColor: "#fff0f0",
    borderColor: "#ffd2d6",
    borderWidth: 1,
    borderRadius: 16,
    padding: 14,
  },
  errorText: { color: "#a20d1a" },
});
