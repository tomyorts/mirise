import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AppState,
  Linking,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  Settings,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  AudioSession,
  registerGlobals,
  type AppleAudioCategoryOption,
} from "@livekit/react-native";
import {
  AudioDeviceModule,
  AudioEngineMuteMode,
  audioDeviceModuleEvents,
} from "@livekit/react-native-webrtc";
import { ConnectionState, DisconnectReason, Room, RoomEvent, Track } from "livekit-client";
import { useRemotePtt } from "./hooks/useRemotePtt";
import BleButton, { type BleButtonStatus } from "./modules/ble-button";
import PttChannel, { PTT_SOURCE } from "./modules/ptt-channel";
import RemotePtt from "./modules/remote-ptt";

// 止め忘れ防止: トグルでONにしたら一定時間で自動OFF(ミリ秒)。
const AUTO_OFF_MS = 30_000;
// イヤホンのボタンで始めた送信の自動停止(ミリ秒)。イヤホンは「1回押すと開始、
// もう1回で終了」のトグル動作なので、押し忘れ・ポケットの中での誤押下・機種に
// よる再生/停止ボタンの誤反応で、マイクが開きっぱなしになり得る。診療室で患者の
// 会話が流れ続ける事故を防ぐため、必ず上限を設ける。話し終える余裕を持たせて
// BLEボタンより少し長めにしている。
const EARPHONE_AUTO_OFF_MS = 45_000;

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

// ---- 端末内に保存する設定(スタッフ名・ルーム・端末ID) ----
// iOSの NSUserDefaults を使う React Native 標準の Settings を利用する(追加の
// ライブラリもネイティブ再ビルドも不要)。読み込みが同期的なので、iOSがアプリを
// バックグラウンドで再起動した直後(イヤホンのボタン押下で起こされた時など)でも、
// 最初の描画の時点で正しい名前・ルームが揃っている。これが無いと、再起動後の
// 自動再接続が既定の名前・既定のルームで行われ、別の部屋に声が流れてしまう。
// ※Android版では Settings が使えないため、Android対応時に置き換えること。
const SETTINGS_KEYS = {
  displayName: "mirise.displayName",
  room: "mirise.room",
  deviceTag: "mirise.deviceTag",
  speaker: "mirise.speaker",
} as const;

function readSetting(key: string): string | null {
  if (Platform.OS !== "ios") return null;
  try {
    const value = Settings.get(key);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

function writeSettings(values: Record<string, string>) {
  if (Platform.OS !== "ios") return;
  try {
    Settings.set(values);
  } catch {
    // 保存できなくても動作は続ける(次回の起動時に再入力になるだけ)。
  }
}

// 端末ごとに固定のランダムな識別子(英小文字+数字6桁)。初回に作って保存する。
let cachedDeviceTag: string | null = null;
function getDeviceTag(): string {
  if (cachedDeviceTag) return cachedDeviceTag;
  const saved = readSetting(SETTINGS_KEYS.deviceTag);
  if (saved && /^[a-z0-9]{6}$/.test(saved)) {
    cachedDeviceTag = saved;
    return saved;
  }
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let tag = "";
  for (let i = 0; i < 6; i++) tag += chars[Math.floor(Math.random() * chars.length)];
  writeSettings({ [SETTINGS_KEYS.deviceTag]: tag });
  cachedDeviceTag = tag;
  return tag;
}

// LiveKit の identity(参加者の内部ID)を作る。
// 問題: LiveKit は同じ identity で2台目が入ると、先にいた方を強制退出させる。
// 以前は全端末の既定名が "staff" だったため、端末同士が蹴り合っていた
// (実機で "Received leave request while trying to (re)connect" を確認)。
// 対策: identity は「名前+端末ごとの固定ID」で必ず一意にし、画面に出す名前は
// 別に name として送る。同じ名前のスタッフが複数いても衝突しない。
// 生成される identity はトークンAPIの現行の文字種チェック
// (/^[\p{L}\p{N}_\-. ]+$/u、2〜64文字)を必ず通るので、APIが未更新でも動く
// (その場合は画面上の名前に端末IDが付いて見えるだけ)。
let IDENTITY_DISALLOWED: RegExp;
try {
  IDENTITY_DISALLOWED = new RegExp("[^\\p{L}\\p{N}_\\-.]", "gu");
} catch {
  // Unicodeプロパティ指定が使えない環境向けの保険(英数字・かな・カナ・漢字のみ残す)。
  IDENTITY_DISALLOWED =
    /[^A-Za-z0-9_\-.\u3041-\u3096\u30a1-\u30fa\u30fc\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;
}

function buildIdentity(displayName: string, tag: string): string {
  let base = displayName;
  try {
    base = base.normalize("NFKC");
  } catch {
    // normalize 非対応でもそのまま続行
  }
  base = base
    .trim()
    .replace(/[\s\u3000]+/g, "_")
    .replace(IDENTITY_DISALLOWED, "")
    .slice(0, 40);
  return `${base || "staff"}-${tag}`;
}

// 画面表示用の名前。新しいトークンAPIでは name がそのまま表示名になる。
// 旧APIでは name が identity と同じ("富田-a3f2c9")になるので、末尾の端末IDを外す。
function displayNameOf(p: { name?: string; identity: string }): string {
  if (p.name && p.name !== p.identity) return p.name;
  return p.identity.replace(/-[a-z0-9]{6}$/, "");
}

const DISPLAY_NAME_MAX = 32;

// 画面上部の状態表示の色。
const STATUS_COLORS = {
  idle: "#98a2b3",
  ok: "#0f8f4f",
  busy: "#d19a00",
  warn: "#e06a00",
  live: "#c62030",
} as const;

// エラーを診断ログ用の文字列にする。react-native-webrtc のエラーは Error の
// インスタンスではないことがあり、String(e) だと "[object Object]" になって
// 原因が分からなくなるため、name/message を取り出す。
function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object") {
    const o = e as { name?: unknown; message?: unknown };
    const parts = [o.name, o.message].filter(
      (x): x is string => typeof x === "string" && x.length > 0,
    );
    if (parts.length) return parts.join(": ");
    try {
      return JSON.stringify(e);
    } catch {
      // noop
    }
  }
  return String(e);
}

// 画面に出すエラー。action=settings なら「設定を開く」ボタンを添える。
type AppError = { message: string; action?: "settings" };

// 技術的なエラーを、スタッフが自分で対処できる言葉に言い換える。
// 元のエラー内容は診断ログ(logDebug)の方に残す。
function toFriendlyError(e: unknown, fallback: string): AppError {
  const o = (e && typeof e === "object" ? e : {}) as {
    name?: unknown;
    status?: unknown;
  };
  const name = typeof o.name === "string" ? o.name : "";
  const status = typeof o.status === "number" ? o.status : undefined;
  const msg = errMsg(e);
  if (
    name === "NotAllowedError" ||
    name === "SecurityError" ||
    /permission|not ?allowed|denied/i.test(msg)
  ) {
    return {
      message:
        "マイクの使用が許可されていません。「設定を開く」→「マイク」をオンにしてから、もう一度お試しください",
      action: "settings",
    };
  }
  if (name === "AbortError" || /^aborted?$/i.test(msg)) {
    return {
      message:
        "サーバーから応答がありません。電波の弱い場所か、Wi-Fiがインターネットに繋がっていない可能性があります。場所を変えてもう一度お試しください",
    };
  }
  if (status === 401) {
    return {
      message: "接続キーが一致しません。アプリが古い可能性があります。管理者に確認してください",
    };
  }
  if (status === 429) {
    return { message: "接続が集中しています。少し待ってからもう一度お試しください" };
  }
  if (status !== undefined && status >= 500) {
    return { message: "サーバーで問題が起きています。少し待ってからもう一度お試しください" };
  }
  if (status !== undefined && status >= 400) {
    // 入力内容の誤り(名前の文字種など)。サーバーの日本語メッセージをそのまま出す。
    return { message: msg };
  }
  if (/network request failed|network error|internet connection/i.test(msg)) {
    return {
      message: "インターネットに接続できません。Wi-Fiまたはモバイル通信を確認してください",
    };
  }
  if (name === "ConnectionError" || /could not establish|signal connection|websocket/i.test(msg)) {
    return {
      message: "音声サーバーに接続できませんでした。電波の良い場所でもう一度お試しください",
    };
  }
  return { message: `${fallback}（${msg}）` };
}

// ネイティブ側のPTTチャンネル参加状態(JSの状態より信頼できる。iOSがアプリを
// 終了→PushToTalkがチャンネルを復元した直後は、JS側だけが未参加に戻っている)。
function nativePttJoined(): boolean {
  try {
    return typeof PttChannel?.getState === "function" ? PttChannel.getState().joined : false;
  } catch {
    return false;
  }
}

// トークン取得の上限時間。院内Wi-Fiが「繋がっているのにインターネットに出られ
// ない」状態や、Wi-Fi↔LTEの切替中は、上限が無いとiOS既定の60秒待ち続け、
// その間のイヤホン押下がすべて「送信中なのに無音」になる。
const TOKEN_TIMEOUT_MS = 8_000;
// イヤホン押下からの再接続を待つ上限。超えたらこの送信は諦めて「送信中」表示を
// 消す(接続自体は裏で続けてよい。繋がれば受信はできる)。
const RECONNECT_TIMEOUT_MS = 12_000;

async function fetchToken(body: {
  identity: string;
  name: string;
  room: string;
}): Promise<{ token: string; url: string }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (INTERCOM_KEY) headers["x-intercom-key"] = INTERCOM_KEY;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOKEN_TIMEOUT_MS);
  try {
    const response = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let data: { token?: string; url?: string; error?: string } = {};
    try {
      data = JSON.parse(text) as typeof data;
    } catch {
      // サーバーがHTMLのエラーページを返した場合など。下でHTTPステータスと共に扱う。
    }
    if (!response.ok || !data.token || !data.url) {
      const err = new Error(
        data.error ?? `トークン取得に失敗しました(HTTP ${response.status})`,
      ) as Error & { status?: number };
      err.status = response.status;
      throw err;
    }
    return { token: data.token, url: data.url };
  } finally {
    clearTimeout(timer);
  }
}

// 音声セッションのカテゴリ設定。失敗しても例外は投げない(throwすると送信自体が
// 始まらなくなるため)。
// - voiceChatモードは通話用(HFP)を前提とするため、音楽再生用の
//   allowBluetoothA2DP を一緒に渡すとBluetooth機器接続時に OSStatus -50
//   (パラメータ不正)で拒否される。HFPはvoiceChatが暗黙に有効化するので
//   allowBluetooth だけで足りる。A2DP は絶対に足さないこと。
// - defaultToSpeaker は「イヤホンが繋がっていない時だけ」スピーカーから鳴らす
//   指定。これが無いと voiceChat の既定は受話口(耳に当てる小さいスピーカー)に
//   なり、ポケットの中では聞こえない。イヤホン接続中はイヤホンが優先される。
// - PushToTalkフレームワークが音声セッションを保持している間は、アプリ側からの
//   カテゴリ変更が拒否されることがある。その場合セッションは既にPTT側で構成済み
//   なので、スキップして続行する。
async function applyAudioCategory(preferSpeaker: boolean, log: (msg: string) => void) {
  const attempts: AppleAudioCategoryOption[][] = preferSpeaker
    ? [["allowBluetooth", "defaultToSpeaker"], ["allowBluetooth"]]
    : [["allowBluetooth"]];
  for (const options of attempts) {
    try {
      await AudioSession.setAppleAudioConfiguration({
        audioCategory: "playAndRecord",
        audioMode: "voiceChat",
        audioCategoryOptions: options,
      });
      log(`AudioEngine: カテゴリ設定完了(${options.join("+")})`);
      return;
    } catch (configError) {
      log(`AudioEngine: カテゴリ設定をスキップ(${options.join("+")}: ${errMsg(configError)})`);
    }
  }
}

export default function App() {
  const roomRef = useRef<Room | null>(null);
  // スタッフ名(画面表示用)とルーム。前回の値を端末から復元する。
  const [identity, setIdentity] = useState(() => readSetting(SETTINGS_KEYS.displayName) ?? "");
  const [roomId, setRoomId] = useState(() => {
    const saved = readSetting(SETTINGS_KEYS.room);
    return saved && ROOMS.some((r) => r.id === saved) ? saved : "clinic";
  });
  // connect() はイヤホン押下の再接続経路からも呼ばれるため、名前・ルームは
  // state ではなく ref から読む(state に依存すると入力のたびに connect が
  // 作り直され、PTTのイベント購読まで張り直しになる)。
  const identityRef = useRef(identity);
  const roomIdRef = useRef(roomId);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [micOn, setMicOn] = useState(false);
  const [error, setErrorState] = useState<AppError | null>(null);
  // 画面のエラー表示。null で消す。identity が変わらないので依存配列に入れても
  // 各コールバックが作り直されることはない。
  const setError = useCallback((message: string | null, action?: AppError["action"]) => {
    setErrorState(message ? { message, action } : null);
  }, []);
  const showError = useCallback((e: unknown, fallback: string) => {
    const friendly = toFriendlyError(e, fallback);
    setErrorState(friendly);
  }, []);
  // イヤホンが無い時の受信音をスピーカーで鳴らすか(true)、受話口で鳴らすか(false)。
  // 既定はスピーカー: 私物スマホをポケットに入れたままでも聞こえるようにするため。
  // Bluetooth/有線イヤホンが繋がっている時は、どちらの設定でもイヤホンから鳴る。
  const [speakerOn, setSpeakerOn] = useState(() => readSetting(SETTINGS_KEYS.speaker) !== "0");
  // エンジン連動の処理(再実行しない useEffect)から最新の設定を読むための ref。
  const speakerOnRef = useRef(speakerOn);
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
  // 切り忘れ防止タイマー(BLEボタン起点とイヤホンのボタン起点の送信に使う)。
  const bleTxAutoOffRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 画面の「話す」ボタンを今押しているか。送信開始の確定(onBeginTransmitting)は
  // 押してから1秒以上遅れて届くことがあり、その間に指を離していた場合は
  // 確定した瞬間に即終了させる(誰も押していないのにマイクが開く事故の防止)。
  const screenHoldRef = useRef(false);
  // 勤務中(=接続を保ちたい)か。電波が途切れて切断された時に、画面を開いたら
  // 自動で再接続するかどうかの判断に使う。退勤で false に戻る。
  const wantConnectedRef = useRef(false);
  // 送信開始処理の世代番号。再接続がタイムアウトした時に、その後に始まった
  // 新しい送信まで誤って止めないようにする。
  const txGenRef = useRef(0);
  // BLEトグルの「意図」。txActiveRefは送信開始イベントが往復してから立つため、
  // 開始確定前の2度目の押下を「停止」と判定するにはこちらが必要
  // (これが無いと、素早い2度押しが停止でなく再開始になる=止めたつもりで止まらない)。
  const bleTxIntentRef = useRef(false);
  // 今回の送信がBLEトグル起点か(自動停止タイマーを張るのはこの場合のみ)。
  const bleToggleInitiatedRef = useRef(false);
  // BLEボタンの状態詳細(登録フローの案内文などを画面に出す)。
  const [bleDetail, setBleDetail] = useState<string | null>(null);
  // 画面の「押して話す」ボタンを押している間 true(表示用)。
  const [holding, setHolding] = useState(false);
  // 押した時にどちらの経路で送信を始めたか。離した時に同じ経路で止めるために覚えておく
  // (押している間に参加状態が変わっても、開始と停止の経路が食い違わないようにする)。
  const holdPathRef = useRef<"ptt" | "direct" | null>(null);
  // 今話している他のスタッフの名前(サーバーの音声検出による)。
  const [remoteSpeakers, setRemoteSpeakers] = useState<string[]>([]);
  // 「詳細設定・診断」を開いているか。
  const [advancedOpen, setAdvancedOpen] = useState(false);
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
          // 失敗してもthrowしない(内部で握りつぶしてログだけ残す)。
          await applyAudioCategory(speakerOnRef.current, logDebug);
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
    identityRef.current = identity;
  }, [identity]);

  useEffect(() => {
    roomIdRef.current = roomId;
  }, [roomId]);

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
    setRemoteSpeakers([]);
  }, [clearAutoOff]);

  const connect = useCallback((): Promise<boolean> => {
    // 進行中の接続があれば同じ結果を待つ(PTT押下とUI操作が重なっても取りこぼさない)。
    if (connectPromiseRef.current) return connectPromiseRef.current;

    const attempt = (async (): Promise<boolean> => {
      const startedAt = Date.now();
      const displayName = identityRef.current.trim();
      const room = roomIdRef.current;
      if (displayName.length === 0) {
        logDebug("connect: スタッフ名が未入力のため中止");
        setError("スタッフ名を入力してください");
        return false;
      }
      if (displayName.length > DISPLAY_NAME_MAX) {
        setError(`スタッフ名は${DISPLAY_NAME_MAX}文字以内で入力してください`);
        return false;
      }
      logDebug(`connect: 開始(${displayName} / ${room})`);
      setError(null);
      setConnecting(true);
      try {
        await cleanup();
        logDebug("connect: cleanup完了");

        // 受信音の出力先。Bluetooth/有線イヤホンが繋がっていればそちらが自動で
        // 優先されるため、ここで指定するのは「イヤホンが無いときの既定」だけ。
        // speakerにする理由: 私物スマホをポケットに入れたまま使う運用では、
        // 受話口(耳に当てる小さいスピーカー)だと物理的に聞こえないため。
        // 患者の前で静かにしたい場合は画面の「受話口(静音)」ボタンで切り替える。
        // これは有効化(activate)ではなく経路の好み設定のみなので、自動管理と競合しない。
        try {
          await AudioSession.configureAudio({ ios: { defaultOutput: "speaker" } });
        } catch (audioConfigError) {
          console.warn("audio route config skipped", audioConfigError);
        }

        const data = await fetchToken({
          identity: buildIdentity(displayName, getDeviceTag()),
          name: displayName,
          room,
        });
        logDebug(`connect: トークン取得OK(+${Date.now() - startedAt}ms)`);

        const lkRoom = new Room();
        roomRef.current = lkRoom;
        // 一度でも接続が確立したか。確立前の失敗で自動再接続を繰り返さないために使う。
        let established = false;
        lkRoom.on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
          // 作り直し前の古い接続から遅れて届いたイベントは無視する。
          if (roomRef.current !== lkRoom) return;
          const reasonName =
            reason === undefined ? "不明" : (DisconnectReason[reason] ?? String(reason));
          logDebug(`room: 切断(${reasonName})`);
          setConnected(false);
          setMicOn(false);
          setRemoteSpeakers([]);
          // 自分で切った場合(退勤・再接続のための作り直し)は何も表示しない。
          if (reason === DisconnectReason.CLIENT_INITIATED) return;
          if (reason === DisconnectReason.DUPLICATE_IDENTITY) {
            // 同じIDの別の接続に置き換えられた。自動再接続すると取り合いになる。
            wantConnectedRef.current = false;
            setError("同じ端末の別の接続に切り替わったため切断されました。「再接続する」を押してください");
            return;
          }
          // LiveKitが自動再接続を諦めた(レントゲン室など電波の届かない場所に
          // 1分以上いた等)。以前は何も表示せず、受信が止まったままになっていた。
          setError("通信が途切れました。画面を開くか、イヤホンのボタンを押すと自動で再接続します");
          // 画面を見ている最中に切れた場合は「前面に戻る」きっかけが無いので、
          // ここで1回だけ自動で再接続を試す(失敗したらエラー表示のまま、ボタンで再試行)。
          if (established && wantConnectedRef.current && AppState.currentState === "active") {
            setTimeout(() => {
              const current = roomRef.current;
              const stillDown = !current || current.state === ConnectionState.Disconnected;
              if (
                wantConnectedRef.current &&
                stillDown &&
                !connectPromiseRef.current &&
                AppState.currentState === "active"
              ) {
                logDebug("切断後: 画面表示中のため自動で再接続");
                void connect();
              }
            }, 3000);
          }
        });
        // サーバーが実際に計測した「自分の声の音量」。これが記録されれば、
        // 音声が確実にサーバーまで届いている証拠になる(ローカルの状態だけでは分からない)。
        // あわせて、今話している他のスタッフの名前を画面に出す。
        lkRoom.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
          if (roomRef.current !== lkRoom) return;
          const localSid = lkRoom.localParticipant.sid;
          const me = speakers.find((s) => s.sid === localSid);
          if (me) {
            logDebug(`サーバー計測: 自分の音声を検出 level=${me.audioLevel.toFixed(3)}`);
          }
          const others = speakers.filter((s) => s.sid !== localSid).map(displayNameOf);
          setRemoteSpeakers((prev) =>
            prev.length === others.length && prev.every((n, i) => n === others[i]) ? prev : others,
          );
        });

        await lkRoom.connect(data.url, data.token);
        logDebug(`connect: room.connect完了(+${Date.now() - startedAt}ms)`);
        // マイクエンジンの「ウォームアップ」: setMicrophoneEnabledは初回のみ
        // createTracks()+publishTrack()という重い処理を行い、2回目以降は
        // track.mute()/unmute()という軽い処理になる(ライブラリの内部実装)。
        // 画面が確実に前面にあるこのタイミングで一度ON→OFFし、重い初回処理を
        // 済ませておく。これにより、ロック中のPTT操作は毎回軽いmute切替だけで
        // 済むようになり、ロック中に初回の重い処理が走って失敗するのを防ぐ。
        logDebug("connect: マイクウォームアップ開始");
        await lkRoom.localParticipant.setMicrophoneEnabled(true);
        await lkRoom.localParticipant.setMicrophoneEnabled(false);
        logDebug("connect: マイクウォームアップ完了");
        established = true;
        setConnected(true);
        setMicOn(false);
        lastAliveRef.current = Date.now();
        wantConnectedRef.current = true;
        // 次回起動時(バックグラウンド再起動を含む)に同じ名前・ルームで入れるよう保存。
        writeSettings({
          [SETTINGS_KEYS.displayName]: displayName,
          [SETTINGS_KEYS.room]: room,
        });
        return true;
      } catch (e) {
        logDebug(`connect: エラー ${errMsg(e)}`);
        await cleanup();
        showError(e, "接続に失敗しました");
        return false;
      } finally {
        setConnecting(false);
      }
    })().finally(() => {
      connectPromiseRef.current = null;
    });

    connectPromiseRef.current = attempt;
    return attempt;
  }, [cleanup, logDebug]);

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
        logDebug(`setMic(${on}): エラー ${errMsg(e)}`);
        showError(e, "マイクを操作できませんでした");
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
    const gen = ++txGenRef.current;

    // JSが休止していた直後は、見かけ上「接続中」でも実際は切れていることがある。
    // ハートビートの空白が大きければ接続を信用せず作り直す。
    const staleMs = Date.now() - lastAliveRef.current;
    const suspectedStale = staleMs > 8000;
    const room = roomRef.current;
    logDebug(
      `PTT開始要求: stale=${staleMs}ms room.state=${room?.state ?? "なし"} suspectedStale=${suspectedStale}`,
    );

    // 中断時は必ずシステム側の送信も終了させる。この関数が動いている時点で
    // requestBeginTransmittingは成功済み=システムは「送信中」を表示している。
    // ここで黙ってreturnすると、マイクは動いていないのにシステム表示だけが
    // 「送信中」のまま残る(ロック中のユーザーは無音送信に気づけない)。
    const abortTransmit = async (reason: string) => {
      logDebug(`PTT: 中断(${reason}) → システム送信を終了`);
      txActiveRef.current = false;
      try {
        await PttChannel?.endTransmitting();
      } catch {
        // noop
      }
    };

    if (!suspectedStale && room && room.state === ConnectionState.Connected) {
      logDebug("PTT: 高速経路(再接続なし)");
      const activated = await waitAudioActive();
      logDebug(`PTT: audioActive待ち完了(activated=${activated})`);
      if (!txActiveRef.current) {
        logDebug("PTT: audioActive待ち中に離された");
        return;
      }
      if (!activated) {
        await abortTransmit("音声セッション未有効=録音できない状態");
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
    let raceTimer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      connect(),
      new Promise<"timeout">((resolve) => {
        raceTimer = setTimeout(() => resolve("timeout"), RECONNECT_TIMEOUT_MS);
      }),
    ]);
    if (raceTimer) clearTimeout(raceTimer);
    if (result === "timeout") {
      // この送信は諦めてシステムの「送信中」表示を消す(無音のまま送信中が
      // 続くのを防ぐ)。後から別の送信が始まっていれば、そちらは止めない。
      if (txGenRef.current === gen) await abortTransmit("再接続タイムアウト");
      return;
    }
    const ok = result;
    logDebug(`PTT: connect結果=${ok}`);
    if (!ok) {
      await abortTransmit("再接続失敗");
      return;
    }
    if (!txActiveRef.current) {
      logDebug("PTT: 再接続中に離された");
      return;
    }
    const activated = await waitAudioActive();
    logDebug(`PTT: audioActive待ち完了(activated=${activated})`);
    if (!txActiveRef.current) {
      logDebug("PTT: audioActive待ち中に離された");
      return;
    }
    if (!activated) {
      await abortTransmit("音声セッション未有効=録音できない状態");
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
      PttChannel.addListener("onBeginTransmitting", (payload) => {
        const source = (payload?.source as string | undefined) ?? "不明";
        logDebug(`PTT送信開始: ${source}`);
        // アプリが要求した送信(画面のボタン/BLEボタン)なのに、確定した時点で
        // 画面のボタンは離されており、BLEも送信の意図が無い(2度押しで取り消し
        // 済み)なら、誰も話していない。マイクを開かずに即終了する。
        if (
          source === PTT_SOURCE.app &&
          !screenHoldRef.current &&
          !bleTxIntentRef.current
        ) {
          logDebug("PTT: 開始確定時には既に離されていた/取り消し済み → 即終了");
          bleToggleInitiatedRef.current = false;
          void PttChannel?.endTransmitting();
          return;
        }
        // 切り忘れ防止タイマーは「送信開始が実際に確定した」この時点で張る。
        // 押下時(要求時)に張ると、要求が失敗した場合にタイマーだけが残り、
        // 30秒後に無関係な送信(ロック画面の長押しなど)を勝手に切ってしまう。
        // 対象はトグル動作の起点(BLEボタン・イヤホンのボタン)のみ。画面の
        // ボタンとロック画面のトークボタンは「押している間だけ」なので対象外。
        const fromEarphone = source === PTT_SOURCE.handsfree;
        if (bleToggleInitiatedRef.current || fromEarphone) {
          if (bleTxAutoOffRef.current) clearTimeout(bleTxAutoOffRef.current);
          const byBle = bleToggleInitiatedRef.current;
          bleTxAutoOffRef.current = setTimeout(() => {
            logDebug(
              byBle ? "BLEボタン: 自動停止(切り忘れ防止)" : "イヤホン: 自動停止(切り忘れ防止)",
            );
            void PttChannel?.endTransmitting();
          }, byBle ? AUTO_OFF_MS : EARPHONE_AUTO_OFF_MS);
        }
        void pttTransmitStart();
      }),
      PttChannel.addListener("onEndTransmitting", (payload) => {
        logDebug(`PTT送信停止: ${(payload?.source as string) ?? "不明"}`);
        // BLEトグルの意図・タイマーは、どの経路で終了しても確実にリセットする。
        bleTxIntentRef.current = false;
        bleToggleInitiatedRef.current = false;
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
      PttChannel.addListener("onAccessoryButton", (payload) => {
        // イヤホン等のボタンを送信操作に割り当てられたか(iOS17+)。
        // これが有効なら、ポケットに入れたままイヤホンのボタンで送信できる。
        if (payload?.enabled) {
          logDebug("イヤホンのボタン: Apple公式経路を有効化");
        } else if (payload?.error) {
          // 実際に失敗した場合のみ「不可」と表示する。
          logDebug(`イヤホンのボタン: Apple公式経路は使えません（${payload.error as string}）`);
        } else {
          // 排他制御のため、こちらが意図的に無効化した場合。エラーではない。
          logDebug("イヤホンのボタン: Apple公式経路を無効化（アプリ側で受け取るため）");
        }
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
      setError("この端末ではロック中に話す機能を使えません(iOS 16以上が必要です)");
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
      logDebug(`PTT参加: エラー ${errMsg(e)}`);
      showError(
        e,
        "ロック中に話す機能(PushToTalk)を開始できませんでした。アプリを一度終了して開き直してください",
      );
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

  // 出勤: 接続してから、ロック中の送信(PTTチャンネル)も自動で準備する。
  // 以前は「接続する」と「PTTを有効化」が別のボタンで、2つ目を押し忘れると
  // ポケットの中でイヤホンのボタンを押しても送信できなかった。
  const startShift = useCallback(async () => {
    const ok = await connect();
    if (!ok || !PttChannel) return;
    if (pttJoinedRef.current || nativePttJoined()) {
      // 既に参加済み(復元されたチャンネルなど)。二重参加はしない。
      setPttJoined(true);
      return;
    }
    await joinPtt();
  }, [connect, joinPtt]);

  // 退勤: 送信を止め、PTTチャンネルから退出してから切断する。
  // 以前の「切断する」はLiveKitだけを切り、PTTチャンネルは参加したままだった。
  // そのため退勤後(通勤中に音楽を聴く時など)にイヤホンの再生ボタンを押すと、
  // 自動で再接続して診療室にマイクが開いてしまっていた。
  const endShift = useCallback(async () => {
    logDebug("退勤: 開始");
    wantConnectedRef.current = false;
    txActiveRef.current = false;
    bleTxIntentRef.current = false;
    bleToggleInitiatedRef.current = false;
    screenHoldRef.current = false;
    if (bleTxAutoOffRef.current) {
      clearTimeout(bleTxAutoOffRef.current);
      bleTxAutoOffRef.current = null;
    }
    if (PttChannel) {
      try {
        await PttChannel.endTransmitting();
      } catch {
        // 送信中でなければ何もしない
      }
      if (pttJoinedRef.current || nativePttJoined()) {
        setPttBusy(true);
        try {
          await PttChannel.leave();
          setPttJoined(false);
          logDebug("退勤: PTTチャンネルから退出");
        } catch (e) {
          // 退出できないままだとイヤホンのボタンが生きているので、黙って流さない。
          logDebug(`退勤: PTT退出に失敗 ${errMsg(e)}`);
          setError("ロック中の送信を解除できませんでした。もう一度「退勤する」を押してください");
        } finally {
          setPttBusy(false);
        }
      }
    }
    await cleanup();
    logDebug("退勤: 完了");
  }, [cleanup, logDebug]);

  // イヤホンが無い時の受信音の出力先を切り替える(設定は端末に保存)。
  // スピーカー: ポケットに入れたままでも聞こえる(既定)。
  // 受話口(静音): 患者の前などで周囲に聞かせたくない時。
  // どちらの設定でも、Bluetooth/有線イヤホン接続中はイヤホンから鳴る。
  // 注意: selectAudioOutput("force_speaker") は使わない。これはイヤホン接続中でも
  // 強制的に本体スピーカーへ鳴らす指定で、ポケットから大音量で流れる事故になる。
  // 代わりにカテゴリの defaultToSpeaker の有無で切り替え、手動の上書きは解除する。
  // ここでは音声セッションの開始/停止はしない(自動管理と競合させない)。
  const toggleSpeaker = useCallback(() => {
    const next = !speakerOnRef.current;
    speakerOnRef.current = next;
    setSpeakerOn(next);
    writeSettings({ [SETTINGS_KEYS.speaker]: next ? "1" : "0" });
    logDebug(`音声出力: イヤホン無しの時は${next ? "スピーカー" : "受話口"}に設定`);
    void (async () => {
      try {
        await AudioSession.selectAudioOutput("default");
      } catch (e) {
        logDebug(`音声出力: 上書き解除に失敗 ${errMsg(e)}`);
      }
      // 受信中(音声セッション使用中)ならその場で反映する。未使用なら何もしなくても
      // 次に音声エンジンが動く時に新しい設定で構成される。
      await applyAudioCategory(next, logDebug);
    })();
  }, [logDebug]);

  // 「話す」ホールド: 押している間だけ送信(PTKit経由)。
  const pttPressIn = useCallback(() => {
    screenHoldRef.current = true;
    PttChannel?.beginTransmitting().catch((e) => {
      screenHoldRef.current = false;
      logDebug(`PTT: 開始失敗 ${errMsg(e)}`);
      if (!nativePttJoined()) {
        // ネイティブ側でチャンネルから外れていた。表示を実態に合わせ、
        // 「ロック中でも話せるようにする」ボタンを出す(次の押下は画面から直接送る)。
        setPttJoined(false);
        setError("ロック中に話す機能が外れていました。「ロック中でも話せるようにする」を押してください");
      } else {
        setError("送信を開始できませんでした。もう一度押してください");
      }
    });
  }, [logDebug, setError]);
  const pttPressOut = useCallback(() => {
    screenHoldRef.current = false;
    PttChannel?.endTransmitting().catch((e) => {
      logDebug(`PTT: 停止失敗 ${e instanceof Error ? e.message : String(e)}`);
    });
  }, [logDebug]);

  // 画面の「押して話す」ボタン(押している間だけ送信)。
  // ロック中に話す機能(PushToTalk)に参加中はその経路で送る。システムの送信表示と
  // 状態が揃い、イヤホンのボタンでの送信と取り合いにならない。
  // 未参加(iOS16未満など)なら、接続中のマイクを直接ON/OFFする。
  const talkPressIn = useCallback(() => {
    setHolding(true);
    setError(null);
    if (pttJoinedRef.current && PttChannel) {
      holdPathRef.current = "ptt";
      pttPressIn();
    } else {
      holdPathRef.current = "direct";
      void setMic(true);
    }
  }, [pttPressIn, setMic, setError]);
  const talkPressOut = useCallback(() => {
    setHolding(false);
    const path = holdPathRef.current;
    holdPathRef.current = null;
    if (path === "ptt") pttPressOut();
    else if (path === "direct") void setMic(false);
  }, [pttPressOut, setMic]);

  // BLEボタン(iTag型)押下: 送信ON/OFFのトグル。
  // PTT参加中はPTKit経由(ロック中でも動く)。未参加で通常接続中なら従来のトグル。
  const handleBlePress = useCallback(() => {
    // 参加状態は「ネイティブの真実」も確認する。アプリがメモリ回収→
    // バックグラウンド復元された直後は、JS側のpttJoinedRefがまだfalseでも
    // ネイティブのPTChannelManagerは参加済みのことがある(この確認が無いと、
    // 復元後の押下がすべて「未接続のため無視」になり、ロック運用が死ぬ)。
    let nativeJoined = false;
    try {
      nativeJoined =
        typeof PttChannel?.getState === "function" ? PttChannel.getState().joined : false;
    } catch {
      nativeJoined = false;
    }
    if ((pttJoinedRef.current || nativeJoined) && PttChannel) {
      if (nativeJoined && !pttJoinedRef.current) {
        setPttJoined(true);
      }
      // トグル判定は「意図(bleTxIntentRef)」または「確定した送信状態」で行う。
      // 開始要求から確定イベントまで1秒以上かかることがあり、txActiveRefだけを
      // 見ると、その間の2度目の押下が「停止」でなく「再開始」になってしまう。
      const inTx = bleTxIntentRef.current || txActiveRef.current;
      if (inTx) {
        bleTxIntentRef.current = false;
        logDebug("BLEボタン: 押下 → PTT送信停止");
        PttChannel.endTransmitting().catch((e) => {
          logDebug(`BLEボタン: 停止失敗 ${e instanceof Error ? e.message : String(e)}`);
        });
      } else {
        bleTxIntentRef.current = true;
        bleToggleInitiatedRef.current = true;
        logDebug("BLEボタン: 押下 → PTT送信開始");
        PttChannel.beginTransmitting().catch((e) => {
          // 失敗したら意図もリセットする(次の押下がまた「開始」になるように)。
          bleTxIntentRef.current = false;
          bleToggleInitiatedRef.current = false;
          logDebug(`BLEボタン: 開始失敗 ${e instanceof Error ? e.message : String(e)}`);
        });
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

  // イヤホン/BLEリモコンの物理ボタンを購読する。押下は handleBlePress と同じ
  // 経路(PTT優先)でトグルするため、ロック中・ポケットの中でも送信できる。
  useRemotePtt(handleBlePress, connected);

  // イヤホンのボタンは常にApple公式経路(PushToTalkが直接受け取る)で扱う。
  // アプリ側でメディアボタンを横取りする方式も試したが、iOSは「音楽を再生して
  // いるアプリ」にしかメディアボタンの主導権を渡さず、通話用の音声セッションでは
  // 主導権を取れないため機能しなかった(実機で確認)。
  // PTT参加時に有効化しているが、取りこぼしを防ぐため参加状態になった時にも
  // 明示的に有効化し直す。
  useEffect(() => {
    if (!pttJoined) return;
    void (async () => {
      try {
        await PttChannel?.setAccessoryButtonEnabled?.(true);
      } catch (e) {
        logDebug(`イヤホンのボタン有効化に失敗 ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
  }, [pttJoined, logDebug]);

  // ネイティブ側のPTT参加状態を画面に反映する(起動時と前面に戻った時)。
  // iOSがアプリを終了→PushToTalkがチャンネルを復元した場合、JSは未参加の状態で
  // 始まるが実際にはイヤホンのボタンが生きている。これを反映しないと、画面上は
  // 「勤務外」なのにイヤホンで送信できてしまい、退勤ボタンも出ない。
  // あわせて、勤務中なのに切断されていれば自動で再接続する(前面にある時だけ。
  // バックグラウンドで接続するとマイクのウォームアップが走るため行わない)。
  useEffect(() => {
    const onActive = () => {
      if (nativePttJoined()) {
        setPttJoined(true);
        // PTTチャンネルに参加中=勤務中。iOSがアプリを終了→復元した場合も含む。
        wantConnectedRef.current = true;
      }
      const room = roomRef.current;
      const disconnected = !room || room.state === ConnectionState.Disconnected;
      if (wantConnectedRef.current && disconnected && !connectPromiseRef.current) {
        logDebug("前面復帰: 勤務中のため自動で再接続");
        void connect();
      }
    };
    if (AppState.currentState === "active") onActive();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") onActive();
    });
    return () => sub.remove();
  }, [connect, logDebug]);

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
        setBleDetail(payload.detail);
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
      // 登録に失敗した場合でも、既存の登録ボタンへの接続維持を必ず復旧させる
      // (ネイティブ側でも復旧するが、JS側からも念押しする)。
      BleButton?.start();
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

  const onShift = connected || pttJoined;
  const roomLabel = ROOMS.find((r) => r.id === roomId)?.label ?? roomId;
  // 画面上部に出す現在の状態。
  const statusView: { tone: "idle" | "ok" | "busy" | "warn" | "live"; text: string } = micOn
    ? { tone: "live", text: "送信中 — あなたの声が流れています" }
    : connected
      ? {
          tone: "ok",
          text: pttJoined ? "待機中 — イヤホンのボタンで話せます" : "待機中 — 画面のボタンで話せます",
        }
      : connecting
        ? { tone: "busy", text: "接続中…" }
        : pttJoined
          ? { tone: "warn", text: "通信が途切れています — 話すと自動で再接続します" }
          : { tone: "idle", text: "勤務外（未接続）" };
  const talkLabel = holding
    ? micOn
      ? "話しています…（離すと終了）"
      : "準備中…"
    : micOn
      ? "送信中 — 押して離すと停止"
      : "押して話す";

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <Text style={styles.brand}>MIRISE WELLMEDICAL GROUP</Text>
        <Text style={styles.title}>院内音声インカム</Text>

        {micOn ? (
          <View style={styles.liveBanner}>
            <Text style={styles.liveText}>🔴 送信中（マイクON）</Text>
          </View>
        ) : null}

        {error ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error.message}</Text>
            {error.action === "settings" ? (
              <Pressable
                style={styles.errorAction}
                onPress={() => {
                  void Linking.openSettings();
                }}
              >
                <Text style={styles.errorActionText}>設定を開く</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        <View style={styles.card}>
          <View style={styles.statusRow}>
            <View style={[styles.statusDot, { backgroundColor: STATUS_COLORS[statusView.tone] }]} />
            <Text style={styles.statusText}>{statusView.text}</Text>
          </View>

          {onShift ? (
            <Text style={styles.shiftSummary}>
              {identity.trim()} ・ {roomLabel}
            </Text>
          ) : (
            <>
              <Text style={[styles.cardLabel, { marginTop: 14 }]}>スタッフ名</Text>
              <TextInput
                style={styles.input}
                value={identity}
                onChangeText={setIdentity}
                placeholder="例: 佐藤 / DH田中"
                editable={!connecting}
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={DISPLAY_NAME_MAX}
                returnKeyType="done"
              />

              <Text style={[styles.cardLabel, { marginTop: 16 }]}>参加ルーム</Text>
              <View style={styles.roomRow}>
                {ROOMS.map((room) => {
                  const selected = room.id === roomId;
                  return (
                    <Pressable
                      key={room.id}
                      onPress={() => !connecting && setRoomId(room.id)}
                      style={[styles.roomChip, selected && styles.roomChipOn]}
                    >
                      <Text style={[styles.roomChipText, selected && styles.roomChipTextOn]}>
                        {room.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </>
          )}

          {onShift ? (
            <>
              {!connected ? (
                <Pressable
                  style={[styles.primary, connecting && styles.disabled]}
                  onPress={() => void startShift()}
                  disabled={connecting}
                >
                  <Text style={styles.primaryText}>
                    {connecting ? "接続中..." : "再接続する"}
                  </Text>
                </Pressable>
              ) : null}
              <Pressable
                style={[styles.secondary, pttBusy && styles.disabled]}
                onPress={() => void endShift()}
                disabled={pttBusy}
              >
                <Text style={styles.secondaryText}>退勤する（切断）</Text>
              </Pressable>
            </>
          ) : (
            <Pressable
              style={[styles.primary, (connecting || pttBusy) && styles.disabled]}
              onPress={() => void startShift()}
              disabled={connecting || pttBusy}
            >
              <Text style={styles.primaryText}>
                {connecting ? "接続中..." : "出勤する（接続）"}
              </Text>
            </Pressable>
          )}
        </View>

        {onShift ? (
          <View style={styles.card}>
            {remoteSpeakers.length > 0 ? (
              <Text style={styles.speakingNow}>🗣 {remoteSpeakers.join("、")} が話しています</Text>
            ) : null}

            <Pressable
              style={[styles.ptt, (micOn || holding) && styles.pttOn]}
              onPressIn={talkPressIn}
              onPressOut={talkPressOut}
            >
              <Text style={styles.pttText}>{talkLabel}</Text>
            </Pressable>

            {connected && !pttJoined && PttChannel ? (
              <View style={styles.warnBox}>
                <Text style={styles.warnText}>
                  ⚠️ 今はロック中・ポケットの中から話せません。
                </Text>
                <Pressable
                  style={[styles.secondary, { marginTop: 8 }, pttBusy && styles.disabled]}
                  onPress={() => void joinPtt()}
                  disabled={pttBusy}
                >
                  <Text style={styles.secondaryText}>
                    {pttBusy ? "準備中..." : "ロック中でも話せるようにする"}
                  </Text>
                </Pressable>
              </View>
            ) : null}

            <Pressable style={styles.toggle} onPress={toggleSpeaker}>
              <Text style={styles.toggleText}>
                {speakerOn
                  ? "🔊 イヤホン無しの時: スピーカーで鳴らす"
                  : "🔈 イヤホン無しの時: 受話口で鳴らす（静音）"}
              </Text>
            </Pressable>

            <Text style={styles.guideTitle}>🎧 ポケットに入れたまま話す</Text>
            <Text style={styles.hint}>
              ・Bluetoothイヤホンのボタンを1回押すと送信開始、もう1回押すと終了。
              {"\n"}・押し忘れても45秒で自動的に止まります。
              {"\n"}・一般的なBluetoothイヤホンで使えます（AirPodsは不可・iOS 17以降）。
              {"\n"}・機種によっては、押した時に音楽アプリも反応することがあります。
              {"\n"}・イヤホンが無い時は、画面上部やロック画面の「MIRISE Intercom」表示を開き、トークボタンを押している間だけ話せます。
              {"\n"}・受信音はイヤホン接続中はイヤホンから流れます（周囲には聞こえません）。
              {"\n"}・うまく送れない時は「退勤する」→「出勤する」で直ります。
            </Text>
            <Text style={[styles.hint, { marginTop: 6 }]}>
              診療中は患者さんの個人情報を言わず、チェア番号やセット名で伝えてください。
            </Text>
          </View>
        ) : null}

        <Pressable style={styles.advancedHeader} onPress={() => setAdvancedOpen((v) => !v)}>
          <Text style={styles.advancedHeaderText}>
            {advancedOpen ? "▼" : "▶"} 詳細設定・診断
          </Text>
        </Pressable>

        {advancedOpen ? (
          <View style={styles.card}>
            <Text style={styles.cardLabel}>端末の状態</Text>
            <Text style={styles.hint}>
              ロック中に話す機能: {PttChannel ? "対応" : "未対応（iOS16以上が必要）"}
              {PttChannel ? `（${pttJoined ? "準備済み" : "未準備"}）` : ""}
              {"\n"}ビルド: {RemotePtt?.buildTag ?? "旧ビルド"} / iOS {String(Platform.Version)}
              {"\n"}端末ID: {getDeviceTag()}
            </Text>

            {PttChannel && connected ? (
              pttJoined ? (
                <Pressable
                  style={[styles.secondary, pttBusy && styles.disabled]}
                  onPress={() => void leavePtt()}
                  disabled={pttBusy}
                >
                  <Text style={styles.secondaryText}>ロック中に話す機能を解除する</Text>
                </Pressable>
              ) : (
                <Pressable
                  style={[styles.secondary, pttBusy && styles.disabled]}
                  onPress={() => void joinPtt()}
                  disabled={pttBusy}
                >
                  <Text style={styles.secondaryText}>
                    {pttBusy ? "準備中..." : "ロック中に話す機能を準備する"}
                  </Text>
                </Pressable>
              )
            ) : null}

            <Text style={[styles.cardLabel, { marginTop: 18 }]}>
              🔘 BLEボタン（iTag型・任意）
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
              iTag型（紛失防止タグ）のボタンを登録すると、押すたびに送信の開始/停止ができます。
              画面ロック中・ポケットの中でも動作します（切り忘れ防止のため約30秒で自動停止）。
              {"\n"}※シャッターリモコン等のキーボード型はロック中は使えません（iOSの仕様）。
              {"\n"}※登録は1台ずつ、他のタグは離して行ってください。
            </Text>
            {bleStatus.registered && !pttJoined ? (
              <Text style={[styles.hint, { color: "#b76e00" }]}>
                ⚠️ ロック中にBLEボタンを使うには「出勤する」でロック中に話す機能も準備してください。
              </Text>
            ) : null}
            {bleBusy && bleDetail ? (
              <Text style={[styles.hint, { color: "#0f4bd8" }]}>▶ {bleDetail}</Text>
            ) : null}
            {!bleStatus.registered ? (
              <Pressable
                style={[styles.secondary, bleBusy && styles.disabled]}
                onPress={() => void setupBleButton()}
                disabled={bleBusy}
              >
                <Text style={styles.secondaryText}>
                  {bleBusy
                    ? "検索中...（画面の案内に従ってください）"
                    : "BLEボタンを登録（タグを手元に置いて押す）"}
                </Text>
              </Pressable>
            ) : (
              <Pressable style={styles.secondary} onPress={unregisterBleButton}>
                <Text style={styles.secondaryText}>BLEボタンの登録を解除</Text>
              </Pressable>
            )}

            <Text style={[styles.cardLabel, { marginTop: 18 }]}>
              🪵 診断ログ（新しい順・不具合の報告時にスクリーンショットを送ってください）
            </Text>
            <View style={styles.debugLogBox}>
              <ScrollView nestedScrollEnabled>
                {debugLog.length === 0 ? (
                  <Text style={styles.debugLogLine}>（まだログがありません）</Text>
                ) : (
                  [...debugLog].reverse().map((line, i) => (
                    <Text key={i} style={styles.debugLogLine}>
                      {line}
                    </Text>
                  ))
                )}
              </ScrollView>
            </View>
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
  statusRow: { flexDirection: "row", alignItems: "center" },
  statusDot: { width: 12, height: 12, borderRadius: 6, marginRight: 10 },
  statusText: { flex: 1, color: "#172033", fontSize: 16, fontWeight: "700" },
  shiftSummary: { marginTop: 10, color: "#475467", fontSize: 15, fontWeight: "600" },
  speakingNow: {
    color: "#0f4bd8",
    fontSize: 16,
    fontWeight: "700",
    marginBottom: 12,
    textAlign: "center",
  },
  warnBox: {
    marginTop: 12,
    backgroundColor: "#fff7e6",
    borderColor: "#f5d38a",
    borderWidth: 1,
    borderRadius: 14,
    padding: 12,
  },
  warnText: { color: "#8a5200", fontWeight: "600", lineHeight: 20 },
  guideTitle: { marginTop: 18, color: "#1f2f58", fontSize: 15, fontWeight: "700" },
  advancedHeader: { paddingVertical: 12, paddingHorizontal: 4, marginBottom: 8 },
  advancedHeaderText: { color: "#475467", fontSize: 15, fontWeight: "600" },
  ptt: {
    backgroundColor: "#263b69",
    borderRadius: 28,
    minHeight: 140,
    alignItems: "center",
    justifyContent: "center",
  },
  pttOn: { backgroundColor: "#0f8f4f" },
  pttText: {
    color: "#ffffff",
    fontSize: 28,
    fontWeight: "800",
    textAlign: "center",
    paddingHorizontal: 16,
  },
  toggle: {
    marginTop: 12,
    borderRadius: 16,
    paddingVertical: 16,
    alignItems: "center",
    backgroundColor: "#e6eaf2",
    borderWidth: 2,
    borderColor: "#c7d0e4",
  },
  toggleText: { color: "#1f2f58", fontSize: 17, fontWeight: "700" },
  hint: { marginTop: 14, color: "#667085", lineHeight: 20, fontSize: 13 },
  errorBox: {
    backgroundColor: "#fff0f0",
    borderColor: "#ffd2d6",
    borderWidth: 1,
    borderRadius: 16,
    padding: 14,
    marginBottom: 16,
  },
  errorText: { color: "#a20d1a", lineHeight: 20 },
  errorAction: {
    alignSelf: "flex-start",
    marginTop: 10,
    backgroundColor: "#a20d1a",
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  errorActionText: { color: "#fff", fontWeight: "700" },
});
