import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  AppState,
  Linking,
  PermissionsAndroid,
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
  AndroidAudioTypePresets,
  AudioSession,
  registerGlobals,
  type AppleAudioCategoryOption,
} from "@livekit/react-native";
import {
  AudioDeviceModule,
  AudioEngineMuteMode,
  audioDeviceModuleEvents,
} from "@livekit/react-native-webrtc";
import {
  ConnectionState,
  DisconnectReason,
  Room,
  RoomEvent,
  Track,
  type LocalParticipant,
  type LocalTrack,
  type Participant,
  type RemoteParticipant,
} from "livekit-client";
import { useRemotePtt } from "./hooks/useRemotePtt";
import {
  ATTR,
  BROADCAST_CHANNEL,
  BROADCAST_LABEL,
  DM_REVERT_MS,
  SHARED_ROOM,
  buildAttributes,
  channelLabel,
  dmRemainingMs,
  dmTalk,
  dmTargetOf,
  isChannelId,
  isDmTo,
  normalizeListen,
  parseListen,
  parseTalk,
  pickTalkChannel,
  serializeListen,
  shouldHear,
  speakerLabel,
  withBroadcastChannel,
  type ChannelInfo,
} from "./src/channels";
import BleButton, {
  type BleButtonMode,
  type BleButtonState,
  type BleButtonStatus,
  type BlePressEvent,
  type BlePressKind,
} from "./modules/ble-button";
import PttChannel, { PTT_SOURCE, type PttErrorKind } from "./modules/ptt-channel";
import RemotePtt from "./modules/remote-ptt";
import AndroidPtt from "./modules/android-ptt";

// 止め忘れ防止: トグルでONにしたら一定時間で自動OFF(ミリ秒)。
const AUTO_OFF_MS = 30_000;
// イヤホンのボタンで始めた送信の自動停止(ミリ秒)。イヤホンは「1回押すと開始、
// もう1回で終了」のトグル動作なので、押し忘れ・ポケットの中での誤押下・機種に
// よる再生/停止ボタンの誤反応で、マイクが開きっぱなしになり得る。診療室で患者の
// 会話が流れ続ける事故を防ぐため、必ず上限を設ける。話し終える余裕を持たせて
// BLEボタンより少し長めにしている。
const EARPHONE_AUTO_OFF_MS = 45_000;
// 物理ボタン(BLE)を「押している間だけ話す」方式で使う時の送信の上限(ミリ秒)。
// 離した通知(0x00)が電波の途切れ等で届かないと送信が開いたままになり、
// ネイティブ側にも押しっぱなしの上限は無いため、ここで必ず止める。
// 押している間だけの操作なので、トグル(30秒)より長めの連絡にも足りる60秒にする。
const HOLD_MAX_MS = 60_000;
// 物理ボタンで送信開始を要求してから、システムの開始確定(onBeginTransmitting)を
// 待つ上限。過ぎたら押下の記録(意図)を取り消す。残したままだと、確定が遅れて
// 届いた時に「誰も話すつもりがないのに送信が始まる」ため(取り消し後に届いた
// 確定は、handleBegin の「既に離されていた」判定で即終了する)。
const BLE_BEGIN_WATCHDOG_MS = 5_000;
// JSの購読前に届いた押下の再送を受け付ける上限(ミリ秒)。古い押下で、忘れた頃に
// 送信が始まる事故を防ぐ。「離す」は止める方向なので、年齢に関係なく受け付ける。
const BLE_REPLAY_MAX_AGE_MS = 3_000;
// 登録直後(と「テスト」ボタン)の確認時間。この間の押下は画面に表示するだけで送信しない
// (登録できたかを、実際に声を流さずに確かめられるようにする)。
const BLE_TEST_MS = 10_000;
// 診断ログ用の押下の種類の名前。
const BLE_KIND_LABEL: Record<BlePressKind, string> = {
  toggle: "押下",
  down: "押す",
  up: "離す",
};

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
const API_BASE = "https://mirisevoicelink.vercel.app";
const TOKEN_ENDPOINT = `${API_BASE}/api/token`;
const DEVICE_LOGIN_ENDPOINT = `${API_BASE}/api/device-login`;
// ルーム一覧(管理画面で追加・名前変更したもの)。端末トークンで読める。
const CONFIG_ENDPOINT = `${API_BASE}/api/config`;

// 旧方式のAPIキー(合言葉)。開発ビルドでのみ使う(EXPO_PUBLIC_INTERCOM_KEY を設定した時だけ)。
// スタッフに配るビルドには設定しないこと: アプリから取り出せるため、院外に渡ると
// 誰でもサーバーを使えてしまう。配布ビルドでは下の「端末トークン」を使う。
const INTERCOM_KEY = process.env.EXPO_PUBLIC_INTERCOM_KEY;

// ---- 端末トークン(医院のパスワードで1回ログインすると発行される、この端末専用の鍵) ----
// iOSのキーチェーンに保存する。保存の仕方は「再起動後に一度ロック解除すれば、以降は
// ロック中でも読める」(AFTER_FIRST_UNLOCK)。ロック中にイヤホンのボタンでアプリが
// 裏で起動された時にも読めないと、再接続できないため。バックアップで別の端末に
// 移らないよう THIS_DEVICE_ONLY にする。
// expo-secure-store は新しいネイティブビルドにしか無いため、無い時に読み込みで
// アプリごと落ちないよう、存在を確かめてから使う。
type SecureStoreModule = typeof import("expo-secure-store");
let SecureStore: SecureStoreModule | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  SecureStore = require("expo-secure-store") as SecureStoreModule;
} catch {
  SecureStore = null;
}
const DEVICE_TOKEN_KEY = "mirise.deviceToken";

let deviceTokenCache: string | null = null;
let deviceTokenLoad: Promise<string | null> | null = null;

function loadDeviceToken(): Promise<string | null> {
  if (!deviceTokenLoad) {
    deviceTokenLoad = (async () => {
      if (!SecureStore) return null;
      try {
        deviceTokenCache = await SecureStore.getItemAsync(DEVICE_TOKEN_KEY);
      } catch {
        deviceTokenCache = null;
      }
      return deviceTokenCache;
    })();
  }
  return deviceTokenLoad;
}

async function saveDeviceToken(token: string | null): Promise<void> {
  deviceTokenCache = token;
  deviceTokenLoad = Promise.resolve(token);
  if (!SecureStore) return;
  try {
    if (token) {
      await SecureStore.setItemAsync(DEVICE_TOKEN_KEY, token, {
        keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
      });
    } else {
      await SecureStore.deleteItemAsync(DEVICE_TOKEN_KEY);
    }
  } catch {
    // 保存に失敗しても、このアプリの起動中はメモリ上のトークンで動く
  }
}

// 医院のパスワードで端末をログインさせ、端末トークンを保存する。
async function deviceLogin(password: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOKEN_TIMEOUT_MS);
  try {
    const response = await fetch(DEVICE_LOGIN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
      signal: controller.signal,
    });
    let data: { token?: string; error?: string } = {};
    try {
      data = (await response.json()) as typeof data;
    } catch {
      // HTMLのエラーページなど
    }
    if (!response.ok || !data.token) {
      const err = new Error(
        data.error ?? `ログインに失敗しました(HTTP ${response.status})`,
      ) as Error & { status?: number };
      // パスワード違い(401)は「接続キー不一致」と言い換えられないよう 400 扱いで本文を出す。
      err.status = response.status === 401 ? 400 : response.status;
      throw err;
    }
    await saveDeviceToken(data.token);
  } finally {
    clearTimeout(timer);
  }
}

// ---- ルーム(チャンネル) ----
// 新しいアプリは全員、音声サーバー(LiveKit)の同じルーム(SHARED_ROOM)に入り、管理画面の
// 「ルーム」はその中のチャンネルとして扱う。誰の声を聞くかは、各自が自分に付ける参加者属性
// (聞くルーム・話す先)で決まるので、出勤したままルームを切り替え・複数のルームを聞ける。
// 一覧はサーバー(/api/config)から読んで端末に保存し、読めない時は保存済み→下の既定を使う。
type ChannelItem = ChannelInfo & { description?: string };
const DEFAULT_CHANNELS: ChannelItem[] = [
  { id: "front", label: "受付" },
  { id: "clinic", label: "診療室" },
  { id: "surgery", label: "オペ" },
  { id: "sterilization", label: "滅菌" },
  { id: BROADCAST_CHANNEL, label: BROADCAST_LABEL },
];
// 管理画面で「全体」が消されていても、必ず一覧に残す(全員が常に聞くチャンネル)。
const BROADCAST_ITEM: ChannelItem = { id: BROADCAST_CHANNEL, label: BROADCAST_LABEL };
// 初めて使う端末の話す先(以前の既定の参加ルームと同じ)。
const DEFAULT_TALK_CHANNEL = "clinic";

// 個別に話す相手(出勤中の人。identity は LiveKit の参加者ID、name は表示名)。
type DmTarget = { identity: string; name: string };
// 「個別に話す」の候補(共通ルームに入っている自分以外の人)。home はその人の主なルーム。
type Person = { identity: string; name: string; home: string };

// ---- 端末内に保存する設定(スタッフ名・ルーム・端末ID) ----
// iOSの NSUserDefaults を使う React Native 標準の Settings を利用する(追加の
// ライブラリもネイティブ再ビルドも不要)。読み込みが同期的なので、iOSがアプリを
// バックグラウンドで再起動した直後(イヤホンのボタン押下で起こされた時など)でも、
// 最初の描画の時点で正しい名前・ルームが揃っている。これが無いと、再起動後の
// 自動再接続が既定の名前・既定のルームで行われ、別の部屋に声が流れてしまう。
// ※Android版では Settings が使えないため、Android対応時に置き換えること。
const SETTINGS_KEYS = {
  displayName: "mirise.displayName",
  // 話す先のルーム(以前の「参加ルーム」と同じキー。個別に話す相手は保存しない)。
  room: "mirise.room",
  // 聞くルーム(カンマ区切り。"all" は常に含む)。
  listen: "mirise.listen",
  // サーバーから読んだルーム一覧(JSON)。次の起動時・サーバーに繋がらない時に使う。
  channels: "mirise.channels",
  deviceTag: "mirise.deviceTag",
  speaker: "mirise.speaker",
  clockedOut: "mirise.clockedOut",
} as const;

// Android には Settings が無いため、端末内の安全な保存領域(expo-secure-store の
// 同期API)を使う。どちらも同期で読めるので、起動直後の最初の描画に間に合う。
function readSetting(key: string): string | null {
  try {
    if (Platform.OS === "ios") {
      const value = Settings.get(key);
      return typeof value === "string" ? value : null;
    }
    return SecureStore?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeSettings(values: Record<string, string>) {
  try {
    if (Platform.OS === "ios") {
      Settings.set(values);
      return;
    }
    for (const [key, value] of Object.entries(values)) SecureStore?.setItem(key, value);
  } catch {
    // 保存できなくても動作は続ける(次回の起動時に再入力になるだけ)。
  }
}

// サーバー・端末から読んだルーム一覧を確かめて整える(形式が違えば null)。
// ID の規則に合わないもの・重複は除き、「全体」が無ければ足す。
function parseChannelList(value: unknown): ChannelItem[] | null {
  if (!Array.isArray(value)) return null;
  const items: ChannelItem[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as { id?: unknown; label?: unknown; description?: unknown };
    if (!isChannelId(o.id)) continue;
    const label = typeof o.label === "string" && o.label.trim() ? o.label.trim() : o.id;
    items.push({
      id: o.id,
      label,
      ...(typeof o.description === "string" && o.description ? { description: o.description } : {}),
    });
  }
  return items.length > 0 ? withBroadcastChannel(items, BROADCAST_ITEM) : null;
}

// 端末に保存したルーム一覧(無い・壊れている時は既定の一覧)。
function loadSavedChannels(): ChannelItem[] {
  const saved = readSetting(SETTINGS_KEYS.channels);
  if (saved) {
    try {
      const list = parseChannelList(JSON.parse(saved));
      if (list) return list;
    } catch {
      // 壊れていたら既定の一覧を使う
    }
  }
  return withBroadcastChannel(DEFAULT_CHANNELS, BROADCAST_ITEM);
}

// 端末に保存した聞くルーム・話す先。聞くルームを保存していない旧版から更新した直後は、
// 保存していた「参加ルーム」を聞くルーム・話す先にする(以前と同じ人の声が聞こえるように)。
function loadSavedListenTalk(): { listen: string[]; talk: string } {
  const savedTalk = readSetting(SETTINGS_KEYS.room);
  const savedListen = readSetting(SETTINGS_KEYS.listen);
  const talk = isChannelId(savedTalk) ? savedTalk : DEFAULT_TALK_CHANNEL;
  const listen = savedListen !== null ? parseListen(savedListen) : normalizeListen([talk]);
  return { listen, talk: pickTalkChannel(talk, listen) };
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
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
    .slice(0, 40)
    .replace(/[\uD800-\uDBFF]$/, ""); // 「𠮷」などが40文字目で半分に割れたら除く(サーバーが拒否するため)
  return `${base || "staff"}-${tag}`;
}

// 画面表示用の名前。新しいトークンAPIでは name がそのまま表示名になる。
// 旧APIでは name が identity と同じ("富田-a3f2c9")になるので、末尾の端末IDを外す。
function displayNameOf(p: { name?: string; identity: string }): string {
  if (p.name && p.name !== p.identity) return p.name;
  return p.identity.replace(/-[a-z0-9]{6}$/, "");
}

const DISPLAY_NAME_MAX = 32;
// 表示名に使える文字(トークンAPIの検査と同じ: 文字・数字・空白・「・」「_」「-」「.」)。
// 事前に確かめないと、サーバーで拒否されて「接続に失敗」になり原因が分かりにくい。
let DISPLAY_NAME_ALLOWED: RegExp | null;
try {
  DISPLAY_NAME_ALLOWED = new RegExp("^[\\p{L}\\p{N}\\p{Zs}・_\\-.]+$", "u");
} catch {
  // Unicodeプロパティ指定が使えない環境では事前チェックを省く(サーバー側で検査される)。
  DISPLAY_NAME_ALLOWED = null;
}
// 診断ログの保持行数。
const DEBUG_LOG_MAX = 80;

// iOSのメジャーバージョン(イヤホンのボタンでの送信は iOS 17 以降のみ)。
const IOS_MAJOR = Platform.OS === "ios" ? parseInt(String(Platform.Version), 10) || 0 : 0;
const ACCESSORY_DEFAULT: boolean | null = IOS_MAJOR >= 17 ? null : false;

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
  const code = (e && typeof e === "object" ? (e as { code?: unknown }).code : undefined);
  if (code === "device_token_invalid") {
    return {
      message: "ログインの有効期限が切れました。医院のパスワードでもう一度ログインしてください",
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

// ネイティブ側で送信中か(旧ビルドは transmitting を返さないので false)。
// 物理ボタンの「離す」を受けた時に、止めるべき送信が残っているかの判断に使う。
function nativePttTransmitting(): boolean {
  try {
    return typeof PttChannel?.getState === "function"
      ? PttChannel.getState().transmitting === true
      : false;
  } catch {
    return false;
  }
}

// ネイティブ側でPTTの音声セッションが有効か(null=分からない・旧ビルド)。
// JS側の記録は無効化の通知を取りこぼすと「有効」のまま残りうるため、こちらを優先する
// (有効になる前にマイクを開くと、成功に見えても無音になる)。
function nativePttAudioActive(): boolean | null {
  try {
    if (typeof PttChannel?.getState !== "function") return null;
    const active = PttChannel.getState().audioActive;
    return typeof active === "boolean" ? active : null;
  } catch {
    return null;
  }
}

// Android: ネイティブの自動OFFタイマーの予約を取り消す(旧ビルド・iPhoneでは何もしない)。
function cancelNativeAutoOff(): void {
  try {
    if (typeof AndroidPtt?.cancelAutoOff === "function") AndroidPtt.cancelAutoOff();
  } catch {
    // 取り消せなくても、予約番号が合わない発火は JS 側で無視される。
  }
}

// 物理ボタン(BLE)の状態。ネイティブが無い・読み出しに失敗した時は「未登録」扱い
// (同期のネイティブ呼び出しなので、例外で画面ごと落ちないようにする)。
const BLE_STATUS_NONE: BleButtonStatus = { registered: false, connected: false };
function readBleStatus(): BleButtonStatus {
  try {
    return BleButton?.getStatus() ?? BLE_STATUS_NONE;
  } catch {
    return BLE_STATUS_NONE;
  }
}

// Android: ボタンの検索に必要な許可を求める。Android 12以降は「付近のデバイス」
// (BLUETOOTH_SCAN / BLUETOOTH_CONNECT)、11以前はBLE検索の結果を受け取るのに
// 位置情報が必要(OSの仕様)。許可が無いとネイティブ側は登録を拒否するだけなので、
// 先にここで求めて、断られたら「設定を開く」を案内する。
async function ensureBleSetupPermission(): Promise<boolean> {
  if (Platform.OS !== "android") return true;
  const level = typeof Platform.Version === "number" ? Platform.Version : 0;
  const perms =
    level >= 31
      ? [
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        ]
      : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
  const result = await PermissionsAndroid.requestMultiple(perms);
  return perms.every((p) => result[p] === PermissionsAndroid.RESULTS.GRANTED);
}

// トークン取得の上限時間。院内Wi-Fiが「繋がっているのにインターネットに出られ
// ない」状態や、Wi-Fi↔LTEの切替中は、上限が無いとiOS既定の60秒待ち続け、
// その間のイヤホン押下がすべて「送信中なのに無音」になる。
const TOKEN_TIMEOUT_MS = 8_000;
// イヤホン押下からの再接続を待つ上限。超えたらこの送信は諦めて「送信中」表示を
// 消す(接続自体は裏で続けてよい。繋がれば受信はできる)。
const RECONNECT_TIMEOUT_MS = 12_000;
// 送信開始時に LiveKit が自分で復旧中(休止明けの再接続など)だった場合に、その完了を
// 待つ上限。過ぎても戻らなければ、接続を作り直す(残りは RECONNECT_TIMEOUT_MS の範囲内)。
const LINK_RECOVERY_WAIT_MS = 5_000;
// PTTのシステム音声セッションが有効になるのを待つ上限(実機で1秒以上かかることがある)。
const AUDIO_ACTIVE_WAIT_MS = 3_000;
// 送信の直前に、話す先(個別の期限切れで全員に戻す等)の反映を待つ上限。ふだんは反映済みで
// 待たない。これを過ぎたら、その送信は諦める(違う相手・広い範囲に声が届かないように)。
const TALK_READY_WAIT_MS = 5_000;
// ルーム一覧をサーバーへ取りに行く最短の間隔(前面に戻るたびに取りに行きすぎない)。
const CHANNELS_REFRESH_MIN_MS = 30_000;
// 個別の自動解除を、送信中(押した後・開始の確定待ちを含む)だったために見送った時に
// 確かめ直す間隔。送信が始まらずに終わった(システムに拒否された等)場合も、これで戻る。
const DM_RECHECK_MS = 1_000;
// 押下から送信開始の確定(onBeginTransmitting)までを同じ押下とみなす上限。
// 個別の期限は押した時刻で判断するため、確定まで押下の時刻を持ち越す。
const PRESS_TIME_MAX_AGE_MS = 10_000;
// 送信ごとの所要時間の記録を、この時間を過ぎたら「未完了」として打ち切る。
const TX_TRACE_MAX_MS = 20_000;
// 診断ログを画面に反映する間隔。1行ごとに画面全体を再描画すると、ロック中の送信の
// 処理(押下→送信開始)と同じJSスレッドを取り合って遅くなるため、まとめて反映する。
const DEBUG_LOG_FLUSH_MS = 400;

// LiveKit のトークンを使い回す上限(サーバーの有効期限は8時間。余裕を持たせる)。
// 再接続のたびに取り直すと、休止明けの通信(名前解決・暗号化の確立・サーバーの起動待ち)で
// 0.2〜2秒かかるため、同じ名前・端末・ルームなら発行から6時間までは使い回す。
// 退勤・端末登録の解除・接続の失敗では必ず捨てる(次は取り直す)。
const TOKEN_REUSE_MS = 6 * 60 * 60 * 1000;
let tokenCache: { key: string; at: number; token: string; url: string } | null = null;
// 捨てた回数。取得中に捨てられた(退勤・端末トークンの無効化など)トークンを、
// 取得し終えた後に覚え直さないために使う。
let tokenCacheGen = 0;

function clearTokenCache(): void {
  tokenCache = null;
  tokenCacheGen += 1;
}

async function getLiveKitToken(body: {
  identity: string;
  name: string;
  room: string;
}): Promise<{ token: string; url: string; reusedAgeMs: number | null }> {
  const key = `${body.identity}\n${body.name}\n${body.room}`;
  const now = Date.now();
  const cached = tokenCache;
  if (cached && cached.key === key) {
    const age = now - cached.at;
    // 時計が巻き戻った(age<0)時も、念のため取り直す。
    if (age >= 0 && age < TOKEN_REUSE_MS) {
      return { token: cached.token, url: cached.url, reusedAgeMs: age };
    }
  }
  tokenCache = null;
  const gen = tokenCacheGen;
  const fresh = await fetchToken(body);
  // 発行時刻は要求した時点で記録する(実際の発行より古く見積もる=安全側)。
  // 取得中に捨てられていたら覚えない(退勤後・ログイン解除後に使い回さない)。
  if (gen === tokenCacheGen) tokenCache = { key, at: now, token: fresh.token, url: fresh.url };
  return { ...fresh, reusedAgeMs: null };
}

// ---- LiveKit の接続状態の判定(送信開始時に、作り直しが本当に必要かを決める) ----
// ok: そのまま話せる / resuming: LiveKit が切断を検知して自分で復旧中(待てば戻る) /
// dead: 接続が無い・完全に切れた(作り直しが必要)。
type LinkHealth = "ok" | "resuming" | "dead";
// SignalConnectionState.CONNECTED の値(ライブラリから公開されていないため数値で比べる)。
const SIGNAL_CONNECTED = 1;

function linkHealth(room: Room | null): LinkHealth {
  if (!room) return "dead";
  const state = room.state;
  // Connecting は進行中の connect() の途中(connect() を呼べば同じ結果を待てる)。
  if (state === ConnectionState.Disconnected || state === ConnectionState.Connecting) return "dead";
  if (state === ConnectionState.Reconnecting || state === ConnectionState.SignalReconnecting) {
    return "resuming";
  }
  try {
    // 切断後は engine が外される(型の上では常にある)。
    const engine: Room["engine"] | undefined = room.engine;
    if (!engine || engine.isClosed) return "dead";
    // 部屋の状態がまだ「接続中」でも、通信路(WebSocket)が閉じていれば LiveKit が
    // 直後に復旧を始める(休止明けに期限切れのタイマーが動いた直後など)。
    if (engine.client.isDisconnected || engine.client.currentState !== SIGNAL_CONNECTED) {
      return "resuming";
    }
    const pc = engine.pcManager?.publisher.getConnectionState();
    if (pc === "failed" || pc === "disconnected" || pc === "closed") return "resuming";
  } catch {
    // ライブラリの内部の形が変わっていても、部屋の状態だけで判断して続ける。
  }
  return "ok";
}

// 診断ログ用: 音声サーバーとの往復時間(ms)。取れなければ "?"。
function signalRtt(room: Room | null): string {
  try {
    const engine: Room["engine"] | undefined = room?.engine;
    return engine ? String(engine.client.rtt) : "?";
  } catch {
    return "?";
  }
}

// LiveKit 自身の復旧(Reconnected)か、諦めた(Disconnected)のを待つ。音声の通信路
// (PeerConnection)だけが一時的に乱れて LiveKit が何もせずに自然に戻る場合は通知が
// 来ないので、状態も短い間隔で確かめる。上限を過ぎた時点で使える状態なら復旧扱い。
// iPhoneのPTT送信中(システムがアプリを動かし続けている間)だけ使う。Androidのロック中は
// JSのタイマーが止まるため、この待ち方は使わないこと。
const LINK_POLL_MS = 100;
function waitRoomRecovery(
  room: Room,
  timeoutMs: number,
): Promise<"reconnected" | "disconnected" | "timeout"> {
  if (linkHealth(room) === "ok") return Promise.resolve("reconnected");
  if (room.state === ConnectionState.Disconnected) return Promise.resolve("disconnected");
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    let settled = false;
    const finish = (result: "reconnected" | "disconnected" | "timeout") => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (poll) clearInterval(poll);
      room.off(RoomEvent.Reconnected, onReconnected);
      room.off(RoomEvent.Disconnected, onDisconnected);
      resolve(result);
    };
    const onReconnected = () => finish("reconnected");
    const onDisconnected = () => finish("disconnected");
    room.on(RoomEvent.Reconnected, onReconnected);
    room.on(RoomEvent.Disconnected, onDisconnected);
    poll = setInterval(() => {
      if (room.state === ConnectionState.Disconnected) finish("disconnected");
      else if (linkHealth(room) === "ok") finish("reconnected");
    }, LINK_POLL_MS);
    timer = setTimeout(
      () => finish(linkHealth(room) === "ok" ? "reconnected" : "timeout"),
      Math.max(0, timeoutMs),
    );
  });
}

// 診断ログの時刻(時:分:秒.ミリ秒)。送信の各段階の間隔を読み取れるようにする。
function logTime(d: Date): string {
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${String(
    d.getMilliseconds(),
  ).padStart(3, "0")}`;
}

// サーバーへの認証ヘッダー(端末トークン。開発ビルドで旧方式のキーがあればそれ)。
async function appAuthHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  const deviceToken = await loadDeviceToken();
  if (deviceToken) headers.Authorization = `Bearer ${deviceToken}`;
  else if (INTERCOM_KEY) headers["x-intercom-key"] = INTERCOM_KEY;
  return headers;
}

// ルーム一覧を /api/config から読む(管理画面での追加・名前変更をアプリにも出すため)。
// 認証は /api/token と同じ端末トークン。端末トークンが無効なら code=device_token_invalid の
// 例外にする(トークンを消して再ログインを促すかは、勤務中かどうかで呼び出し側が決める)。
async function fetchChannels(): Promise<ChannelItem[]> {
  const headers = await appAuthHeaders();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOKEN_TIMEOUT_MS);
  try {
    const response = await fetch(CONFIG_ENDPOINT, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    let data: { rooms?: unknown; error?: string; code?: string } = {};
    try {
      data = (await response.json()) as typeof data;
    } catch {
      // HTMLのエラーページなど
    }
    if (!response.ok) {
      const err = new Error(
        data.error ?? `ルーム一覧を取得できませんでした(HTTP ${response.status})`,
      ) as Error & { status?: number; code?: string };
      err.status = response.status;
      err.code = data.code;
      throw err;
    }
    const list = parseChannelList(data.rooms);
    if (!list) throw new Error("ルーム一覧の形式が正しくありません");
    return list;
  } finally {
    clearTimeout(timer);
  }
}

// ---- 参加者属性(聞くルーム・話す先)の反映 ----
// 自分の参加者属性がサーバーに反映済みか(サーバーから届いた値と比べる。'' は未設定と同じ)。
function attributesApplied(lp: LocalParticipant, attrs: Record<string, string>): boolean {
  const current = lp.attributes;
  return Object.entries(attrs).every(([key, value]) => (current[key] ?? "") === value);
}

// サーバーが自分の属性の更新を許可しているか(不明なら許可とみなす)。古いサーバー・許可の無い
// トークンでは話す先を知らせられず、相手からは「全体」あてに見える(全員に届く)。
// そのため「全体」あて以外の送信はしない(isTalkReady。PC画面と同じ)。
function canSetAttributes(room: Room): boolean {
  return room.localParticipant.permissions?.canUpdateMetadata !== false;
}

// 属性の反映を待つ上限(画面表示中・iPhoneのPTT送信中の補助。Android のロック中は
// このタイマーは動かないが、反映の通知・切断・再接続のどれかで必ず終わる)。
const ATTR_SYNC_TIMEOUT_MS = 5_000;

// 自分の参加者属性を更新し、サーバーに反映されるまで待つ(true=反映済み)。
// 反映は、サーバーから届く自分の ParticipantAttributesChanged で確かめる。
// setAttributes() 自体の完了待ちは JS のタイマー(50msごとの確認)頼みで、Android の
// ロック中はタイマーが止まって終わらない(ロック解除後に失敗扱いになる)ため、それは待たない。
// LiveKit が接続し直した(Reconnected)時も一度終える(完全な再接続ではサーバー上の属性が
// 消えるので、呼び出し側でもう一度送り直す)。
function setAttributesAndWait(
  room: Room,
  attrs: Record<string, string>,
  timeoutMs: number,
  log: (msg: string) => void,
): Promise<boolean> {
  const lp = room.localParticipant;
  if (attributesApplied(lp, attrs)) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      room.off(RoomEvent.ParticipantAttributesChanged, onChanged);
      room.off(RoomEvent.Reconnected, onReconnected);
      room.off(RoomEvent.Disconnected, onDisconnected);
      resolve(ok);
    };
    const onChanged = (_changed: Record<string, string>, p: Participant) => {
      if (p === lp && attributesApplied(lp, attrs)) finish(true);
    };
    const onReconnected = () => finish(attributesApplied(lp, attrs));
    const onDisconnected = () => finish(false);
    room.on(RoomEvent.ParticipantAttributesChanged, onChanged);
    room.on(RoomEvent.Reconnected, onReconnected);
    room.on(RoomEvent.Disconnected, onDisconnected);
    timer = setTimeout(() => finish(attributesApplied(lp, attrs)), Math.max(0, timeoutMs));
    lp.setAttributes(attrs).then(
      () => finish(attributesApplied(lp, attrs)),
      (e: unknown) => {
        // ロック解除後に届く「時間切れ」は、反映済みなら無視してよい。
        if (!attributesApplied(lp, attrs)) log(`属性: 更新に失敗 ${errMsg(e)}`);
        finish(attributesApplied(lp, attrs));
      },
    );
  });
}

// 一定時間で待つのをやめる(時間切れ・失敗のときは fallback を返す)。
// Android のロック中はタイマーが動かないので、待つ相手が必ず終わるものにだけ使う。
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), Math.max(0, ms));
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

async function fetchToken(body: {
  identity: string;
  name: string;
  room: string;
}): Promise<{ token: string; url: string }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(await appAuthHeaders()),
  };
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
    let data: { token?: string; url?: string; error?: string; code?: string } = {};
    try {
      data = JSON.parse(text) as typeof data;
    } catch {
      // サーバーがHTMLのエラーページを返した場合など。下でHTTPステータスと共に扱う。
    }
    if (!response.ok || !data.token || !data.url) {
      const err = new Error(
        data.error ?? `トークン取得に失敗しました(HTTP ${response.status})`,
      ) as Error & { status?: number; code?: string };
      err.status = response.status;
      err.code = data.code;
      // 端末トークンが無効(期限切れ・医院のパスワード変更)。消して再ログインを促す。
      if (data.code === "device_token_invalid") await saveDeviceToken(null);
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
  // スタッフ名(画面表示用)。前回の値を端末から復元する。
  const [identity, setIdentity] = useState(() => readSetting(SETTINGS_KEYS.displayName) ?? "");
  // ルーム一覧(サーバーから読んだもの。読めない時は保存済み・既定)と、
  // 聞くルーム(複数。"all" は常に含む)・話す先のルーム。前回の値を端末から復元する。
  const [channels, setChannels] = useState<ChannelItem[]>(loadSavedChannels);
  const [initialPrefs] = useState(loadSavedListenTalk);
  const [listen, setListen] = useState<string[]>(initialPrefs.listen);
  const [talkChannel, setTalkChannel] = useState(initialPrefs.talk);
  // connect() はイヤホン押下の再接続経路からも呼ばれるため、名前・ルームは
  // state ではなく ref から読む(state に依存すると入力のたびに connect が
  // 作り直され、PTTのイベント購読まで張り直しになる)。
  const identityRef = useRef(identity);
  const channelsRef = useRef(channels);
  const listenRef = useRef(listen);
  const talkChannelRef = useRef(talkChannel);
  // 個別に話す相手(null=個別でない)。自動で全員(ルーム)に戻す時間の起点は dmSinceRef
  // (最後に個別で話し終えた時刻。まだ話していなければ選んだ時刻)。端末には保存しない。
  const [dmTarget, setDmTarget] = useState<DmTarget | null>(null);
  const dmTargetRef = useRef<DmTarget | null>(null);
  const [dmSince, setDmSince] = useState(0);
  const dmSinceRef = useRef(0);
  const dmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 個別の残り時間の表示用の現在時刻(画面表示中だけ1秒ごとに進める)。
  const [nowTick, setNowTick] = useState(() => Date.now());
  // サーバーに知らせた受信許可(null=全員に許可 / identity=その人だけに許可)。接続ごとに戻る。
  const permTargetRef = useRef<string | null>(null);
  // マイクを開いている間の話す先(開いた時点でサーバーに知らせてあった値)。開いている間は
  // 話す先を変えないため、属性を送り直す時もこの値を使う。閉じ終えたら null。
  const micOpenTalkRef = useRef<string | null>(null);
  // 属性・受信許可の反映処理(同時に1つだけ)と、反映中に頼まれた「もう一度」。
  const syncPromiseRef = useRef<Promise<boolean> | null>(null);
  const syncAgainRef = useRef(false);
  // 「個別に話す」の候補(共通ルームにいる自分以外の人)。
  const [people, setPeople] = useState<Person[]>([]);
  // お知らせ(個別が自動で戻った等。エラーではない案内)。
  const [notice, setNotice] = useState<string | null>(null);
  // ルーム一覧を最後にサーバーへ取りに行った時刻(前面に戻るたびに取りに行きすぎない)。
  const channelsFetchedAtRef = useRef(0);
  // 無くなったルームの整理を送信中のため後回しにしたか、と整理の処理(後で定義する。
  // マイクを閉じ終えた時の処理から呼ぶため ref 経由)。
  const channelsPrunePendingRef = useRef(false);
  const channelsPruneRef = useRef<(why: string) => void>(() => {});
  // 今のルーム一覧がサーバーから読んだもの(端末に保存した分を含む)か。一度も読めていない
  // (既定の一覧)間は、それに無いルームを「削除された」として聞くルームから外さない。
  const channelsFromServerRef = useRef(readSetting(SETTINGS_KEYS.channels) !== null);
  // 「話す先のルームが無くなった」と知らせたルーム(同じ知らせを何度も出さない)。
  const missingTalkNotifiedRef = useRef<string | null>(null);
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
  // ロック中・ポケットの中からの送信(Apple PushToTalkフレームワーク)。
  const [pttJoined, setPttJoined] = useState(false);
  const [pttBusy, setPttBusy] = useState(false);
  // 物理ボタン(BLE: iTag型・PTTボタン型)の状態。ロック中でもGATT通知が届くため、
  // 押下でPTT送信を開始/停止する(押すたびON/OFF、または押している間だけ)。
  const [bleStatus, setBleStatus] = useState<BleButtonStatus>(readBleStatus);
  const [bleBusy, setBleBusy] = useState(false);
  // 最後に届いたボタンの状態(画面の状態表示「再接続待ち」「Bluetoothオフ」等に使う)。
  const [bleState, setBleState] = useState<BleButtonState | null>(null);
  // 登録直後(と「テスト」)の確認モードの残り秒数(0=確認中でない)と、その間の反応。
  const [bleTestLeft, setBleTestLeft] = useState(0);
  // presses=押した(トグル/押す)回数、released=離した通知も届いたか(押している間だけ方式の確認)。
  const [bleTestHit, setBleTestHit] = useState<{ presses: number; released: boolean } | null>(
    null,
  );
  // 確認モードの期限(押下ハンドラはイベント購読内から呼ばれるため ref で持つ)。
  const bleTestUntilRef = useRef(0);
  const bleTestTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
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
  // 「押している間だけ」方式の押す(down)でも立てる(上限60秒のタイマーを張るため)。
  const bleToggleInitiatedRef = useRef(false);
  // BLEボタンで始めた送信がどちらの方式か。handleBegin で張る自動停止の長さを決める
  // (押すたびON/OFF=30秒、押している間だけ=60秒)。
  const bleTxModeRef = useRef<BleButtonMode>("toggle");
  // ボタンで始めた前の送信の終了通知(onEndTransmitting)が届く前に、もう一度押された。
  // その場で開始を要求すると、遅れて届く終了通知が新しい押下の記録まで消してしまい
  // 「押しているのに送信されない」ため、終了通知を受けてから開始し直す(離す・解除で取り消し)。
  // at は押された時刻(古すぎる予約で、忘れた頃に送信が始まらないように)。
  const bleBeginAfterEndRef = useRef<{ mode: BleButtonMode; at: number } | null>(null);
  // 送信開始の確定待ちの見張り(BLE_BEGIN_WATCHDOG_MS)。
  const bleBeginWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 直接経路(Android / PTT未参加のiPhone)で、BLEボタンがマイクをONにしたか。
  // 切断・異常連打・解除の時に「ボタンで始めた送信」だけを確実に止めるために使う。
  const bleDirectActiveRef = useRef(false);
  // 直接経路の送信開始/停止の世代番号。話す先の反映を待っている間に止められた・押し直された
  // 送信を、反映後に開かないために使う(PTT経路の txGenRef と同じ考え方)。
  const directTxGenRef = useRef(0);
  // 直接経路で、話す先の反映を待ってマイクを開こうとしている処理の数(この間も「送信中」扱い)。
  const directOpeningRef = useRef(0);
  // BLEボタンの状態詳細(登録フローの案内文などを画面に出す)。
  const [bleDetail, setBleDetail] = useState<string | null>(null);
  // 画面の「押して話す」ボタンを押している間 true(表示用)。
  const [holding, setHolding] = useState(false);
  // 押した時にどちらの経路で送信を始めたか。離した時に同じ経路で止めるために覚えておく
  // (押している間に参加状態が変わっても、開始と停止の経路が食い違わないようにする)。
  const holdPathRef = useRef<"ptt" | "direct" | null>(null);
  // 今話している他のスタッフ(サーバーの音声検出による。自分に聞こえる人だけ)。
  // dm=自分あての個別。
  const [remoteSpeakers, setRemoteSpeakers] = useState<
    { key: string; text: string; dm: boolean }[]
  >([]);
  // 「詳細設定・診断」を開いているか。
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // 名前が保存されていない(勤務中の復元時に名前の入力が必要)。入力中に1文字目で
  // 入力欄が消えないよう、入力内容ではなく「保存済みの名前が無い」ことで判断する。
  const [nameMissing, setNameMissing] = useState(
    () => !(readSetting(SETTINGS_KEYS.displayName) ?? "").trim(),
  );
  // イヤホンのボタンを送信操作に割り当てられたか(null=まだ分からない)。
  // iOS 16 や割り当て失敗の時に「イヤホンのボタンで話せます」と誤表示しないため。
  const [accessoryOk, setAccessoryOk] = useState<boolean | null>(ACCESSORY_DEFAULT);
  // 勤務中か(wantConnectedRef と同じ意味の表示用)。PTT未参加のまま通信が途切れた時にも
  // 「勤務外」と表示せず、退勤ボタンを出し続けるために使う。
  const [shiftOn, setShiftOn] = useState(false);
  // Android: 勤務中サービス(ロック中もイヤホンのボタンを受け取る常駐)が動いているか。
  const [androidButtonReady, setAndroidButtonReady] = useState(
    () => AndroidPtt?.isRunning() ?? false,
  );
  // 端末ログインの状態。"needLogin" の間は医院のパスワード入力画面を出す。
  // (開発ビルドで旧方式のキーが埋め込まれている場合は、ログイン無しで使える)
  const [authState, setAuthState] = useState<"loading" | "needLogin" | "ok">("loading");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [hasDeviceToken, setHasDeviceToken] = useState(false);
  // トグル判定を最新値で行うための参照 + 自動OFFタイマー。
  const micOnRef = useRef(false);
  const autoOffRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 自動OFFの予約番号と、発火時に行う停止処理(null=予約なし)。Android では JS のタイマーと
  // ネイティブのタイマーの両方で待ち、先に来た方で一度だけ止める(armAutoOff を参照)。
  const autoOffSeqRef = useRef(0);
  const autoOffActionRef = useRef<(() => void) | null>(null);
  // 進行中の接続を共有する(同時に呼ばれた側は同じ結果を待つ。押下の取りこぼし防止)。
  const connectPromiseRef = useRef<Promise<boolean> | null>(null);
  // 勤務の世代番号。退勤のたびに増やす。接続処理は開始時の番号を覚えておき、
  // 途中で変わっていたら(=接続中に退勤された)作りかけの接続を捨てる。
  // これが無いと、再接続の最中に退勤すると、退勤後に接続が完了して
  // 勤務中に戻ってしまう(出勤処理ではイヤホンのボタンまで再び有効になる)。
  const shiftGenRef = useRef(0);
  // 退勤済みか(端末に保存し、アプリが終了→再起動されても引き継ぐ)。退勤時のPTT退出が
  // システムに拒否されてチャンネルが残った場合でも、退勤後にイヤホンのボタンで
  // 再接続・送信しないための最後の砦。出勤で解除する。
  const clockedOutRef = useRef(readSetting(SETTINGS_KEYS.clockedOut) === "1");
  // 画面表示用(退勤の処理が完了していない時の案内に使う)。
  const [clockedOut, setClockedOut] = useState(clockedOutRef.current);
  // 進行中の接続(connectPromiseRef)がどの世代で始まったか。
  const connectGenRef = useRef(0);
  // PTT送信の意図(トークボタンを押している間true)。
  // 再接続完了時に既に離されていたら送信しない=ホットマイク(切り忘れ)防止の要。
  const txActiveRef = useRef(false);
  // アプリが送信開始を要求した押下(画面のボタン・BLEボタン)の時刻(0=なし)。
  // 開始の確定(handleBegin)で受け取り、個別の期限を「押した時刻」で判断するのに使う。
  const pressAtRef = useRef(0);
  // PTTのシステム音声セッションが有効か(didActivate/didDeactivate)。
  const audioActiveRef = useRef(false);
  // 音声セッションの有効化を待っている処理(waitAudioActive)。onActivateAudio で解除する。
  const audioActiveWaitersRef = useRef(new Set<() => void>());
  // 公開済みのマイクのトラック(止める時に直接ミュートするため。接続ごとに作り直す)。
  const micTrackRef = useRef<LocalTrack | null>(null);
  // JSハートビート。iOSがアプリを休止するとintervalが止まるので、空白の長さが
  // 「どれだけ休止していたか」の目安になる(診断ログ用)。接続を作り直すかどうかの
  // 判定には使わない(LiveKit の実際の状態を linkHealth で見る)。
  const lastAliveRef = useRef(Date.now());
  // ロック中/バックグラウンドのPTT送信経路を後から確認するための診断ログ。
  // 画面が見えないタイミングの処理を、あとで(ロック解除後に)時系列で追える。
  // 行はまず ref に貯め、画面には前面にある時だけまとめて反映する(1行ごとに
  // setState すると、ロック中の送信の処理中にも画面全体の再描画が何度も走るため)。
  // 時刻は記録した瞬間のものなので、反映を遅らせても各段階の間隔は正確に残る。
  const [debugLog, setDebugLog] = useState<string[]>([]);
  const debugBufRef = useRef<string[]>([]);
  const debugFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushDebugLog = useCallback(() => {
    if (debugFlushTimerRef.current) {
      clearTimeout(debugFlushTimerRef.current);
      debugFlushTimerRef.current = null;
    }
    setDebugLog(debugBufRef.current.slice());
  }, []);
  const logDebug = useCallback((msg: string) => {
    const buf = debugBufRef.current;
    buf.push(`${logTime(new Date())} ${msg}`);
    // 1回の送信で10行前後出るため、数回分さかのぼれるよう多めに保持する。
    if (buf.length > DEBUG_LOG_MAX) buf.splice(0, buf.length - DEBUG_LOG_MAX);
    // 裏・ロック中は反映しない(前面に戻った時にまとめて反映する)。Android のロック中は
    // JSのタイマーが動かないので、タイマーにも頼らない。
    const appState = AppState.currentState;
    if (debugFlushTimerRef.current || appState === "background" || appState === "inactive") return;
    debugFlushTimerRef.current = setTimeout(() => {
      debugFlushTimerRef.current = null;
      setDebugLog(debugBufRef.current.slice());
    }, DEBUG_LOG_FLUSH_MS);
  }, []);

  // 前面に戻ったら、裏で貯まった診断ログを画面に反映する。
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") flushDebugLog();
    });
    return () => {
      sub.remove();
      if (debugFlushTimerRef.current) clearTimeout(debugFlushTimerRef.current);
    };
  }, [flushDebugLog]);

  // ---- 送信ごとの所要時間の記録 ----
  // 押下 → 開始要求 → 開始確定 → 音声有効 → マイクON を、押下からの経過ミリ秒で
  // 1行にまとめて診断ログに出す(ロック中の送信のどこで時間がかかっているかを、
  // 現場のログから読み取れるようにする)。ネイティブが押下を受け取った時刻が分かれば、
  // そこを起点にする(JSが起こされるまでの遅れも見える)。
  const txTraceRef = useRef<{ id: number; t0: number; marks: string[] } | null>(null);
  const txTraceSeqRef = useRef(0);
  const traceEnd = useCallback(
    (result: string) => {
      const tr = txTraceRef.current;
      if (!tr) return;
      txTraceRef.current = null;
      logDebug(`⏱ 送信#${tr.id} ${tr.marks.join(" → ")} [${result}]`);
    },
    [logDebug],
  );
  const traceStart = useCallback(
    (label: string, receivedAt: number, nativeAt?: number) => {
      // 前の記録が終わらないまま次が始まった(確定が来なかった等)。分かるように残す。
      if (txTraceRef.current) traceEnd("未完了");
      const marks: string[] = [];
      let t0 = receivedAt;
      const nativeDelay = nativeAt === undefined ? -1 : receivedAt - nativeAt;
      if (nativeDelay >= 0 && nativeDelay < TX_TRACE_MAX_MS) {
        t0 = receivedAt - nativeDelay;
        marks.push(`${label}(ネイティブ受信)+0`, `JS受信+${nativeDelay}`);
      } else {
        marks.push(`${label}+0`);
      }
      txTraceRef.current = { id: ++txTraceSeqRef.current, t0, marks };
    },
    [traceEnd],
  );
  const traceMark = useCallback(
    (label: string) => {
      const tr = txTraceRef.current;
      if (!tr) return;
      const elapsed = Date.now() - tr.t0;
      if (elapsed > TX_TRACE_MAX_MS) {
        traceEnd("未完了(時間切れ)");
        return;
      }
      tr.marks.push(`${label}+${elapsed}`);
    },
    [traceEnd],
  );

  // setupIOSAudioManagement相当を自前で実装し、各段階をlogDebugに出す。
  // WebRTCの録音/再生エンジンがON/OFFされる直前(willEnableEngine)・直後
  // (didDisableEngine)に呼ばれる。ここでAVAudioSessionのカテゴリ設定と
  // 有効化/無効化を行わないと、setMicrophoneEnabled自体は成功したように
  // 見えても実際には録音エンジンが起動しない。
  useEffect(() => {
    // iPhone専用(Android は下の connect() で LiveKit の音声セッションを直接開始する)。
    if (Platform.OS !== "ios") return;
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
          // PushToTalk が音声セッションを有効にしている最中(ロック中の送信)は、
          // 実機で動作確認済みの元の設定(allowBluetooth のみ)のまま変えない。
          // 有効なセッションのカテゴリを変えると経路の切り替えが起き、送信が
          // 直後に終わってしまう(イヤホンの押下が音楽アプリ側に回る)ことがあるため。
          await applyAudioCategory(speakerOnRef.current && !audioActiveRef.current, logDebug);
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
    if (autoOffActionRef.current) {
      autoOffActionRef.current = null;
      cancelNativeAutoOff();
    }
  }, []);

  // 自動OFF(切り忘れ防止・押している間だけ方式の上限)を予約する。前の予約は取り消す。
  // Android は画面ロックでアクティビティが一時停止すると JS の setTimeout が発火しない
  // (React Native の仕様)。ロック中・ポケットの中で始まった送信が止まらなくなるため、
  // ネイティブのタイマー(AndroidPtt.armAutoOff → onAutoOff)でも同じ時間を測る。
  const armAutoOff = useCallback(
    (ms: number, action: () => void) => {
      clearAutoOff();
      const seq = ++autoOffSeqRef.current;
      const fire = () => {
        // 取り消し済み・新しい予約に置き換わった後の発火は無視する。
        if (autoOffSeqRef.current !== seq || autoOffActionRef.current !== fire) return;
        clearAutoOff();
        action();
      };
      autoOffActionRef.current = fire;
      autoOffRef.current = setTimeout(fire, ms);
      if (Platform.OS === "android" && typeof AndroidPtt?.armAutoOff === "function") {
        try {
          AndroidPtt.armAutoOff(ms, seq);
        } catch (e) {
          logDebug(`自動停止: ネイティブのタイマーを使えません ${errMsg(e)}`);
        }
      }
    },
    [clearAutoOff, logDebug],
  );

  // ネイティブの自動OFFタイマーの発火(Android)。予約番号が今の予約と一致する時だけ止める。
  useEffect(() => {
    if (!AndroidPtt || typeof AndroidPtt.armAutoOff !== "function") return;
    const sub = AndroidPtt.addListener("onAutoOff", (payload) => {
      if (payload?.id !== autoOffSeqRef.current) return;
      autoOffActionRef.current?.();
    });
    return () => sub.remove();
  }, []);

  // BLEボタンの「送信開始の確定待ち」の見張りを止める(確定・終了・拒否のいずれかが来た時)。
  const clearBleBeginWatchdog = useCallback(() => {
    if (bleBeginWatchdogRef.current) {
      clearTimeout(bleBeginWatchdogRef.current);
      bleBeginWatchdogRef.current = null;
    }
  }, []);

  // BLEボタンで送信開始を要求した時に見張りを張る。BLE_BEGIN_WATCHDOG_MS 以内に
  // 確定(onBeginTransmitting)が来なければ、押下の記録を取り消す。
  // 記録が残ったままだと、次の押下が「開始」でなく「停止」と判定されて空振りしたり、
  // 遅れて届いた確定でマイクが開いたりする(取り消し後の確定は handleBegin が即終了させる)。
  const armBleBeginWatchdog = useCallback(() => {
    if (bleBeginWatchdogRef.current) clearTimeout(bleBeginWatchdogRef.current);
    bleBeginWatchdogRef.current = setTimeout(() => {
      bleBeginWatchdogRef.current = null;
      if (!bleToggleInitiatedRef.current && !bleTxIntentRef.current) return;
      logDebug("BLEボタン: 5秒待っても送信が始まらないため、押下の記録を取り消し");
      traceEnd("開始確定が来ない");
      bleTxIntentRef.current = false;
      bleToggleInitiatedRef.current = false;
    }, BLE_BEGIN_WATCHDOG_MS);
  }, [logDebug, traceEnd]);

  // 登録済みの物理ボタンへの接続維持を(再)開始し、画面の状態を読み直す。
  // 前面復帰・出勤のたびに呼ぶ(Bluetoothオフ・許可なし・ボタンが見つからない等の
  // 失敗からの再試行にもなる。ネイティブ側は二重に呼ばれても接続をやり直さない)。
  const restartBleButton = useCallback(() => {
    if (!BleButton) return;
    try {
      BleButton.start();
    } catch (e) {
      logDebug(`BLEボタン: 接続維持を開始できません ${errMsg(e)}`);
    }
    setBleStatus(readBleStatus());
  }, [logDebug]);

  // 物理ボタンの確認モード(BLE_TEST_MS の間、押下を表示するだけで送信しない)。
  const stopBleTest = useCallback(() => {
    bleTestUntilRef.current = 0;
    if (bleTestTimerRef.current) {
      clearInterval(bleTestTimerRef.current);
      bleTestTimerRef.current = null;
    }
    setBleTestLeft(0);
  }, []);
  const startBleTest = useCallback(() => {
    bleTestUntilRef.current = Date.now() + BLE_TEST_MS;
    setBleTestHit(null);
    setBleTestLeft(Math.ceil(BLE_TEST_MS / 1000));
    if (bleTestTimerRef.current) clearInterval(bleTestTimerRef.current);
    bleTestTimerRef.current = setInterval(() => {
      const left = Math.ceil((bleTestUntilRef.current - Date.now()) / 1000);
      if (left > 0) {
        setBleTestLeft(left);
        return;
      }
      bleTestUntilRef.current = 0;
      if (bleTestTimerRef.current) {
        clearInterval(bleTestTimerRef.current);
        bleTestTimerRef.current = null;
      }
      setBleTestLeft(0);
    }, 500);
  }, []);

  // ---- 聞くルーム・話す先・個別に話す(参加者属性・購読・受信許可) ----
  // 送信中(マイクを開いている・開こうとしている)か。この間は聞くルーム・話す先を変えない
  // (画面の操作は無効。個別の自動解除は送信が終わってから)。
  // (micOnRef は画面の状態から遅れて戻ることがあるので使わない。マイクを開いている間は
  // micOpenTalkRef、開く前は各経路の「押した」記録で判断する)
  const isTransmittingNow = useCallback(
    () =>
      micOpenTalkRef.current !== null ||
      txActiveRef.current ||
      bleTxIntentRef.current ||
      screenHoldRef.current ||
      holdPathRef.current !== null ||
      directOpeningRef.current > 0,
    [],
  );

  // 今サーバーに知らせるべき話す先(個別なら "dm:<相手>"、そうでなければ話す先のルーム)。
  const desiredTalk = useCallback(
    (): string =>
      dmTargetRef.current ? dmTalk(dmTargetRef.current.identity) : talkChannelRef.current,
    [],
  );
  // 実際に送る話す先。マイクを開いている間は、開いた時の値のまま(送信中に変えない)。
  const effectiveTalk = useCallback(
    (): string => micOpenTalkRef.current ?? desiredTalk(),
    [desiredTalk],
  );
  const desiredAttributes = useCallback(
    () =>
      buildAttributes({
        listen: listenRef.current,
        talk: effectiveTalk(),
        home: talkChannelRef.current,
      }),
    [effectiveTalk],
  );

  // 話す先と個別の受信許可がサーバーに反映済みか(マイクを開いてよいかの判定)。
  const isTalkReady = useCallback(
    (room: Room): boolean => {
      const talk = desiredTalk();
      if (permTargetRef.current !== dmTargetOf(talk)) return false;
      // 属性を更新できない接続では、相手からは「全体」あてに見える(ルームあてのつもりの声が
      // 全員に届き、個別も相手の画面で個別と分からない)。PC画面と同じく、「全体」あての時だけ話す。
      if (!canSetAttributes(room)) return talk === BROADCAST_CHANNEL;
      return (room.localParticipant.attributes[ATTR.talk] ?? "") === talk;
    },
    [desiredTalk],
  );
  // 属性すべて(聞くルームなど)と受信許可が反映済みか。
  const isTalkSynced = useCallback(
    (room: Room): boolean =>
      permTargetRef.current === dmTargetOf(effectiveTalk()) &&
      (!canSetAttributes(room) || attributesApplied(room.localParticipant, desiredAttributes())),
    [desiredAttributes, effectiveTalk],
  );

  // 相手のマイクを聞くかを、相手の話す先と自分の聞くルームから決めて購読に反映する。
  // 呼ぶたびにサーバーへ通知が飛ぶので、変わる時だけ呼ぶ。
  const applySubscription = useCallback((room: Room, p: RemoteParticipant) => {
    const pub = p.getTrackPublication(Track.Source.Microphone);
    if (!pub) return; // マイクの公開前。公開された時(TrackPublished)に決め直す
    const want = shouldHear(room.localParticipant.identity, listenRef.current, p.attributes);
    if (pub.isDesired !== want) pub.setSubscribed(want);
  }, []);
  const applyAllSubscriptions = useCallback(
    (room: Room) => {
      room.remoteParticipants.forEach((p) => applySubscription(room, p));
    },
    [applySubscription],
  );

  // 今話している人(サーバーの音声検出の最新の一覧)から、自分に聞こえる人だけを画面に出す。
  // 音声検出の通知は話している人の顔ぶれが変わった時にしか来ないので、聞くルーム・相手の
  // 話す先が変わった時にもここで出し直す(聞こえなくなった人を出し続けない・聞こえる人を漏らさない)。
  const activeSpeakersRef = useRef<Participant[]>([]);
  const refreshSpeakers = useCallback((room: Room) => {
    if (roomRef.current !== room) return;
    const lp = room.localParticipant;
    const self = lp.identity;
    const lines = activeSpeakersRef.current
      .filter((s) => s.sid !== lp.sid && shouldHear(self, listenRef.current, s.attributes))
      .map((s) => ({
        key: s.identity,
        text: speakerLabel(displayNameOf(s), self, s.attributes, channelsRef.current),
        dm: isDmTo(self, s.attributes),
      }));
    setRemoteSpeakers((prev) =>
      prev.length === lines.length &&
      prev.every((n, i) => n.key === lines[i].key && n.text === lines[i].text)
        ? prev
        : lines,
    );
  }, []);

  // 「個別に話す」の候補(共通ルームにいる自分以外の人)を読み直す。
  const refreshPeople = useCallback((room: Room) => {
    if (roomRef.current !== room) return;
    const list: Person[] = [];
    room.remoteParticipants.forEach((p) => {
      if (!p.identity) return;
      list.push({ identity: p.identity, name: displayNameOf(p), home: p.attributes[ATTR.home] ?? "" });
    });
    list.sort((a, b) => a.name.localeCompare(b.name, "ja") || a.identity.localeCompare(b.identity));
    setPeople((prev) =>
      prev.length === list.length &&
      prev.every(
        (x, i) =>
          x.identity === list[i].identity && x.name === list[i].name && x.home === list[i].home,
      )
        ? prev
        : list,
    );
  }, []);

  // 話す先・聞くルームを自分の参加者属性としてサーバーに知らせる(1回分)。
  // - 個別にする時は、先に「相手だけが受信できる」許可にしてから話す先を知らせる
  //   (他の人に届かないことはサーバーが守る)。
  // - 個別をやめる時は、先に話す先を知らせ、反映されてから全員に受信を許可する。
  // 受信許可の変更はサーバーの応答が無いが、通知は送った順に届くので、後から送った属性の
  // 反映が確かめられれば、許可も反映済みとみなせる。
  // マイクを開いている間は受信許可を変えない(広げない)。
  const runTalkSync = useCallback(
    async (room: Room): Promise<boolean> => {
      if (roomRef.current !== room) return false;
      if (room.state === ConnectionState.Disconnected || room.state === ConnectionState.Connecting) {
        return false;
      }
      const lp = room.localParticipant;
      const target = dmTargetOf(effectiveTalk());
      if (target !== null) {
        if (permTargetRef.current !== target) {
          if (micOpenTalkRef.current !== null) return false;
          lp.setTrackSubscriptionPermissions(false, [
            { participantIdentity: target, allowAll: true },
          ]);
          permTargetRef.current = target;
          logDebug(`個別: 受信できるのを ${target} だけにした`);
        }
        if (!canSetAttributes(room)) return true;
        return setAttributesAndWait(room, desiredAttributes(), ATTR_SYNC_TIMEOUT_MS, logDebug);
      }
      if (canSetAttributes(room)) {
        const applied = await setAttributesAndWait(
          room,
          desiredAttributes(),
          ATTR_SYNC_TIMEOUT_MS,
          logDebug,
        );
        if (!applied || roomRef.current !== room) return false;
      }
      // 待っている間に個別へ切り替わった・マイクを開いた時は、全員には許可しない。
      if (
        permTargetRef.current !== null &&
        micOpenTalkRef.current === null &&
        dmTargetOf(effectiveTalk()) === null
      ) {
        lp.setTrackSubscriptionPermissions(true);
        permTargetRef.current = null;
        logDebug("個別: 全員が受信できるように戻した");
      }
      return true;
    },
    [desiredAttributes, effectiveTalk, logDebug],
  );

  // 話す先・聞くルームの反映を(同時に1つだけ)行う。反映中に頼まれたら、終わった後に
  // 最新の値でもう一度行う。戻り値は、終わった時点で反映済みか。
  const syncRoomRef = useRef<Room | null>(null);
  const syncTalkState = useCallback((): Promise<boolean> => {
    const room = roomRef.current;
    if (!room) return Promise.resolve(false);
    if (syncPromiseRef.current && syncRoomRef.current === room) {
      syncAgainRef.current = true;
      return syncPromiseRef.current;
    }
    let promise: Promise<boolean> | null = null;
    promise = (async () => {
      let ok = false;
      try {
        do {
          syncAgainRef.current = false;
          ok = await runTalkSync(room);
        } while (syncAgainRef.current && roomRef.current === room);
      } catch (e) {
        logDebug(`属性: 反映に失敗 ${errMsg(e)}`);
        ok = false;
      } finally {
        if (syncPromiseRef.current === promise) {
          syncPromiseRef.current = null;
          syncRoomRef.current = null;
        }
      }
      return ok && roomRef.current === room && isTalkSynced(room);
    })();
    syncPromiseRef.current = promise;
    syncRoomRef.current = room;
    return promise;
  }, [isTalkSynced, logDebug, runTalkSync]);

  // 反映が必要なら行う(結果は待たない)。
  const requestTalkSync = useCallback(() => {
    const room = roomRef.current;
    if (!room) return;
    if (syncPromiseRef.current || !isTalkSynced(room)) void syncTalkState();
  }, [isTalkSynced, syncTalkState]);

  const roomTalkLabel = useCallback(
    () => channelLabel(talkChannelRef.current, channelsRef.current),
    [],
  );

  // 個別の状態だけを消す(サーバーへの反映は呼び出し側で)。
  const clearDmState = useCallback(() => {
    if (dmTimerRef.current) {
      clearTimeout(dmTimerRef.current);
      dmTimerRef.current = null;
    }
    dmTargetRef.current = null;
    setDmTarget(null);
  }, []);

  // 個別をやめて、話す先のルーム(全員)に戻す。
  const revertDm = useCallback(
    (reason: string, message: string | null) => {
      const dm = dmTargetRef.current;
      if (!dm) return;
      clearDmState();
      logDebug(`個別: ${dm.name}さんとの個別を終了(${reason}) → 話す先「${roomTalkLabel()}」`);
      if (message) setNotice(message);
      requestTalkSync();
    },
    [clearDmState, logDebug, requestTalkSync, roomTalkLabel],
  );

  // 個別の期限(最後に個別で話し終えてから DM_REVERT_MS)を確かめ、過ぎていれば全員(ルーム)に
  // 戻す。まだなら、その時刻にもう一度確かめるタイマーを張る。送信中は戻さない(マイクを閉じ終えた
  // 時に確かめる。送信が始まらずに終わる場合もあるので、DM_RECHECK_MS ごとにも確かめ直す)。
  // タイマーは裏・ロック中には止まることがある(Android のロック中は必ず止まる)ので、
  // 送信を始める時にも必ず確かめる(expireDmIfDue)。
  const checkDmExpiryRef = useRef<() => void>(() => {});
  const checkDmExpiry = useCallback(() => {
    if (dmTimerRef.current) {
      clearTimeout(dmTimerRef.current);
      dmTimerRef.current = null;
    }
    if (!dmTargetRef.current) return;
    if (isTransmittingNow()) {
      dmTimerRef.current = setTimeout(() => {
        dmTimerRef.current = null;
        checkDmExpiryRef.current();
      }, DM_RECHECK_MS);
      return;
    }
    const remaining = dmRemainingMs(dmSinceRef.current, Date.now());
    if (remaining <= 0) {
      revertDm(
        "時間切れ",
        `個別に話す時間（${DM_REVERT_MS / 1000}秒）が過ぎたため、話す先を「${roomTalkLabel()}」に戻しました`,
      );
      return;
    }
    dmTimerRef.current = setTimeout(() => {
      dmTimerRef.current = null;
      checkDmExpiryRef.current();
    }, remaining + 100);
  }, [isTransmittingNow, revertDm, roomTalkLabel]);
  useEffect(() => {
    checkDmExpiryRef.current = checkDmExpiry;
  }, [checkDmExpiry]);

  // 送信を始める時の個別の期限の確認(タイマーに頼らない)。過ぎていれば個別の状態を消す
  // (反映は呼び出し側で待つ)。戻した時は true。
  // 期限は「押した時刻(pressedAt)」で判断する。押した時にまだ個別の時間内なら、その後の
  // 音声の準備・接続の復旧を待つ間に期限を過ぎても個別のまま送る(個別のつもりの返事が
  // ルームの全員に届かないように)。
  const expireDmIfDue = useCallback(
    (label: string, pressedAt: number): boolean => {
      const dm = dmTargetRef.current;
      if (!dm || dmRemainingMs(dmSinceRef.current, pressedAt) > 0) return false;
      clearDmState();
      logDebug(
        `${label}: 個別の時間が過ぎていたため、話す先を「${roomTalkLabel()}」に戻してから送信`,
      );
      setNotice(
        `${dm.name}さんとの個別の時間（${DM_REVERT_MS / 1000}秒）が過ぎていたため、話す先を「${roomTalkLabel()}」（全員）に戻して送信しました`,
      );
      return true;
    },
    [clearDmState, logDebug, roomTalkLabel],
  );

  // 押した瞬間に、個別の期限の確認と話す先の反映を始めておく(待たない)。
  // システムの送信開始の確定(0.1〜0.5秒)と並行して進むので、その分早く話せる。
  // pressedAt は押した時刻(個別の期限の判断に使う)。
  const kickTalkSync = useCallback(
    (label: string, pressedAt: number) => {
      expireDmIfDue(label, pressedAt);
      const room = roomRef.current;
      if (room && !isTalkReady(room)) void syncTalkState();
    },
    [expireDmIfDue, isTalkReady, syncTalkState],
  );

  // マイクを開く直前に、話す先(個別の期限・参加者属性・受信許可)がサーバーに反映済みかを
  // 確かめる(true=このまま話してよい)。反映済みなら待たない(ふだんの送信は待ち時間なし)。
  // 個別の期限が押した時刻(pressedAt)で過ぎていれば、全員(ルーム)に戻して、その反映を
  // 待ってから話す。押した時に時間内だった個別は、ここで期限を過ぎていても戻さない。
  // 反映待ちはサーバーからの通知で進む(Android のロック中もタイマーに頼らない)。
  // maxWaitMs の上限は補助なので、呼び出し側でも押してからの経過時間(Date.now())を確かめること。
  const prepareTalk = useCallback(
    async (label: string, maxWaitMs: number, pressedAt: number): Promise<boolean> => {
      expireDmIfDue(label, pressedAt);
      const room = roomRef.current;
      if (!room) return false;
      if (isTalkReady(room)) return true;
      logDebug(`${label}: 話す先(${desiredTalk()})の反映を待つ`);
      traceMark("話す先の反映待ち");
      await withTimeout(syncTalkState(), maxWaitMs, false);
      const ready = roomRef.current === room && isTalkReady(room);
      logDebug(
        `${label}: 話す先の反映${ready ? "完了" : "が間に合わない"}${
          !ready && roomRef.current === room && !canSetAttributes(room)
            ? "(属性を更新できない接続のため「全体」あて以外は送らない)"
            : ""
        }`,
      );
      if (ready) traceMark("話す先の反映");
      return ready;
    },
    [desiredTalk, expireDmIfDue, isTalkReady, logDebug, syncTalkState, traceMark],
  );

  // 個別の相手が退出した時の処理(後で定義する。接続処理のイベントから呼ぶため ref 経由)。
  const dmTargetLeftRef = useRef<(identity: string, why: string) => void>(() => {});

  const cleanup = useCallback(async () => {
    clearAutoOff();
    try {
      await roomRef.current?.disconnect();
    } catch {
      // noop
    }
    roomRef.current = null;
    micTrackRef.current = null;
    // 受信許可・送信中の話す先は接続ごと(新しい接続は「全員に受信を許可」から始まる)。
    // 個別に話す相手は残す(接続し直した後も、相手がいれば個別のまま。いなければ全員に戻す)。
    permTargetRef.current = null;
    micOpenTalkRef.current = null;
    // 音声セッションの有効化/無効化は、上のエンジン連動処理(WebRTCの録音/再生
    // ON・OFFに追従)とPushToTalkに一本化しているため、ここでは手動で止めない
    // (手動でも止めると二重制御になり、PTT起動時などに活性化が失敗する原因になる)。
    setConnected(false);
    setMicOn(false);
    activeSpeakersRef.current = [];
    setRemoteSpeakers([]);
    setPeople([]);
  }, [clearAutoOff]);

  const connect = useCallback((): Promise<boolean> => {
    // 進行中の接続があれば同じ結果を待つ(PTT押下とUI操作が重なっても取りこぼさない)。
    // ただし退勤前に始まった接続は中止されるので、片付くのを待ってから改めて接続する。
    if (connectPromiseRef.current) {
      if (connectGenRef.current === shiftGenRef.current) return connectPromiseRef.current;
      return connectPromiseRef.current.then(() => connect());
    }

    const gen = shiftGenRef.current;
    connectGenRef.current = gen;
    const attempt = (async (): Promise<boolean> => {
      const startedAt = Date.now();
      let ownRoom: Room | null = null;
      // 接続中に退勤されたか。されていれば作りかけの接続を切って true を返す。
      const abandoned = async (): Promise<boolean> => {
        if (shiftGenRef.current === gen) return false;
        logDebug("connect: 接続中に退勤されたため中止");
        if (ownRoom) {
          if (roomRef.current === ownRoom) roomRef.current = null;
          try {
            await ownRoom.disconnect();
          } catch {
            // noop
          }
        }
        return true;
      };
      const displayName = identityRef.current.trim();
      // 音声サーバーのルームは全員共通。聞くルーム・話す先は接続後に参加者属性で知らせる。
      const room = SHARED_ROOM;
      if (displayName.length === 0) {
        logDebug("connect: スタッフ名が未入力のため中止");
        setError("スタッフ名を入力してください");
        return false;
      }
      if (displayName.length > DISPLAY_NAME_MAX) {
        setError(`スタッフ名は${DISPLAY_NAME_MAX}文字以内で入力してください`);
        return false;
      }
      if (DISPLAY_NAME_ALLOWED && !DISPLAY_NAME_ALLOWED.test(displayName)) {
        setError(
          "スタッフ名に使えない文字が含まれています（使える文字: 文字・数字・空白・「・」「_」「-」「.」）",
        );
        return false;
      }
      logDebug(
        `connect: 開始(${displayName} / 聞く=${listenRef.current.join(",")} 話す=${desiredTalk()})`,
      );
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
          if (Platform.OS === "android") {
            // Android: 通話用の設定で音声セッションを開始する。出力はイヤホン
            // (Bluetooth・有線)を優先し、無い時はスピーカー(または受話口)。
            await AudioSession.configureAudio({
              android: {
                preferredOutputList: [
                  "bluetooth",
                  "headset",
                  speakerOnRef.current ? "speaker" : "earpiece",
                ],
                audioTypeOptions: AndroidAudioTypePresets.communication,
              },
            });
            await AudioSession.startAudioSession();
          } else {
            await AudioSession.configureAudio({ ios: { defaultOutput: "speaker" } });
          }
        } catch (audioConfigError) {
          console.warn("audio route config skipped", audioConfigError);
        }

        // 発行から6時間以内の同じ条件のトークンがあれば使い回す(通信を1往復省く)。
        const data = await getLiveKitToken({
          identity: buildIdentity(displayName, getDeviceTag()),
          name: displayName,
          room,
        });
        logDebug(
          data.reusedAgeMs === null
            ? `connect: トークン取得OK(+${Date.now() - startedAt}ms)`
            : `connect: トークン再利用(発行から${Math.round(data.reusedAgeMs / 60_000)}分)(+${Date.now() - startedAt}ms)`,
        );
        if (await abandoned()) return false;

        const lkRoom = new Room();
        ownRoom = lkRoom;
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
          activeSpeakersRef.current = [];
          setRemoteSpeakers([]);
          setPeople([]);
          // 自分で切った場合(退勤・再接続のための作り直し)は何も表示しない。
          if (reason === DisconnectReason.CLIENT_INITIATED) return;
          if (reason === DisconnectReason.DUPLICATE_IDENTITY) {
            // 同じIDの別の接続に置き換えられた。自動再接続すると取り合いになる。
            wantConnectedRef.current = false;
            setShiftOn(false);
            setError(
              `同じ名前・端末IDの別の接続があったため切断されました。${
                pttJoinedRef.current ? "「再接続する」" : "「出勤する」"
              }を押すと、こちらに切り替わります`,
            );
            return;
          }
          // LiveKitが自動再接続を諦めた(レントゲン室など電波の届かない場所に
          // 1分以上いた等)。以前は何も表示せず、受信が止まったままになっていた。
          setError(
            pttJoinedRef.current
              ? "通信が途切れました。画面を開くか、イヤホンのボタンを押すと自動で再接続します"
              : "通信が途切れました。電波の届く場所で「再接続する」を押してください（アプリを開き直しても再接続します）",
          );
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
        // サーバーの音声検出は共通ルームの全員分が届く(購読と無関係)ので、自分に聞こえる人
        // (話す先が自分の聞くルーム・全体・自分あての個別)だけを出す。
        lkRoom.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
          if (roomRef.current !== lkRoom) return;
          const lp = lkRoom.localParticipant;
          const me = speakers.find((s) => s.sid === lp.sid);
          if (me) {
            logDebug(`サーバー計測: 自分の音声を検出 level=${me.audioLevel.toFixed(3)}`);
          }
          activeSpeakersRef.current = speakers;
          refreshSpeakers(lkRoom);
        });

        // ---- 共通ルームで「誰の声を聞くか」 ----
        // 自動購読は使わず(autoSubscribe:false)、相手の話す先と自分の聞くルームから1人ずつ
        // 購読を決める。話す先は話し始める前に変わる(変更はまれ)ので、購読は相手が話す前に
        // 済んでおり、受信の遅れは増えない。
        lkRoom.on(RoomEvent.ParticipantConnected, (p) => {
          if (roomRef.current !== lkRoom) return;
          applySubscription(lkRoom, p);
          refreshPeople(lkRoom);
        });
        lkRoom.on(RoomEvent.TrackPublished, (pub, p) => {
          if (roomRef.current !== lkRoom) return;
          if (pub.source === Track.Source.Microphone) applySubscription(lkRoom, p);
        });
        lkRoom.on(RoomEvent.ParticipantAttributesChanged, (_changed, p) => {
          if (roomRef.current !== lkRoom) return;
          if (p.isLocal) {
            // 自分の属性がサーバー側で変わった(反映の通知・完全な再接続で消えた等)。
            // 希望の値と違えば送り直す。
            applyAllSubscriptions(lkRoom);
            requestTalkSync();
            return;
          }
          applySubscription(lkRoom, p as RemoteParticipant);
          refreshPeople(lkRoom);
          // 話している最中に話す先が変わった人の表示(聞こえる・聞こえない・個別)を出し直す。
          refreshSpeakers(lkRoom);
        });
        lkRoom.on(RoomEvent.ParticipantDisconnected, (p) => {
          if (roomRef.current !== lkRoom) return;
          refreshPeople(lkRoom);
          if (dmTargetRef.current?.identity !== p.identity) return;
          // 完全な再接続の始まりにも、全員分の「退出」が先に届く(直後に同期的に再接続中になる)。
          // マイクロタスクで状態を確かめてから判断する(タイマーを使わないのでロック中も進む)。
          void Promise.resolve().then(() => {
            if (roomRef.current !== lkRoom) return;
            if (lkRoom.state !== ConnectionState.Connected) return; // 再接続中は Reconnected で確かめる
            if (lkRoom.remoteParticipants.has(p.identity)) return;
            dmTargetLeftRef.current(p.identity, "退出の通知");
          });
        });
        lkRoom.on(RoomEvent.Reconnected, () => {
          if (roomRef.current !== lkRoom) return;
          // 完全な再接続では購読が外れ、自分の属性も消えている。全員分を決め直し、属性を送り直す
          // (受信許可は LiveKit が送り直す)。
          logDebug("room: 再接続完了(購読・話す先を確かめ直す)");
          applyAllSubscriptions(lkRoom);
          refreshPeople(lkRoom);
          requestTalkSync();
          const dm = dmTargetRef.current;
          if (dm && !lkRoom.remoteParticipants.has(dm.identity)) {
            dmTargetLeftRef.current(dm.identity, "再接続後に見当たらない");
          }
        });
        lkRoom.on(RoomEvent.TrackSubscriptionFailed, (trackSid, p, reason) => {
          if (roomRef.current !== lkRoom) return;
          logDebug(`購読失敗: ${displayNameOf(p)} ${trackSid} ${String(reason ?? "")}`);
        });

        await lkRoom.connect(data.url, data.token, { autoSubscribe: false });
        logDebug(`connect: room.connect完了(+${Date.now() - startedAt}ms)`);
        if (await abandoned()) return false;
        // 新しい接続は「全員に受信を許可」から始まる(cleanup で記録も戻してある)。
        // 個別の設定中なら、マイクの準備(公開)より先に相手だけに絞る(下の反映の最初に行う。
        // 通知は送った順にサーバーに届く)。相手がもういなければ全員(ルーム)に戻す。
        const dmNow = dmTargetRef.current;
        if (dmNow && !lkRoom.remoteParticipants.has(dmNow.identity)) {
          dmTargetLeftRef.current(dmNow.identity, "接続し直した時にいなかった");
        }
        logDebug(
          `connect: 属性の更新権限=${String(lkRoom.localParticipant.permissions?.canUpdateMetadata ?? "不明")} 他の参加者${lkRoom.remoteParticipants.size}人`,
        );
        if (!canSetAttributes(lkRoom)) {
          // サーバーの更新前に発行されたトークン(属性の更新の許可なし)。この接続では「全体」あて
          // しか話せないので、次に接続し直す時は必ず取り直す(使い回さない)。
          clearTokenCache();
          logDebug("connect: 属性を更新できないトークンのため、使い回し用のトークンを捨てた");
        }
        // 接続前から居た人には ParticipantConnected/TrackPublished が来ないので、ここで全員分を決める。
        applyAllSubscriptions(lkRoom);
        refreshPeople(lkRoom);
        // 聞くルーム・話す先を知らせる(反映は待たない。送信の直前に確かめる)。
        void syncTalkState();
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
        if (await abandoned()) return false;
        micTrackRef.current =
          lkRoom.localParticipant.getTrackPublication(Track.Source.Microphone)?.track ?? null;
        established = true;
        setConnected(true);
        setMicOn(false);
        lastAliveRef.current = Date.now();
        wantConnectedRef.current = true;
        setShiftOn(true);
        // 次回起動時(バックグラウンド再起動を含む)に同じ名前・ルームで入れるよう保存。
        writeSettings({
          [SETTINGS_KEYS.displayName]: displayName,
          [SETTINGS_KEYS.room]: talkChannelRef.current,
          [SETTINGS_KEYS.listen]: serializeListen(listenRef.current),
        });
        setNameMissing(false);
        return true;
      } catch (e) {
        logDebug(`connect: エラー ${errMsg(e)}`);
        // 使い回したトークンが原因の可能性もあるので、次の接続では必ず取り直す。
        clearTokenCache();
        // 退勤による中止なら、エラーは出さない(後から始まった接続も壊さない)。
        if (await abandoned()) return false;
        await cleanup();
        showError(e, "接続に失敗しました");
        if ((e as { code?: unknown } | null)?.code === "device_token_invalid") {
          setHasDeviceToken(false);
          if (!INTERCOM_KEY) setAuthState("needLogin");
        }
        return false;
      } finally {
        setConnecting(false);
      }
    })().finally(() => {
      connectPromiseRef.current = null;
    });

    connectPromiseRef.current = attempt;
    return attempt;
  }, [
    applyAllSubscriptions,
    applySubscription,
    cleanup,
    desiredTalk,
    logDebug,
    refreshPeople,
    refreshSpeakers,
    requestTalkSync,
    syncTalkState,
  ]);

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

  // マイクを閉じ終えた後の処理: 個別で話していたなら自動で戻すまでの時間をここから数え直し、
  // 送信中に後回しにした話す先・聞くルームの変更や個別の期限を反映する。
  const afterMicClosed = useCallback(
    (endedTalk: string | null) => {
      const dm = dmTargetRef.current;
      if (endedTalk !== null && dm && endedTalk === dmTalk(dm.identity)) {
        const endedAt = Date.now();
        dmSinceRef.current = endedAt;
        setDmSince(endedAt);
      }
      checkDmExpiry();
      if (channelsPrunePendingRef.current) channelsPruneRef.current("送信中に後回しにした整理");
      requestTalkSync();
    },
    [checkDmExpiry, requestTalkSync],
  );
  // マイクのON/OFF。戻り値は切替が完了したか(失敗・接続なしは false)。
  const micOpSeqRef = useRef(0);
  const setMic = useCallback(
    async (on: boolean): Promise<boolean> => {
      // 呼び出しの順番(閉じ終えた時、後から「開く」が呼ばれていれば話す先の記録を消さない)。
      const seq = ++micOpSeqRef.current;
      const room = roomRef.current;
      if (!room) {
        logDebug(`setMic(${on}): roomなしのため無視`);
        // トグル側が先に記録した「意図」を実態(OFF)に戻す(次の押下が空振りしないように)。
        micOnRef.current = false;
        return false;
      }
      try {
        if (!on) {
          // 止める時は、まずトラックを直接ミュートする(この時点で声は送られなくなる)。
          // LiveKit が完全な再接続の後で音声を公開し直している最中は、
          // setMicrophoneEnabled(false) がその完了を待つため、それまでマイクが
          // 開いたままになってしまう。公開し直しの途中は一覧に無いので、覚えておいた
          // トラックも使う。
          const track =
            room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track ??
            micTrackRef.current;
          if (track && !track.isMuted) {
            track.mute().catch((e: unknown) => {
              logDebug(`setMic(false): 先行ミュートに失敗 ${errMsg(e)}`);
            });
          }
        } else if (micOpenTalkRef.current === null) {
          // この送信の話す先を記録する(閉じ終えるまで話す先・受信許可を変えない)。
          // 個別の受信許可(相手だけ)が出ていれば、それを優先して記録する(狭い方に倒す)。
          micOpenTalkRef.current =
            permTargetRef.current !== null
              ? dmTalk(permTargetRef.current)
              : room.localParticipant.attributes[ATTR.talk] || BROADCAST_CHANNEL;
        }
        // ミュート解除後の録音再開は、AudioDeviceModuleのミュートモードを
        // RestartEngine(アプリ起動時に設定)にすることでエンジンごと再起動させる。
        // トラックのrestartTrack()では直らないことを実測で確認済み
        // (トラック層ではなくエンジン層の問題のため)。
        await room.localParticipant.setMicrophoneEnabled(on);
        setMicOn(on);
        logDebug(`setMic(${on}): 完了${on ? `(話す先=${micOpenTalkRef.current ?? "?"})` : ""}`);
        if (on) {
          // 送信ONの2秒後に実測統計を自動で記録(押している間に計測される)。
          setTimeout(() => {
            void logMicStats("ON+2秒");
          }, 2000);
        }
        if (!on) {
          clearAutoOff();
          // 閉じ終えたので、送信中に後回しにした話す先の変更・個別の期限をここで反映する
          // (閉じている途中に次の「開く」が呼ばれていたら、その送信の記録なので残す)。
          if (micOpSeqRef.current === seq) {
            const endedTalk = micOpenTalkRef.current;
            micOpenTalkRef.current = null;
            afterMicClosed(endedTalk);
          }
        }
        return true;
      } catch (e) {
        logDebug(`setMic(${on}): エラー ${errMsg(e)}`);
        // 切替に失敗したら、トグル側が先に記録した「意図」を実態に戻す。
        micOnRef.current = room.localParticipant.isMicrophoneEnabled;
        // 開けなかったなら、話す先の記録も消す(閉じられなかった時は残す=話す先を変えない)。
        if (on && micOpSeqRef.current === seq && !room.localParticipant.isMicrophoneEnabled) {
          micOpenTalkRef.current = null;
        }
        showError(e, "マイクを操作できませんでした");
        return false;
      }
    },
    [afterMicClosed, clearAutoOff, logDebug, logMicStats],
  );

  // どの経路の送信も止める(個別の相手が退出した時など)。止める方向なので声は漏れない。
  // 開始の確定待ち・話す先の反映待ちの送信も取り消す(遅れて始まらないように)。
  const stopAllTransmission = useCallback(
    (reason: string) => {
      const pttOwned =
        txActiveRef.current ||
        bleTxIntentRef.current ||
        bleToggleInitiatedRef.current ||
        screenHoldRef.current ||
        nativePttTransmitting();
      logDebug(`送信を停止(${reason})`);
      txGenRef.current += 1;
      directTxGenRef.current += 1;
      txActiveRef.current = false;
      bleTxIntentRef.current = false;
      bleDirectActiveRef.current = false;
      bleBeginAfterEndRef.current = null;
      // 画面のボタンを押したままでも、遅れて届いた送信開始の確定はすぐ終了させる(handleBegin)。
      screenHoldRef.current = false;
      micOnRef.current = false;
      clearAutoOff();
      if (pttOwned) {
        PttChannel?.endTransmitting().catch((e) => {
          logDebug(`送信の停止に失敗 ${errMsg(e)}`);
        });
      }
      void setMic(false);
    },
    [clearAutoOff, logDebug, setMic],
  );

  // 個別の相手が退出した: すぐ全員(ルーム)に戻す。相手あてに送信中なら送信も止める
  // (相手がいないので誰にも届かず、送信中は話す先を変えられないため。止めずに
  // ルームあてに切り替えると、個別のつもりの話が全員に聞こえてしまう)。
  const handleDmTargetLeft = useCallback(
    (identity: string, why: string) => {
      const dm = dmTargetRef.current;
      if (!dm || dm.identity !== identity) return;
      const wasTransmitting = isTransmittingNow();
      clearDmState();
      logDebug(`個別: 相手(${dm.name})が退出したため全員(ルーム)に戻す(${why})`);
      if (wasTransmitting) stopAllTransmission("個別の相手が退出");
      setNotice(
        `個別に話していた${dm.name}さんが退出したため、${
          wasTransmitting ? "送信を止めて、" : ""
        }話す先を「${roomTalkLabel()}」に戻しました`,
      );
      requestTalkSync();
    },
    [clearDmState, isTransmittingNow, logDebug, requestTalkSync, roomTalkLabel, stopAllTransmission],
  );
  useEffect(() => {
    dmTargetLeftRef.current = handleDmTargetLeft;
  }, [handleDmTargetLeft]);

  // 直接経路でマイクを開く(話す先の反映を確かめてから)。stillWanted は反映を待った後に
  // 「まだ話すつもりか」を確かめる関数(離された・押し直された・止められたら false)。
  // 反映済みなら待たない。待ちが長引いた(押してから TALK_READY_WAIT_MS 超)時は開かない
  // (Android のロック中は上限のタイマーが動かないので、経過時間で判断する。忘れた頃に
  // 送信が始まる事故の防止)。戻り値はマイクを開いたか。
  const openMicDirect = useCallback(
    async (label: string, pressedAt: number, stillWanted: () => boolean): Promise<boolean> => {
      directOpeningRef.current += 1;
      try {
        const ready = await prepareTalk(label, TALK_READY_WAIT_MS, pressedAt);
        if (!stillWanted() || clockedOutRef.current) {
          logDebug(`${label}: 話す先の反映を待つ間に止められたため送信しない`);
          return false;
        }
        if (!ready || Date.now() - pressedAt > TALK_READY_WAIT_MS) {
          logDebug(`${label}: 話す先を切り替えられないため送信しない`);
          setError(
            "話す先の切り替えが完了しなかったため、送信しませんでした。もう一度押してください",
          );
          return false;
        }
        return await setMic(true);
      } finally {
        directOpeningRef.current -= 1;
        // 開かずに終わった時は、待っている間に止めていた個別の自動解除を確かめ直す。
        if (directOpeningRef.current === 0 && micOpenTalkRef.current === null) checkDmExpiry();
      }
    },
    [checkDmExpiry, logDebug, prepareTalk, setError, setMic],
  );

  // タップ/ハードボタン用トグル: ONにしたら AUTO_OFF_MS で自動OFF。
  // (Android のロック中も止まるよう、自動OFFは armAutoOff でネイティブのタイマーも使う)
  // 戻り値はマイクの切替が完了したか(所要時間の記録用)。
  const toggleMic = useCallback((autoOffMs: number = AUTO_OFF_MS): Promise<boolean> => {
    const next = !micOnRef.current;
    // 意図をすぐ記録する。micOnRef は送信の切替が終わってから更新されるため、
    // その間の2度目の押下が「停止」でなく「再開始」になってしまうのを防ぐ。
    micOnRef.current = next;
    const gen = ++directTxGenRef.current;
    clearAutoOff();
    if (!next) return setMic(false);
    armAutoOff(autoOffMs, () => {
      logDebug("自動停止(切り忘れ防止)");
      micOnRef.current = false;
      directTxGenRef.current += 1;
      void setMic(false);
    });
    return (async () => {
      const opened = await openMicDirect(
        "送信",
        Date.now(),
        () => directTxGenRef.current === gen && micOnRef.current,
      );
      if (!opened && directTxGenRef.current === gen) {
        // 開けなかった。意図を実態(OFF)に戻す(次の押下がまた「開始」になる)。念のため
        // 閉じ直す(閉じ終えると自動停止の予約も消える)。
        micOnRef.current = false;
        await setMic(false);
      }
      return opened;
    })();
  }, [armAutoOff, clearAutoOff, logDebug, openMicDirect, setMic]);


  // PTTのシステム音声セッション(AVAudioSession)が今有効か。ネイティブの状態を優先する。
  const pttAudioActiveNow = useCallback(
    (): boolean => nativePttAudioActive() ?? audioActiveRef.current,
    [],
  );

  // PTTのシステム音声セッション(AVAudioSession)が実際に有効になるまで待つ。
  // 実機ログで、待ち時間が700msだと間に合わず(onActivateAudioが1秒以上後に
  // 発火)、activated=falseのままsetMic(true)してしまうケースを確認した。
  // その場合、iOS側の録音エンジンがまだ起動していない状態でLiveKitがミュート
  // 解除するため、APIレベルでは成功に見えてもサーバーには音声が届かない。
  // 最大3秒まで待ち、戻り値で成否を呼び出し元に伝える。
  // 以前は50msごとに確かめていた(最大50msの遅れ)。今は onActivateAudio の通知で
  // 即座に再開する。PTT送信中(iPhone)だけ使うので、上限のタイマーは確実に動く。
  const waitAudioActive = useCallback((): Promise<boolean> => {
    if (pttAudioActiveNow()) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const waiters = audioActiveWaitersRef.current;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (ok: boolean) => {
        if (!waiters.delete(onActive)) return;
        if (timer) clearTimeout(timer);
        resolve(ok);
      };
      const onActive = () => finish(true);
      waiters.add(onActive);
      timer = setTimeout(() => finish(pttAudioActiveNow()), AUDIO_ACTIVE_WAIT_MS);
    });
  }, [pttAudioActiveNow]);

  // PTT送信開始: Appleの設計では「待機中はアプリ休止 → 話す瞬間に起こされる」。
  // 以前は休止明け(ハートビートの空白が8秒超)なら接続を信用せず毎回作り直していた
  // (片付け→トークン取得→接続→マイクの準備で1.5〜4秒。ロック中の押下はほぼ毎回
  // これになり、「押してから話せるまで2〜3秒」の主な原因だった)。
  // 今は LiveKit の実際の状態(linkHealth)を見て、本当に切れている時だけ作り直す。
  // 休止明けで LiveKit が切断を検知して自分で復旧している最中なら、その完了を待つ
  // (同じトラック・トークンのまま戻るので、作り直すより速い)。
  // 確認は「音声セッションの有効化(システム側で0.3〜1.2秒)を待った後」にも行う。
  // 休止明けの切断は、その間に LiveKit 自身が検知しているため。
  // 重要: 各段階で「まだ押されているか(txActiveRef)」を確認し、
  // 離された後にマイクONが発動する事故(ホットマイク)を防ぐ。マイクを開くのは
  // 音声セッションが有効になってから(onActivateAudio の後)だけ。
  // pressedAt は押した時刻(個別の期限の判断に使う。イヤホン・ロック画面のトークボタンは確定の時刻)。
  const pttTransmitStart = useCallback(async (pressedAt: number) => {
    txActiveRef.current = true;
    const gen = ++txGenRef.current;
    const startedAt = Date.now();
    // 接続の作り直し・LiveKit の復旧待ちにかけてよい時間の上限(この送信全体で)。
    const deadline = startedAt + RECONNECT_TIMEOUT_MS;

    // gap はアプリが休止していた時間の目安(診断用。判定には使わない)。
    const gapMs = startedAt - lastAliveRef.current;
    const room = roomRef.current;
    const health = linkHealth(room);
    logDebug(
      `PTT開始要求: 接続=${health} room.state=${room?.state ?? "なし"} 休止=${gapMs}ms rtt=${signalRtt(room)}ms`,
    );

    // 後から新しい送信が始まっていたら、この処理はもう何もしない(新しい送信の
    // 状態を誤って止めたり、マイクを開いたりしないため)。await のたびに確認する。
    const superseded = () => txGenRef.current !== gen;
    // 中断時は必ずシステム側の送信も終了させる。この関数が動いている時点で
    // requestBeginTransmittingは成功済み=システムは「送信中」を表示している。
    // ここで黙ってreturnすると、マイクは動いていないのにシステム表示だけが
    // 「送信中」のまま残る(ロック中のユーザーは無音送信に気づけない)。
    const abortTransmit = async (reason: string) => {
      logDebug(`PTT: 中断(${reason}) → システム送信を終了`);
      traceEnd(`中断: ${reason}`);
      txActiveRef.current = false;
      try {
        await PttChannel?.endTransmitting();
      } catch {
        // noop
      }
    };
    // 新しい送信に置き換わった、または離された(=もう続けない)か。
    const stopped = (during: string): boolean => {
      if (superseded()) return true;
      if (txActiveRef.current) return false;
      logDebug(`PTT: ${during}中に離された`);
      traceEnd("離された");
      return true;
    };
    // どの経路でマイクを開いたか(診断用)。
    let path = "高速";
    // 話せる接続を用意する。false = 中断済み・もう不要(呼び出し元はそのまま終わる)。
    const ensureLink = async (): Promise<boolean> => {
      let current = roomRef.current;
      let h = linkHealth(current);
      if (h === "resuming" && current) {
        path = "復旧待ち";
        logDebug("PTT: LiveKitが自動で復旧中 → 完了を待つ");
        traceMark("復旧待ち");
        const outcome = await waitRoomRecovery(
          current,
          Math.min(LINK_RECOVERY_WAIT_MS, deadline - Date.now()),
        );
        logDebug(`PTT: 復旧待ちの結果=${outcome}`);
        if (stopped("復旧待ち")) return false;
        if (outcome === "reconnected") {
          traceMark("復旧");
          return true;
        }
        current = roomRef.current;
        h = linkHealth(current);
      }
      if (h === "ok") return true;
      path = "再接続";
      logDebug("PTT: 再接続経路");
      traceMark("再接続開始");
      const remain = deadline - Date.now();
      let result: boolean | "timeout" = "timeout";
      if (remain > 0) {
        let raceTimer: ReturnType<typeof setTimeout> | undefined;
        result = await Promise.race([
          connect(),
          new Promise<"timeout">((resolve) => {
            raceTimer = setTimeout(() => resolve("timeout"), remain);
          }),
        ]);
        if (raceTimer) clearTimeout(raceTimer);
      }
      if (superseded()) return false;
      if (result === "timeout") {
        // この送信は諦めてシステムの「送信中」表示を消す(無音のまま送信中が
        // 続くのを防ぐ)。
        await abortTransmit("再接続タイムアウト");
        return false;
      }
      logDebug(`PTT: connect結果=${result}`);
      if (!result) {
        await abortTransmit("再接続失敗");
        return false;
      }
      traceMark("再接続完了");
      return !stopped("再接続");
    };

    // 話す先の反映(個別の期限切れの確認を含む)を、音声セッションの有効化を待つ間に進めておく
    // (イヤホン・ロック画面のトークボタンで始まった送信は、ここが最初の確認になる)。
    kickTalkSync("PTT", pressedAt);

    // 接続が無い・完全に切れている時は、すぐに作り直す(音声セッションの有効化は
    // その間にシステムが並行して進める)。
    if (health === "dead" && !(await ensureLink())) return;

    const activated = await waitAudioActive();
    logDebug(`PTT: audioActive待ち完了(activated=${activated})`);
    if (stopped("audioActive待ち")) return;
    if (!activated) {
      await abortTransmit("音声セッション未有効=録音できない状態");
      return;
    }
    // マイクを開く直前にもう一度確かめる(待っている間に切断が検知されていれば、
    // ここで復旧を待つか作り直す)。
    if (!(await ensureLink())) return;
    // 話す先(個別の期限・参加者属性・個別の受信許可)がサーバーに反映済みかを確かめる。
    // ふだんは反映済みで待たない。個別の期限切れ・接続し直しの直後だけ反映を待つ。
    const talkReady = await prepareTalk(
      "PTT",
      Math.min(TALK_READY_WAIT_MS, Math.max(0, deadline - Date.now())),
      pressedAt,
    );
    if (stopped("話す先の反映待ち")) return;
    if (!talkReady) {
      await abortTransmit("話す先を切り替えられない");
      setError("話す先の切り替えが完了しなかったため、送信しませんでした。もう一度押してください");
      return;
    }
    if (path === "高速") logDebug("PTT: 高速経路(再接続なし)");
    const opened = await setMic(true);
    if (opened) {
      traceMark("マイクON");
      traceEnd(`経路=${path}・休止${Math.round(gapMs / 1000)}秒`);
    } else {
      traceEnd("マイクON失敗");
    }
    if (!txActiveRef.current) {
      logDebug("PTT: setMic中に離されたため再OFF");
      await setMic(false);
    }
  }, [
    connect,
    kickTalkSync,
    logDebug,
    prepareTalk,
    setError,
    setMic,
    traceEnd,
    traceMark,
    waitAudioActive,
  ]);

  const pttTransmitEnd = useCallback(async () => {
    logDebug("PTT: 終了要求");
    txActiveRef.current = false;
    await setMic(false);
  }, [logDebug, setMic]);

  // PushToTalkフレームワークのイベントを購読。
  // システム(ロック画面/Dynamic Island)からの送信開始/停止で LiveKit のマイクをON/OFF。
  useEffect(() => {
    if (!PttChannel) return;
    // 送信開始が確定した時の処理(onBeginTransmitting と、購読前に始まっていた
    // 送信の引き継ぎの両方から呼ぶ)。
    const handleBegin = (source: string) => {
      logDebug(`PTT送信開始: ${source}`);
      // 押した時刻(個別の期限の判断用)。アプリが要求した送信は押下の時刻、それ以外
      // (イヤホン・ロック画面のトークボタン・起動時の引き継ぎ)はこの確定の時刻。
      const beganAt = Date.now();
      const requestedAt = pressAtRef.current;
      pressAtRef.current = 0;
      const pressedAt =
        source === PTT_SOURCE.app &&
        requestedAt > 0 &&
        requestedAt <= beganAt &&
        beganAt - requestedAt < PRESS_TIME_MAX_AGE_MS
          ? requestedAt
          : beganAt;
      // 所要時間の記録: アプリが要求した送信(押下の記録あり)なら「開始確定」を足す。
      // イヤホン・ロック画面のトークボタンは、ここが起点になる。
      const trace = txTraceRef.current;
      if (source === PTT_SOURCE.app && trace && Date.now() - trace.t0 < TX_TRACE_MAX_MS) {
        traceMark("開始確定");
      } else {
        traceStart(`開始確定(${source})`, Date.now());
      }
      // 確定が届いたので、BLEボタンの「確定待ち」の見張りは不要。
      clearBleBeginWatchdog();
      // 退勤済みなのにチャンネルが残っていた(退出がシステムに拒否された等)。
      // 再接続も送信もせずに止め、退出をやり直す(帰宅後の誤送信を防ぐ)。
      if (clockedOutRef.current) {
        logDebug("PTT: 退勤済みのため送信しない → 退出をやり直す");
        traceEnd("退勤済み");
        void PttChannel?.endTransmitting();
        void PttChannel?.leave().catch(() => {});
        return;
      }
      // アプリが要求した送信(画面のボタン/BLEボタン)なのに、確定した時点で
      // 画面のボタンは離されており、BLEも送信の意図が無い(2度押しで取り消し
      // 済み)なら、誰も話していない。マイクを開かずに即終了する。
      if (
        source === PTT_SOURCE.app &&
        !screenHoldRef.current &&
        !bleTxIntentRef.current
      ) {
        logDebug("PTT: 開始確定時には既に離されていた/取り消し済み → 即終了");
        traceEnd("確定時には離されていた");
        bleToggleInitiatedRef.current = false;
        void PttChannel?.endTransmitting();
        return;
      }
      // 切り忘れ防止タイマーは「送信開始が実際に確定した」この時点で張る。
      // 押下時(要求時)に張ると、要求が失敗した場合にタイマーだけが残り、
      // 30秒後に無関係な送信(ロック画面の長押しなど)を勝手に切ってしまう。
      // 対象はトグル動作の起点(BLEボタン・イヤホンのボタン)と、BLEボタンの
      // 「押している間だけ」方式。画面のボタンとロック画面のトークボタンは、指を
      // 離せば必ず止まるので対象外。BLEボタンの「押している間だけ」は、離した通知が
      // 電波の途切れ等で届かないと止まらないため、長め(60秒)の上限を張る。
      const fromEarphone = source === PTT_SOURCE.handsfree;
      if (bleToggleInitiatedRef.current || fromEarphone) {
        if (bleTxAutoOffRef.current) clearTimeout(bleTxAutoOffRef.current);
        const byBle = bleToggleInitiatedRef.current;
        const byBleHold = byBle && bleTxModeRef.current === "hold";
        const limitMs = byBle ? (byBleHold ? HOLD_MAX_MS : AUTO_OFF_MS) : EARPHONE_AUTO_OFF_MS;
        bleTxAutoOffRef.current = setTimeout(() => {
          logDebug(
            byBleHold
              ? "BLEボタン: 自動停止(押している間だけ方式の上限60秒)"
              : byBle
                ? "BLEボタン: 自動停止(切り忘れ防止)"
                : "イヤホン: 自動停止(切り忘れ防止)",
          );
          // 止めた後の次の押下が「停止」と判定されて空振りしないよう、意図も戻す。
          if (byBle) bleTxIntentRef.current = false;
          void PttChannel?.endTransmitting();
          // システム側の停止が失敗しても(停止通知が来なくても)、マイクは必ず閉じる。
          txActiveRef.current = false;
          void setMic(false);
        }, limitMs);
      }
      void pttTransmitStart(pressedAt);
    };

    const subs = [
      PttChannel.addListener("onJoin", () => {
        logDebug("PTTイベント: onJoin");
        setPttJoined(true);
      }),
      PttChannel.addListener("onLeave", () => {
        logDebug("PTTイベント: onLeave");
        setPttJoined(false);
        setAccessoryOk(ACCESSORY_DEFAULT);
      }),
      PttChannel.addListener("onBeginTransmitting", (payload) => {
        handleBegin((payload?.source as string | undefined) ?? "不明");
      }),
      PttChannel.addListener("onEndTransmitting", (payload) => {
        logDebug(`PTT送信停止: ${(payload?.source as string) ?? "不明"}`);
        // BLEトグルの意図・タイマーは、どの経路で終了しても確実にリセットする。
        bleTxIntentRef.current = false;
        bleToggleInitiatedRef.current = false;
        clearBleBeginWatchdog();
        if (bleTxAutoOffRef.current) {
          clearTimeout(bleTxAutoOffRef.current);
          bleTxAutoOffRef.current = null;
        }
        void pttTransmitEnd();
        // 前の送信の終了待ちだったボタンの押下があれば、ここで開始し直す。
        const pending = bleBeginAfterEndRef.current;
        bleBeginAfterEndRef.current = null;
        if (!pending) return;
        const age = Date.now() - pending.at;
        // 古い予約・退勤後・参加が外れた後は開始しない(忘れた頃に送信が始まる事故の防止)。
        if (
          clockedOutRef.current ||
          age < 0 ||
          age > BLE_REPLAY_MAX_AGE_MS ||
          !(pttJoinedRef.current || nativePttJoined())
        ) {
          logDebug(`BLEボタン: 終了待ちの押下を破棄(${age}ms前)`);
          return;
        }
        bleTxIntentRef.current = true;
        bleToggleInitiatedRef.current = true;
        bleTxModeRef.current = pending.mode;
        armBleBeginWatchdog();
        logDebug(
          `BLEボタン: 前の送信の終了を確認 → PTT送信開始(${pending.mode === "hold" ? "押している間だけ" : "押すたびON/OFF"})`,
        );
        traceStart("BLE押下(終了待ち)", pending.at);
        pressAtRef.current = pending.at;
        kickTalkSync("BLEボタン", pending.at);
        traceMark("開始要求");
        PttChannel?.beginTransmitting().catch((e) => {
          // 失敗したら意図もリセットする(離した時・次の押下で無関係な送信を止めないように)。
          bleTxIntentRef.current = false;
          bleToggleInitiatedRef.current = false;
          clearBleBeginWatchdog();
          logDebug(`BLEボタン: 開始失敗 ${errMsg(e)}`);
          traceEnd("開始失敗");
        });
      }),
      PttChannel.addListener("onActivateAudio", () => {
        // 重要: AVAudioSessionを実際に有効化しているのはApple PushToTalk
        // フレームワーク(PTChannelManager)であり、WebRTC自身ではない。
        // 録音エンジン(オーディオユニット)を確実に起動させる処理
        // (RTCAudioSession.isAudioEnabled)はネイティブ側(PttChannelModule.swift
        // のdidActivate)で同期的に行うようにした。JS側からの
        // audioSessionDidActivate呼び出しは非同期でタイミングが遅れうる上、
        // 二重に有効化状態を操作すると不整合の原因になるため、ここでは
        // 状態フラグの更新とマイクON待ち(waitAudioActive)の解除のみを行う。
        // マイクを開くのは pttTransmitStart だけにする(以前はここでも開いていたが、
        // 送信の世代の確認を通らず、作り直し中の接続に対して開くことがあった。
        // 待っている側は通知と同時に再開するので、遅れは生じない)。
        logDebug("PTTイベント: onActivateAudio");
        audioActiveRef.current = true;
        traceMark("音声有効");
        const waiters = [...audioActiveWaitersRef.current];
        for (const resume of waiters) resume();
      }),
      PttChannel.addListener("onDeactivateAudio", () => {
        logDebug("PTTイベント: onDeactivateAudio");
        audioActiveRef.current = false;
      }),
      PttChannel.addListener("onAccessoryButton", (payload) => {
        // イヤホン等のボタンを送信操作に割り当てられたか(iOS17+)。
        // これが有効なら、ポケットに入れたままイヤホンのボタンで送信できる。
        setAccessoryOk(!!payload?.enabled);
        if (payload?.enabled) {
          logDebug("イヤホンのボタン: Apple公式経路を有効化");
        } else if (payload?.error) {
          // 実際に失敗した場合のみ「不可」と表示する。
          logDebug(`イヤホンのボタン: Apple公式経路は使えません（${payload.error as string}）`);
        } else {
          // 現在のアプリからは無効化していない(旧ビルドの切替機能の名残)。
          logDebug("イヤホンのボタン: Apple公式経路が無効になりました");
        }
      }),
      PttChannel.addListener("onError", (payload) => {
        logDebug(`PTTイベント: onError ${JSON.stringify(payload)}`);
        const kind = payload?.kind as PttErrorKind | undefined;
        if (kind === "begin") {
          // 送信開始をシステムが拒否した(他のアプリで通話中など)。トグルの意図を
          // 戻し、次の押下がまた「開始」になるようにする。
          bleTxIntentRef.current = false;
          bleToggleInitiatedRef.current = false;
          clearBleBeginWatchdog();
          // 既に送信中(イヤホンで開始済み)の時に画面のボタンを押した場合も
          // 「送信中」として拒否されるが、離せば止まるので案内は出さない。
          if (screenHoldRef.current && !txActiveRef.current && !micOnRef.current) {
            setError("送信を開始できませんでした（通話中などの可能性）。もう一度押してください");
          }
        } else if (kind === "stop") {
          // システム側で送信を止められなかった。少なくともマイクは閉じる。
          // 終了待ちの開始予約も取り消す(終了通知がいつ届くか分からないため)。
          bleBeginAfterEndRef.current = null;
          txActiveRef.current = false;
          void setMic(false);
        } else if (kind === "leave") {
          // 退勤でPTTチャンネルから抜けられなかった。イヤホンのボタンが生きている
          // 可能性があるので、黙って流さず、退勤をやり直せるようにする。
          setPttJoined(nativePttJoined());
          setError("ロック中の送信を解除できませんでした。もう一度「退勤する」を押してください");
        } else if (kind === "join") {
          setPttJoined(false);
          setError(
            "ロック中に話す機能を開始できませんでした。アプリを開いたまま「ロック中でも話せるようにする」を押してください",
          );
        }
      }),
    ];

    // 購読前に始まっていた送信の引き継ぎ。iOSが終了させていたアプリを
    // イヤホンのボタンで起こした場合、送信開始の通知はJSの購読前に届いて
    // 捨てられている(システム上は送信中なのにマイクが開かず無音になる)。
    try {
      const native = PttChannel.getState?.();
      if (native?.audioActive) audioActiveRef.current = true;
      if (native?.transmitting && !txActiveRef.current) {
        logDebug("起動時: 送信中の状態を引き継ぎ");
        handleBegin(native.source ?? "不明");
      }
    } catch (e) {
      logDebug(`起動時: 送信状態の確認に失敗 ${errMsg(e)}`);
    }

    return () => subs.forEach((s) => s?.remove());
  }, [
    armBleBeginWatchdog,
    clearBleBeginWatchdog,
    kickTalkSync,
    logDebug,
    pttTransmitStart,
    pttTransmitEnd,
    setMic,
    setError,
    traceEnd,
    traceMark,
    traceStart,
  ]);

  // PTTチャンネルに参加/退出。
  const joinPtt = useCallback(async () => {
    if (!PttChannel) {
      setError("この端末ではロック中に話す機能を使えません(iOS 16以上が必要です)");
      return;
    }
    setPttBusy(true);
    try {
      logDebug("PTT参加: リクエスト開始");
      await PttChannel.join("MIRAI LINK");
      // JSだけリロードされた直後などは、ネイティブ側は既に参加済みで
      // didJoinChannel(onJoinイベント)が再度発火しないことがある。
      // join()のリクエスト自体が成功した時点で画面も確実に更新する。
      // ただし参加要求はシステム側で後から拒否されることがあり(他のアプリで通話中など)、
      // その通知(onError kind=join)が先に届いていれば、ネイティブは未参加に戻っている。
      // その場合に「参加済み」で上書きしない(待機中と表示されるのにイヤホンが効かなくなる)。
      let joinedNow = true;
      try {
        if (typeof PttChannel.getState === "function") joinedNow = PttChannel.getState().joined;
      } catch {
        // 状態が取れなければ従来どおり参加済みとして扱う
      }
      if (!joinedNow) {
        logDebug("PTT参加: システムに拒否された(エラー表示済み)");
        return;
      }
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
  // Android: 勤務中サービスを開始する(出勤時、画面が前面にある時だけ開始できる)。
  // 通知(Android 13+)と Bluetooth(Android 12+、イヤホンの音声経路に必要)の許可も求める。
  const startAndroidService = useCallback(async () => {
    if (Platform.OS !== "android" || !AndroidPtt) return;
    const level = typeof Platform.Version === "number" ? Platform.Version : 0;
    try {
      if (level >= 33) {
        await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
      }
      if (level >= 31) {
        await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT);
      }
    } catch (e) {
      logDebug(`Android: 許可の確認に失敗 ${errMsg(e)}`);
    }
    try {
      AndroidPtt.start("MIRAI LINK");
      setAndroidButtonReady(true);
      logDebug("Android: 勤務中サービスを開始(イヤホンのボタンを受け取ります)");
    } catch (e) {
      logDebug(`Android: 勤務中サービスを開始できません ${errMsg(e)}`);
      setError("ロック中にイヤホンで話す準備ができませんでした。「退勤する」→「出勤する」を試してください");
    }
  }, [logDebug, setError]);

  const startShift = useCallback(async () => {
    clockedOutRef.current = false;
    setClockedOut(false);
    writeSettings({ [SETTINGS_KEYS.clockedOut]: "0" });
    const gen = shiftGenRef.current;
    // 物理ボタンの接続維持も(再)開始する(音声サーバーへの接続と並行して繋がるように)。
    restartBleButton();
    const ok = await connect();
    // 接続中に退勤された場合は、ロック中の送信(PTT)を準備しない。
    if (!ok || shiftGenRef.current !== gen) return;
    if (Platform.OS === "android") {
      await startAndroidService();
      // 出勤時に「付近のデバイス」(Bluetooth)の許可をもらえた場合に備え、もう一度開始する
      // (許可が無い間はネイティブ側が接続しないため)。
      restartBleButton();
      return;
    }
    if (!PttChannel) return;
    if (pttJoinedRef.current || nativePttJoined()) {
      // 既に参加済み(復元されたチャンネルなど)。二重参加はしない。
      setPttJoined(true);
      return;
    }
    await joinPtt();
  }, [connect, joinPtt, restartBleButton, startAndroidService]);

  // 退勤: 送信を止め、PTTチャンネルから退出してから切断する。
  // 以前の「切断する」はLiveKitだけを切り、PTTチャンネルは参加したままだった。
  // そのため退勤後(通勤中に音楽を聴く時など)にイヤホンの再生ボタンを押すと、
  // 自動で再接続して診療室にマイクが開いてしまっていた。
  const endShift = useCallback(async () => {
    // 最初に(awaitより前に)世代を進め、進行中の接続・出勤処理を中止させる。
    shiftGenRef.current += 1;
    clockedOutRef.current = true;
    setClockedOut(true);
    writeSettings({ [SETTINGS_KEYS.clockedOut]: "1" });
    logDebug("退勤: 開始");
    setError(null);
    // 使い回し用のトークンも捨てる(次の出勤では必ず取り直す)。
    clearTokenCache();
    wantConnectedRef.current = false;
    setShiftOn(false);
    txActiveRef.current = false;
    bleTxIntentRef.current = false;
    bleToggleInitiatedRef.current = false;
    bleDirectActiveRef.current = false;
    bleBeginAfterEndRef.current = null;
    // 話す先の反映を待っている直接経路の送信も取り消す(退勤後に開かないように)。
    directTxGenRef.current += 1;
    micOnRef.current = false;
    clearBleBeginWatchdog();
    stopBleTest();
    screenHoldRef.current = false;
    // 個別に話す設定も終える(次の出勤は全員(ルーム)あてから始まる)。
    clearDmState();
    setNotice(null);
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
    if (AndroidPtt) {
      try {
        AndroidPtt.stop();
      } catch {
        // 動いていなければ何もしない
      }
      setAndroidButtonReady(false);
    }
    await cleanup();
    if (Platform.OS === "android") {
      AudioSession.stopAudioSession().catch(() => {});
    }
    logDebug("退勤: 完了");
  }, [cleanup, clearBleBeginWatchdog, clearDmState, logDebug, setError, stopBleTest]);

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
    if (Platform.OS !== "ios") {
      // Android は出勤(接続)時の出力先の優先順位で決まるため、次の出勤から反映される。
      logDebug("音声出力: 次の出勤から反映されます(Android)");
      return;
    }
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

  // ---- 聞くルーム・話す先・個別に話す(画面の操作) ----
  // 聞くルーム・話す先を変えて保存する(出勤中は接続し直さず、参加者属性と購読だけ変える)。
  // 話す先は聞くルームの中から選ぶ(聞いていないルームなら、聞くルームの先頭に戻す)。
  const applyChannelPrefs = useCallback(
    (nextListen: readonly string[], nextTalk: string, why: string) => {
      const listenIds = normalizeListen(nextListen);
      const talkId = pickTalkChannel(nextTalk, listenIds);
      if (sameStrings(listenIds, listenRef.current) && talkId === talkChannelRef.current) return;
      listenRef.current = listenIds;
      talkChannelRef.current = talkId;
      setListen(listenIds);
      setTalkChannel(talkId);
      writeSettings({
        [SETTINGS_KEYS.listen]: serializeListen(listenIds),
        [SETTINGS_KEYS.room]: talkId,
      });
      logDebug(`ルーム: ${why}(聞く=${listenIds.join(",")} 話す=${talkId})`);
      const room = roomRef.current;
      if (room) {
        applyAllSubscriptions(room);
        refreshSpeakers(room);
        requestTalkSync();
      }
    },
    [applyAllSubscriptions, logDebug, refreshSpeakers, requestTalkSync],
  );

  // ルーム一覧(サーバーから正しく読めたもの)に無くなったルームを、聞くルームから外す。
  // 話す先のルームが無くなった時は、話す先を勝手に別のルーム・「全体」に変えない(広げると、
  // そのルームの人だけに話すつもりの声が、ポケットの中のまま全員に届いてしまう)。話す先は
  // そのまま(聞くルームにも残す)にして知らせ、本人に選び直してもらう。
  // 送信中は聞くルームを変えないので、マイクを閉じ終えた時・次にルーム一覧を読む時にやり直す。
  const pruneMissingChannels = useCallback(
    (why: string) => {
      if (!channelsFromServerRef.current) return;
      if (isTransmittingNow()) {
        if (!channelsPrunePendingRef.current) {
          logDebug(`ルーム: 送信中のため、無くなったルームの整理は送信の後に行う(${why})`);
        }
        channelsPrunePendingRef.current = true;
        return;
      }
      channelsPrunePendingRef.current = false;
      const ids = channelsRef.current.map((c) => c.id);
      const talk = talkChannelRef.current;
      const kept = listenRef.current.filter((id) => ids.includes(id) || id === talk);
      if (kept.length !== listenRef.current.length) applyChannelPrefs(kept, talk, why);
      if (ids.includes(talk)) {
        missingTalkNotifiedRef.current = null;
      } else if (missingTalkNotifiedRef.current !== talk) {
        missingTalkNotifiedRef.current = talk;
        logDebug(`ルーム: 話す先「${talk}」が一覧に無い → 話す先は変えずに知らせる`);
        setNotice(
          `話す先のルーム「${talk}」は管理画面で削除されました。話す先を選び直してください（選び直すまでは、ほかの人に声が届かないことがあります）`,
        );
      }
    },
    [applyChannelPrefs, isTransmittingNow, logDebug],
  );
  useEffect(() => {
    channelsPruneRef.current = pruneMissingChannels;
  }, [pruneMissingChannels]);

  // 聞くルームの追加・解除(「全体」は常に聞くので外せない)。送信中は変えない。
  const toggleListen = useCallback(
    (id: string) => {
      if (id === BROADCAST_CHANNEL || isTransmittingNow()) return;
      const current = listenRef.current;
      applyChannelPrefs(
        current.includes(id) ? current.filter((x) => x !== id) : [...current, id],
        talkChannelRef.current,
        "聞くルームを変更",
      );
    },
    [applyChannelPrefs, isTransmittingNow],
  );

  // 話す先のルームを選ぶ。個別に話す設定中なら、それを終えてこのルームに話す。送信中は変えない。
  const chooseTalkChannel = useCallback(
    (id: string) => {
      if (isTransmittingNow()) return;
      const dm = dmTargetRef.current;
      if (dm) {
        clearDmState();
        logDebug(`個別: ルームを選んだため${dm.name}さんとの個別を終了`);
        setNotice(null);
      }
      const current = listenRef.current;
      applyChannelPrefs(current.includes(id) ? current : [...current, id], id, "話す先を変更");
      // 無くなったルームを話す先にしていた場合は、選び直したので聞くルームからも外す。
      pruneMissingChannels("無くなったルームの代わりに話す先を選んだ");
      // 個別をやめただけ(ルームは同じ)の時も、サーバーに知らせる。
      requestTalkSync();
    },
    [
      applyChannelPrefs,
      clearDmState,
      isTransmittingNow,
      logDebug,
      pruneMissingChannels,
      requestTalkSync,
    ],
  );

  // 個別に話す相手を選ぶ(共通ルームにいる人だけ)。選んだ人だけに声が届く設定になる。
  // 最後に話し終えてから DM_REVERT_MS(まだ話していなければ選んでから)で全員(ルーム)に戻る。
  const selectDmTarget = useCallback(
    (person: Person) => {
      if (isTransmittingNow()) return;
      const room = roomRef.current;
      if (!room || !person.identity || !room.remoteParticipants.has(person.identity)) {
        setNotice(`${person.name}さんは退出しています`);
        if (room) refreshPeople(room);
        return;
      }
      const target: DmTarget = { identity: person.identity, name: person.name };
      const since = Date.now();
      dmTargetRef.current = target;
      setDmTarget(target);
      dmSinceRef.current = since;
      setDmSince(since);
      setNowTick(since);
      setNotice(null);
      logDebug(`個別: ${person.name}さん(${person.identity})だけに話す設定にした`);
      checkDmExpiry();
      requestTalkSync();
    },
    [checkDmExpiry, isTransmittingNow, logDebug, refreshPeople, requestTalkSync],
  );

  // 「全員（ルーム）に戻す」ボタン。送信中は変えない。
  const revertDmManually = useCallback(() => {
    if (isTransmittingNow()) return;
    revertDm("手動", null);
    setNotice(null);
  }, [isTransmittingNow, revertDm]);

  // サーバーから読んだルーム一覧を反映して保存する。管理画面で消されたルームは、
  // 聞くルームから外す(話す先は変えずに知らせる。pruneMissingChannels)。
  // サーバーが保存先を読めなかった時は 503 になり、ここには来ない(保存済みの一覧のまま)。
  const applyServerChannels = useCallback(
    (list: ChannelItem[]) => {
      const prev = channelsRef.current;
      const same =
        prev.length === list.length &&
        prev.every(
          (c, i) =>
            c.id === list[i].id &&
            c.label === list[i].label &&
            c.description === list[i].description,
        );
      if (!same) {
        channelsRef.current = list;
        setChannels(list);
        writeSettings({ [SETTINGS_KEYS.channels]: JSON.stringify(list) });
      }
      channelsFromServerRef.current = true;
      pruneMissingChannels("管理画面で削除されたルームを外した");
    },
    [pruneMissingChannels],
  );

  // ルーム一覧をサーバーから読み直す(起動時・前面に戻った時・ログイン後)。失敗しても
  // 保存済みの一覧で動き続ける。端末トークンが無効なら、勤務外の時だけ再ログインを促す
  // (勤務中は今の接続を止めない。次に接続し直す時にトークン取得側で案内される)。
  const refreshChannels = useCallback(
    async (why: string) => {
      // 送信中だったために後回しにした、無くなったルームの整理があれば先に行う。
      if (channelsPrunePendingRef.current) pruneMissingChannels("送信中に後回しにした整理");
      const startedAt = Date.now();
      if (startedAt - channelsFetchedAtRef.current < CHANNELS_REFRESH_MIN_MS) return;
      // 端末トークンが無い(未ログイン・開発用の旧方式キーだけ)なら読めないので何もしない。
      if (!(await loadDeviceToken())) return;
      channelsFetchedAtRef.current = startedAt;
      try {
        const list = await fetchChannels();
        applyServerChannels(list);
        logDebug(`ルーム一覧: 取得(${why}) ${list.map((c) => c.label).join("・")}`);
      } catch (e) {
        channelsFetchedAtRef.current = 0;
        logDebug(`ルーム一覧: 取得できません(${why}) ${errMsg(e)} → 保存済みの一覧を使います`);
        if ((e as { code?: unknown } | null)?.code === "device_token_invalid") {
          // 勤務中でも、使い回し用の音声サーバーのトークンは捨てる(今の接続は切らないが、
          // 次に接続し直す時はトークンを取り直し、無効なら再ログインの案内になる)。
          clearTokenCache();
          if (!wantConnectedRef.current && !pttJoinedRef.current) {
            await saveDeviceToken(null);
            setHasDeviceToken(false);
            if (!INTERCOM_KEY) setAuthState("needLogin");
            showError(e, "ログインの有効期限が切れました");
          }
        }
      }
    },
    [applyServerChannels, logDebug, pruneMissingChannels, showError],
  );

  // 個別の残り時間の表示を、画面を見ている間だけ1秒ごとに進める。
  useEffect(() => {
    if (!dmTarget) return;
    setNowTick(Date.now());
    const id = setInterval(() => {
      if (AppState.currentState === "active") setNowTick(Date.now());
    }, 1000);
    return () => clearInterval(id);
  }, [dmTarget]);

  // 「話す」ホールド: 押している間だけ送信(PTKit経由)。
  const pttPressIn = useCallback(() => {
    screenHoldRef.current = true;
    const pressedAt = Date.now();
    pressAtRef.current = pressedAt;
    traceStart("画面のボタン", pressedAt);
    kickTalkSync("画面のボタン", pressedAt);
    traceMark("開始要求");
    PttChannel?.beginTransmitting().catch((e) => {
      screenHoldRef.current = false;
      logDebug(`PTT: 開始失敗 ${errMsg(e)}`);
      traceEnd("開始失敗");
      if (!nativePttJoined()) {
        // ネイティブ側でチャンネルから外れていた。表示を実態に合わせ、
        // 「ロック中でも話せるようにする」ボタンを出す(次の押下は画面から直接送る)。
        setPttJoined(false);
        setError("ロック中に話す機能が外れていました。「ロック中でも話せるようにする」を押してください");
      } else {
        setError("送信を開始できませんでした。もう一度押してください");
      }
    });
  }, [kickTalkSync, logDebug, setError, traceEnd, traceMark, traceStart]);
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
    // 接続もPTTも無い時は何も送れない(押している最中に無効化すると離した操作が
    // 届かなくなることがあるため、ボタン自体は無効化せずここで案内する)。
    if (!connectedRef.current && !pttJoinedRef.current) {
      setError("接続されていません。「再接続する」を押してから話してください");
      return;
    }
    setHolding(true);
    setError(null);
    if (pttJoinedRef.current && PttChannel) {
      holdPathRef.current = "ptt";
      pttPressIn();
    } else {
      holdPathRef.current = "direct";
      const gen = ++directTxGenRef.current;
      void (async () => {
        // 話す先の反映を確かめてから開く(待っている間に指を離したら開かない)。
        await openMicDirect(
          "画面のボタン",
          Date.now(),
          () => holdPathRef.current === "direct" && directTxGenRef.current === gen,
        );
        // 開いている途中で指を離した(離した時の OFF が先に終わった)なら閉じ直す。
        if (holdPathRef.current !== "direct" && directTxGenRef.current === gen) {
          await setMic(false);
        }
      })();
    }
  }, [openMicDirect, pttPressIn, setMic, setError]);
  const talkPressOut = useCallback(() => {
    setHolding(false);
    const path = holdPathRef.current;
    holdPathRef.current = null;
    if (path === "ptt") pttPressOut();
    else if (path === "direct") void setMic(false);
  }, [pttPressOut, setMic]);

  // BLEボタンで始めた送信(開始の確定待ちを含む)があれば止める。止めた時は true。
  // 「離す」を受けた時のほか、ボタンが使えなくなった時(切断・異常連打での一時停止・
  // Bluetoothオフ・登録解除・再登録の開始・方式の変更)にも呼ぶ。トグル方式でONにした
  // 送信は、ボタンが使えなくなると誰も止められない(ホットマイク)ため。
  // ボタン起点でない送信(画面のボタン・イヤホン・ロック画面のトークボタン)には触らない。
  const stopBleTransmission = useCallback(
    (reason: string): boolean => {
      const pttOwned = bleTxIntentRef.current || bleToggleInitiatedRef.current;
      const directOwned = bleDirectActiveRef.current;
      bleTxIntentRef.current = false;
      bleDirectActiveRef.current = false;
      // 終了待ちの開始予約も取り消す(離した・ボタンが使えなくなった後に送信を始めない)。
      if (bleBeginAfterEndRef.current) {
        bleBeginAfterEndRef.current = null;
        logDebug(`BLEボタン: ${reason} → 開始の予約を取り消し`);
      }
      if (!pttOwned && !directOwned) return false;
      logDebug(`BLEボタン: ${reason} → ボタンで始めた送信を停止`);
      if (pttOwned) {
        // bleToggleInitiatedRef は終了通知(onEndTransmitting)で戻す。確定前なら
        // 意図を消したので、遅れて届いた確定は handleBegin が即終了させる。
        PttChannel?.endTransmitting().catch((e) => {
          logDebug(`BLEボタン: 停止失敗 ${errMsg(e)}`);
        });
      }
      if (directOwned) {
        micOnRef.current = false;
        void setMic(false);
      }
      return true;
    },
    [logDebug, setMic],
  );

  // 物理ボタン(BLE)の押下。payload.kind で動作を分ける(無ければ旧ネイティブ = トグル)。
  // - toggle: 押すたびに送信ON/OFF(iTag型・トグル方式。30秒で自動停止)
  // - down/up: 押している間だけ送信(離した通知を送るPTTボタン型。60秒が上限)
  // PTT参加中はPTKit経由(ロック中でも動く)。未参加で通常接続中なら直接マイクを操作する。
  // キーボード型リモコン(useRemotePtt)からは引数なしで呼ばれ、トグルとして扱う。
  // 依存は ref と安定したコールバックのみ(識別子が変わるとイベント購読が張り直しになる)。
  const handleBlePress = useCallback(
    (payload?: BlePressEvent | null) => {
      // JSが押下を受け取った時刻(所要時間の記録の起点。ネイティブの受信時刻が分かればそちら)。
      const receivedAt = Date.now();
      const fromKeyboard = payload === undefined;
      const kind: BlePressKind =
        payload?.kind === "down" || payload?.kind === "up" ? payload.kind : "toggle";
      const replayed = payload?.replayed === true;
      const ageMs = typeof payload?.ageMs === "number" ? payload.ageMs : 0;
      const nativeAt =
        typeof payload?.atMs === "number"
          ? payload.atMs
          : replayed && ageMs > 0
            ? receivedAt - ageMs
            : undefined;
      // 押した時刻(個別の期限の判断用)。再送された押下は、実際に押された時刻にする。
      const pressedAt = replayed && ageMs > 0 ? receivedAt - ageMs : receivedAt;
      const traceLabel = fromKeyboard ? "リモコン押下" : replayed ? "BLE押下(再送)" : "BLE押下";
      const tag = fromKeyboard
        ? "リモコン(キーボード型)"
        : `BLEボタン(${BLE_KIND_LABEL[kind]}${replayed ? `・${ageMs}ms前の再送` : ""})`;

      // 古い押下の再送は捨てる(押したのに反応せず、忘れた頃に送信が始まる事故の防止)。
      // 「離す」は止める方向なので、どれだけ古くても受け付ける。
      if (replayed && kind !== "up" && ageMs > BLE_REPLAY_MAX_AGE_MS) {
        logDebug(`${tag}: 古い押下のため無視`);
        return;
      }
      const bleOwnsTx =
        bleTxIntentRef.current || bleToggleInitiatedRef.current || bleDirectActiveRef.current;
      // 確認モード中: 反応を表示するだけで送信しない。ただし、ボタンで始めた送信が
      // 残っている時の「離す」は、止める方向なので通常どおり処理する。
      // 送信しないので退勤中でも受け付ける(出勤前にボタンの登録・確認ができるように)。
      if (
        !fromKeyboard &&
        Date.now() < bleTestUntilRef.current &&
        !(kind === "up" && bleOwnsTx)
      ) {
        logDebug(`${tag}: 確認中のため送信しない`);
        setBleTestHit((prev) => ({
          presses: (prev?.presses ?? 0) + (kind === "up" ? 0 : 1),
          released: (prev?.released ?? false) || kind === "up",
        }));
        return;
      }
      // 退勤後は何もしない(帰宅後に服のボタンが押されても送信しない)。
      if (clockedOutRef.current) {
        logDebug(`${tag}: 退勤済みのため無視`);
        return;
      }

      // 参加状態は「ネイティブの真実」も確認する。アプリがメモリ回収→
      // バックグラウンド復元された直後は、JS側のpttJoinedRefがまだfalseでも
      // ネイティブのPTChannelManagerは参加済みのことがある(この確認が無いと、
      // 復元後の押下がすべて「未接続のため無視」になり、ロック運用が死ぬ)。
      const nativeJoined = nativePttJoined();
      const joined = (pttJoinedRef.current || nativeJoined) && !!PttChannel;
      if (joined && nativeJoined && !pttJoinedRef.current) {
        setPttJoined(true);
      }

      if (kind === "up") {
        // まずボタンで始めた送信を止める(始めた経路で止めるので、押している間に
        // PTTの参加状態が変わっても止め損ねない)。
        if (stopBleTransmission("離した")) return;
        // ボタン起点の送信が見当たらない「離す」(切断時にネイティブが合成したもの等)。
        // 画面のボタンを押している最中なら、その送信は指を離せば止まるので触らない。
        if (screenHoldRef.current || holdPathRef.current !== null) {
          logDebug(`${tag}: 画面のボタンで送信中のため何もしない`);
          return;
        }
        // 最後にボタンを「押している間だけ」方式で使った時だけ、残っている送信を止める
        // (「離した」のに送信が続くことだけは避ける。止める方向なので声は漏れない)。
        // トグル方式では、切断のたびにネイティブが念のための「離す」を合成して送る。
        // ボタンの送信は上の stopBleTransmission で止めてあるので、ここで止めると
        // イヤホン・ロック画面のトークボタンで話している無関係な送信を途中で切ってしまう。
        if (
          bleTxModeRef.current === "hold" &&
          (txActiveRef.current || micOnRef.current || nativePttTransmitting())
        ) {
          logDebug(`${tag}: 送信中のため停止`);
          if (joined) {
            PttChannel?.endTransmitting().catch((e) => {
              logDebug(`BLEボタン: 停止失敗 ${errMsg(e)}`);
            });
          } else {
            micOnRef.current = false;
            void setMic(false);
          }
          return;
        }
        logDebug(`${tag}: ボタンで始めた送信が無いため何もしない`);
        return;
      }

      // ボタンで始めた前の送信が、終了の途中(停止を要求したが終了通知が未着)か。
      // この間に開始を要求すると、遅れて届く終了通知が新しい押下の記録を消してしまう。
      const ownTxEnding = () =>
        bleToggleInitiatedRef.current &&
        !bleTxIntentRef.current &&
        (txActiveRef.current || nativePttTransmitting());

      if (joined && PttChannel) {
        if (kind === "down") {
          // 押している間だけ方式の「押す」。重複は無視する(ネイティブでも抑止済み)。
          if (bleTxIntentRef.current) {
            logDebug(`${tag}: すでに送信中のため無視`);
            return;
          }
          if (ownTxEnding()) {
            // 離してすぐ押し直した。終了通知を受けてから開始する(離せば取り消し)。
            bleBeginAfterEndRef.current = { mode: "hold", at: Date.now() };
            logDebug(`${tag}: 前の送信の終了待ち → 終わり次第開始します`);
            return;
          }
          bleTxIntentRef.current = true;
          bleTxModeRef.current = "hold";
          if (txActiveRef.current) {
            // 別の経路(イヤホン等)で既に送信中。新たに開始はせず、離した時にこの
            // 送信を止める(押した人が話し終えた合図として扱う)。
            logDebug(`${tag}: すでに送信中 → 離すと停止します`);
            return;
          }
          // handleBegin が「BLE起点」として上限60秒の自動停止を張るように立てる。
          bleToggleInitiatedRef.current = true;
          armBleBeginWatchdog();
          logDebug(`${tag}: PTT送信開始(押している間だけ)`);
          traceStart(traceLabel, receivedAt, nativeAt);
          // 話す先の反映(個別の期限切れなど)を、システムの開始確定を待つ間に進めておく。
          pressAtRef.current = pressedAt;
          kickTalkSync(tag, pressedAt);
          traceMark("開始要求");
          PttChannel.beginTransmitting().catch((e) => {
            // 失敗したら意図もリセットする(離した時に無関係な送信を止めないように)。
            bleTxIntentRef.current = false;
            bleToggleInitiatedRef.current = false;
            clearBleBeginWatchdog();
            logDebug(`BLEボタン: 開始失敗 ${errMsg(e)}`);
            traceEnd("開始失敗");
          });
          return;
        }
        // 終了待ちの開始予約があるうちにもう一度押した =「やっぱり止める」。予約だけ取り消す。
        if (bleBeginAfterEndRef.current) {
          bleBeginAfterEndRef.current = null;
          logDebug(`${tag}: 開始の予約を取り消し`);
          return;
        }
        // トグル判定は「意図(bleTxIntentRef)」または「確定した送信状態」で行う。
        // 開始要求から確定イベントまで1秒以上かかることがあり、txActiveRefだけを
        // 見ると、その間の2度目の押下が「停止」でなく「再開始」になってしまう。
        const inTx = bleTxIntentRef.current || txActiveRef.current;
        if (!inTx && ownTxEnding()) {
          // 自動停止の直後に押した等で、前の送信の終了通知がまだ届いていない。
          // 終了通知を受けてから開始する(もう一度押せば取り消し)。
          bleBeginAfterEndRef.current = { mode: "toggle", at: Date.now() };
          logDebug(`${tag}: 前の送信の終了待ち → 終わり次第開始します`);
          return;
        }
        if (inTx) {
          bleTxIntentRef.current = false;
          logDebug(`${tag}: PTT送信停止`);
          PttChannel.endTransmitting().catch((e) => {
            logDebug(`BLEボタン: 停止失敗 ${errMsg(e)}`);
          });
        } else {
          bleTxIntentRef.current = true;
          bleToggleInitiatedRef.current = true;
          bleTxModeRef.current = "toggle";
          armBleBeginWatchdog();
          logDebug(`${tag}: PTT送信開始`);
          traceStart(traceLabel, receivedAt, nativeAt);
          pressAtRef.current = pressedAt;
          kickTalkSync(tag, pressedAt);
          traceMark("開始要求");
          PttChannel.beginTransmitting().catch((e) => {
            // 失敗したら意図もリセットする(次の押下がまた「開始」になるように)。
            bleTxIntentRef.current = false;
            bleToggleInitiatedRef.current = false;
            clearBleBeginWatchdog();
            logDebug(`BLEボタン: 開始失敗 ${errMsg(e)}`);
            traceEnd("開始失敗");
          });
        }
        return;
      }

      // ここから直接経路(Android / PTT未参加のiPhone)。
      if (!connectedRef.current) {
        if (wantConnectedRef.current && !connectPromiseRef.current) {
          logDebug(`${tag}: 未接続のため再接続します(つながったらもう一度押してください)`);
          void connect();
        } else {
          logDebug(`${tag}: 未接続のため無視`);
        }
        return;
      }
      if (kind === "toggle") {
        // 次がONかOFFかを先に見ておき、ボタンでONにした送信だけを「ボタン起点」と記録する。
        const starting = !micOnRef.current;
        bleDirectActiveRef.current = starting && !fromKeyboard;
        bleTxModeRef.current = "toggle";
        logDebug(`${tag}: 送信${starting ? "開始" : "停止"}(通常経路)`);
        if (!starting) {
          void toggleMic(AUTO_OFF_MS);
          return;
        }
        traceStart(traceLabel, receivedAt, nativeAt);
        void toggleMic(AUTO_OFF_MS).then((opened) => {
          if (!opened) {
            traceEnd("マイクON失敗");
            return;
          }
          traceMark("マイクON");
          traceEnd("通常経路");
        });
        return;
      }
      // 押している間だけ方式の「押す」。
      if (bleDirectActiveRef.current && micOnRef.current) {
        logDebug(`${tag}: すでに送信中のため無視`);
        return;
      }
      bleDirectActiveRef.current = true;
      bleTxModeRef.current = "hold";
      // 意図をすぐ記録する(切替の完了前に届いたイヤホン等のトグルが「停止」と判定されるように)。
      micOnRef.current = true;
      // 離した通知が届かない場合に備えた上限(60秒)。setMic(false) の完了で解除される。
      // Android のロック中も止まるよう、armAutoOff でネイティブのタイマーも使う。
      const armHoldCap = () => {
        armAutoOff(HOLD_MAX_MS, () => {
          logDebug("BLEボタン: 自動停止(押している間だけ方式の上限60秒)");
          bleDirectActiveRef.current = false;
          micOnRef.current = false;
          void setMic(false);
        });
      };
      armHoldCap();
      logDebug(`${tag}: 送信開始(押している間だけ・通常経路)`);
      traceStart(traceLabel, receivedAt, nativeAt);
      const gen = ++directTxGenRef.current;
      void (async () => {
        // 話す先(個別の期限など)の反映を確かめてから開く。待っている間に離されたら開かない。
        const opened = await openMicDirect(
          tag,
          receivedAt,
          () => bleDirectActiveRef.current && directTxGenRef.current === gen,
        );
        if (!opened) {
          traceEnd("マイクON失敗");
          // 後から押し直された・止められた時は、そちらに任せる(新しい送信を閉じない)。
          if (directTxGenRef.current !== gen) return;
          // 開けなかった(離された・話す先を切り替えられない等)。押している記録を戻し、
          // 念のため閉じ直す(閉じ終えると上限のタイマーも消える)。
          bleDirectActiveRef.current = false;
          micOnRef.current = false;
          await setMic(false);
          return;
        }
        traceMark("マイクON");
        traceEnd("通常経路");
        // マイクの切替中に離された(または上限・切断で止められた)なら閉じ直す
        // (離した後にONの処理が完了して、マイクが開いたまま残る事故の防止)。
        if (!bleDirectActiveRef.current) {
          logDebug("BLEボタン: 切替中に離されたため再OFF");
          await setMic(false);
          return;
        }
        // 直前の「離す」の OFF 処理が後から完了すると上限タイマーまで消えるため、
        // マイクが実際に開いた時点で張り直す(上限の無い送信を残さない)。
        armHoldCap();
      })();
    },
    [
      armAutoOff,
      armBleBeginWatchdog,
      clearBleBeginWatchdog,
      connect,
      kickTalkSync,
      logDebug,
      openMicDirect,
      setMic,
      stopBleTransmission,
      toggleMic,
      traceEnd,
      traceMark,
      traceStart,
    ],
  );

  // キーボード型BLEリモコンのキー押下を購読する。押下は handleBlePress と同じ
  // 経路(PTT優先)でトグルする(引数なしで呼ばれる=トグル)。ただしキーボード型は
  // 画面ロック中は届かない(iOSの仕様・実機で確認済み)ため、前面で使う時の補助。
  useRemotePtt(handleBlePress, connected);

  // Android: イヤホンのボタン(勤務中サービスが受け取ったメディアボタン)で送信の開始/停止。
  // 押し忘れ防止のため、iPhone と同じく45秒で自動停止する。
  useEffect(() => {
    if (!AndroidPtt) return;
    const sub = AndroidPtt.addListener("onMediaButton", (payload) => {
      const key = payload?.key ?? "?";
      if (clockedOutRef.current) {
        logDebug(`イヤホンのボタン(${key}): 退勤済みのため無視`);
        return;
      }
      if (!connectedRef.current) {
        logDebug(`イヤホンのボタン(${key}): 未接続のため再接続します(つながったらもう一度押してください)`);
        if (wantConnectedRef.current && !connectPromiseRef.current) void connect();
        return;
      }
      logDebug(`イヤホンのボタン(${key}): 送信の開始/停止`);
      void toggleMic(EARPHONE_AUTO_OFF_MS);
    });
    return () => sub.remove();
  }, [connect, logDebug, toggleMic]);

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
        setAccessoryOk(false);
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
      if (AndroidPtt) {
        const running = AndroidPtt.isRunning();
        setAndroidButtonReady(running);
        // 画面を開いた時に、音楽アプリに取られたボタンの受け取り先を取り戻す。
        if (running) AndroidPtt.reclaim();
      }
      // 物理ボタンの接続維持を(再)開始する(Bluetoothオフ・ボタンが見つからない等の
      // 失敗からの再試行)。退勤中もつないでおく(押下は退勤済みとして無視される)ことで、
      // 出勤した瞬間からボタンで話せる。
      restartBleButton();
      // 管理画面で変わったルーム一覧を読み直す(退勤中も。出勤前に選べるように。
      // 失敗しても保存済みの一覧で動く)。
      void refreshChannels("前面復帰");
      if (clockedOutRef.current) {
        // 退勤済み。チャンネルが残っていれば退出をやり直し、自動再接続はしない。
        if (nativePttJoined()) {
          logDebug("前面復帰: 退勤済みなのにPTTに参加中 → 退出をやり直す");
          void PttChannel?.leave()
            .then(() => setPttJoined(nativePttJoined()))
            .catch(() => setPttJoined(true));
        }
        return;
      }
      if (nativePttJoined()) {
        setPttJoined(true);
        // PTTチャンネルに参加中=勤務中。iOSがアプリを終了→復元した場合も含む。
        wantConnectedRef.current = true;
        setShiftOn(true);
      }
      // 名前が空なら端末の保存内容を読み直す(再起動直後に読めなかった場合など)。
      // 聞くルーム・話す先も必ず一緒に読み直す(名前だけ戻すと既定のルームに話してしまうため)。
      if (!identityRef.current.trim()) {
        const savedName = readSetting(SETTINGS_KEYS.displayName);
        if (savedName && savedName.trim()) {
          identityRef.current = savedName;
          setIdentity(savedName);
          if (readSetting(SETTINGS_KEYS.room) !== null) {
            const prefs = loadSavedListenTalk();
            listenRef.current = prefs.listen;
            talkChannelRef.current = prefs.talk;
            setListen(prefs.listen);
            setTalkChannel(prefs.talk);
          }
          setNameMissing(false);
        }
      }
      // 裏にいる間に止まっていた個別の自動解除のタイマーを確かめ直す。
      checkDmExpiry();
      const room = roomRef.current;
      const disconnected = !room || room.state === ConnectionState.Disconnected;
      if (
        wantConnectedRef.current &&
        disconnected &&
        !connectPromiseRef.current &&
        identityRef.current.trim()
      ) {
        logDebug("前面復帰: 勤務中のため自動で再接続");
        void connect();
      }
    };
    if (AppState.currentState === "active") onActive();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") onActive();
    });
    return () => sub.remove();
  }, [checkDmExpiry, connect, logDebug, refreshChannels, restartBleButton]);

  // BLEボタンのイベント購読 + 起動時の接続維持開始。
  // 常に表示されている App 本体で購読する(画面の一部に置くと、表示の切替で購読が
  // 外れて押下を取りこぼすため)。依存はすべて安定したコールバックなので張り直されない。
  useEffect(() => {
    if (!BleButton) return;
    try {
      BleButton.start();
    } catch (e) {
      logDebug(`BLEボタン: 接続維持を開始できません ${errMsg(e)}`);
    }
    const subs = [
      BleButton.addListener("onPress", (payload) => {
        // 必ずオブジェクトで渡す(引数なしはキーボード型リモコンからの呼び出しと区別するため)。
        handleBlePress(payload ?? {});
      }),
      BleButton.addListener("onStateChanged", (payload) => {
        const state = payload?.state;
        const detail = payload?.detail ?? "";
        logDebug(`BLEボタン: ${state ?? "?"} ${detail}`);
        // 診断用の細かい通知で、登録手順の案内文・状態表示を上書きしない。
        if (state && state !== "debug") {
          setBleDetail(detail);
          setBleState(state);
        }
        setBleStatus(readBleStatus());
        // ボタンが使えなくなった(切断・異常連打での一時停止・Bluetoothオフ・登録解除・
        // 再登録の開始)。トグル方式でONにした送信は、ボタンではもう止められないので
        // ここで止める(ネイティブも「離す」を送るが、送らない場合に備えた二重の安全策)。
        if (
          state === "disconnected" ||
          state === "error" ||
          state === "idle" ||
          state === "scanning"
        ) {
          stopBleTransmission(`ボタンが使えない状態(${state})`);
        }
      }),
    ];
    return () => subs.forEach((s) => s?.remove());
  }, [handleBlePress, logDebug, stopBleTransmission]);

  // 確認モードのタイマーを、アプリ終了時に残さない。
  useEffect(() => {
    return () => {
      if (bleTestTimerRef.current) clearInterval(bleTestTimerRef.current);
    };
  }, []);

  // BLEボタンの登録(初期設定)。近くのボタンを探し、2回押してもらって確定・保存する。
  const setupBleButton = useCallback(async () => {
    if (!BleButton) {
      setError("このアプリは物理ボタンに未対応です（アプリの更新が必要です）");
      return;
    }
    setError(null);
    // Android: 検索に必要な許可を先に求める(断られたら「設定を開く」を案内)。
    try {
      if (!(await ensureBleSetupPermission())) {
        logDebug("BLEボタン: 検索に必要な許可が得られませんでした");
        const level = typeof Platform.Version === "number" ? Platform.Version : 0;
        setError(
          level >= 31
            ? "ボタンを探すには「付近のデバイス」の許可が必要です。「設定を開く」→「権限」→「付近のデバイス」を許可してから、もう一度「ボタンを登録する」を押してください"
            : "ボタンを探すには位置情報の許可が必要です（Android 11以前の仕様）。「設定を開く」→「権限」→「位置情報」を許可してから、もう一度「ボタンを登録する」を押してください",
          "settings",
        );
        return;
      }
    } catch (e) {
      logDebug(`BLEボタン: 許可の確認に失敗 ${errMsg(e)}`);
    }
    stopBleTest();
    setBleBusy(true);
    setBleDetail(null);
    try {
      logDebug("BLEボタン: 登録スキャン開始");
      const result = await BleButton.startSetup();
      logDebug(
        `BLEボタン: 登録成功 ${result?.name ?? ""}(${result?.holdCapable ? "押している間だけ送信できる" : "押すたびON/OFF"}${result?.noCccd ? "・互換モード" : ""})`,
      );
      // 登録できたかを、声を流さずに確かめてもらう(この間の押下は送信しない)。
      startBleTest();
    } catch (e) {
      const msg = errMsg(e);
      const code = e && typeof e === "object" ? (e as { code?: unknown }).code : undefined;
      logDebug(`BLEボタン: 登録失敗 ${typeof code === "string" ? `${code} ` : ""}${msg}`);
      setError(
        msg,
        code === "E_UNAUTHORIZED" || /許可|権限/.test(msg) ? "settings" : undefined,
      );
    } finally {
      setBleBusy(false);
      // 登録に失敗した場合でも、既存の登録ボタンへの接続維持を必ず復旧させる
      // (ネイティブ側でも復旧するが、JS側からも念押しする)。
      restartBleButton();
    }
  }, [logDebug, restartBleButton, setError, startBleTest, stopBleTest]);

  // 登録の解除(確認してから)。解除するとボタンで話せなくなるため、誤タップで消さない。
  const unregisterBleButton = useCallback(() => {
    Alert.alert(
      "物理ボタンの登録を解除しますか？",
      "解除すると、このボタンでは話せなくなります。もう一度使う時は「ボタンを登録する」からやり直してください。",
      [
        { text: "キャンセル", style: "cancel" },
        {
          text: "解除する",
          style: "destructive",
          onPress: () => {
            stopBleTest();
            // 解除したボタンで始めた送信は、もう止める手段が無いので先に止める。
            stopBleTransmission("登録解除");
            try {
              BleButton?.unregister();
            } catch (e) {
              logDebug(`BLEボタン: 登録解除に失敗 ${errMsg(e)}`);
            }
            logDebug("BLEボタン: 登録を解除");
            setBleState("idle");
            setBleDetail(null);
            setBleStatus(readBleStatus());
          },
        },
      ],
    );
  }, [logDebug, stopBleTest, stopBleTransmission]);

  // 押し方の方式を切り替える(離した通知を送るボタンだけ)。設定はネイティブ側に保存される。
  const changeBleMode = useCallback(
    (mode: BleButtonMode) => {
      if (!BleButton || typeof BleButton.setMode !== "function") return;
      // 方式が変わると、今の送信を止める手段(離す/もう1回押す)が変わるため、
      // ボタンで始めた送信があれば先に止める(開いたまま残さない)。
      stopBleTransmission("方式の変更");
      try {
        BleButton.setMode(mode);
        logDebug(
          `BLEボタン: 方式を「${mode === "hold" ? "押している間だけ話す" : "押すたびにON/OFF"}」に変更`,
        );
      } catch (e) {
        logDebug(`BLEボタン: 方式を変更できません ${errMsg(e)}`);
      }
      setBleStatus(readBleStatus());
    },
    [logDebug, stopBleTransmission],
  );

  useEffect(() => {
    return () => {
      void cleanup();
      if (dmTimerRef.current) clearTimeout(dmTimerRef.current);
    };
  }, [cleanup]);

  // 起動時に、保存済みの端末トークンがあるか確かめる。
  useEffect(() => {
    let alive = true;
    void loadDeviceToken().then((token) => {
      if (!alive) return;
      setHasDeviceToken(!!token);
      setAuthState(token || INTERCOM_KEY ? "ok" : "needLogin");
    });
    return () => {
      alive = false;
    };
  }, []);

  const submitLogin = async () => {
    const password = loginPassword;
    if (!password) {
      setError("医院のパスワードを入力してください");
      return;
    }
    setLoginBusy(true);
    setError(null);
    try {
      await deviceLogin(password);
      clearTokenCache();
      logDebug("端末ログイン: 成功");
      setLoginPassword("");
      setHasDeviceToken(true);
      setAuthState("ok");
      // 登録できたので、管理画面のルーム一覧を読む。
      channelsFetchedAtRef.current = 0;
      void refreshChannels("ログイン");
    } catch (e) {
      logDebug(`端末ログイン: 失敗 ${errMsg(e)}`);
      showError(e, "ログインできませんでした");
    } finally {
      setLoginBusy(false);
    }
  };

  const logoutDevice = async () => {
    clearTokenCache();
    await saveDeviceToken(null);
    setHasDeviceToken(false);
    logDebug("端末ログイン: 解除");
    if (!INTERCOM_KEY) setAuthState("needLogin");
  };

  const onShift = shiftOn || connected || pttJoined;
  // 勤務中なのに名前が保存されていない(名前を保存する前の版から更新した直後に、
  // iOSがチャンネルを復元した場合など)。入力欄を隠すと先に進めなくなるので、その時は出す。
  const needsName = nameMissing && !connected;
  // 話す先のルーム名(個別をやめた時に戻る先でもある)。
  const roomLabel = channelLabel(talkChannel, channels);
  // 聞くルームの名前(画面の並びどおり。一覧に無いIDはそのまま)。
  const listenedChannels: ChannelItem[] = [
    ...channels.filter((c) => listen.includes(c.id)),
    ...listen
      .filter((id) => !channels.some((c) => c.id === id))
      .map((id) => ({ id, label: channelLabel(id, channels) })),
  ];
  const listenLabel = listenedChannels.map((c) => c.label).join("・");
  // 送信中(と押している間)は、聞くルーム・話す先・個別の相手を変えられない。
  const talkLocked = micOn || holding;
  // 話す先の表示。送信中は、そのマイクを開いた時点の話す先を出す。
  const nameOfIdentity = (id: string): string =>
    dmTarget?.identity === id
      ? dmTarget.name
      : (people.find((p) => p.identity === id)?.name ?? displayNameOf({ identity: id }));
  const describeTalk = (talk: string): string => {
    const parsed = parseTalk(talk);
    return parsed.kind === "dm"
      ? `🔒 ${nameOfIdentity(parsed.target)}さんだけ（個別）`
      : `「${channelLabel(parsed.id, channels)}」`;
  };
  const currentTalkText = dmTarget ? `🔒 ${dmTarget.name}さん（個別）` : roomLabel;
  const liveTalkText = micOn
    ? describeTalk(micOpenTalkRef.current ?? (dmTarget ? dmTalk(dmTarget.identity) : talkChannel))
    : "";
  // 個別の残り秒数(話し終えてから数える。送信中は数えない)。
  const dmLeftSec = dmTarget
    ? Math.min(DM_REVERT_MS / 1000, Math.ceil(dmRemainingMs(dmSince, nowTick) / 1000))
    : 0;
  // 物理ボタンの表示用の状態。ready(押下通知の購読が有効)の時だけ「使える」とする
  // (旧ネイティブビルドは ready を返さないので、その時はリンクの接続で代用する)。
  const bleRegistered = !!BleButton && bleStatus.registered;
  const bleReady = bleRegistered && (bleStatus.ready ?? bleStatus.connected) === true;
  const bleHoldCapable = bleRegistered && bleStatus.holdCapable === true;
  // 離した通知を送らないボタン(iTag型)は常にトグル。ホールド対応ボタンの既定は「押している間だけ」。
  const bleMode: BleButtonMode = bleHoldCapable ? (bleStatus.mode ?? "hold") : "toggle";
  const bleModeLabel =
    bleMode === "hold" ? "押している間だけ話す" : "押すたびにON/OFF（30秒で自動停止）";
  // ロック中・ポケットの中でボタンが実際に使えるか。iPhoneはロック中に話す機能
  // (PushToTalk)、Androidは勤務中サービスが動いている時だけ、裏でも送信できる。
  const bleCanTalk = bleReady && (Platform.OS === "android" ? androidButtonReady : pttJoined);
  const bleDetailText = bleDetail ?? "";
  const blePill: { tone: keyof typeof STATUS_COLORS; text: string } = !BleButton
    ? { tone: "idle", text: "未対応" }
    : bleBusy
      ? { tone: "busy", text: "登録中" }
      : !bleStatus.registered
        ? { tone: "idle", text: "未登録" }
        : bleState === "error"
          ? bleReady
            ? { tone: "warn", text: "一時停止中" }
            : /Bluetoothがオフ/.test(bleDetailText)
              ? { tone: "warn", text: "Bluetoothオフ" }
              : /許可|権限/.test(bleDetailText)
                ? { tone: "warn", text: "許可が必要" }
                : { tone: "warn", text: "要確認" }
          : bleReady
            ? { tone: "ok", text: "準備完了" }
            : bleState === "connecting"
              ? { tone: "busy", text: "接続中" }
              : { tone: "busy", text: "再接続待ち" };
  // 画面上部に出す現在の状態。
  const statusView: { tone: "idle" | "ok" | "busy" | "warn" | "live"; text: string } = micOn
    ? { tone: "live", text: `送信中 — ${liveTalkText}に話しています` }
    : connected
      ? bleCanTalk
        ? { tone: "ok", text: "待機中 — ボタンで話せます" }
        : !pttJoined
          ? androidButtonReady
            ? { tone: "ok", text: "待機中 — イヤホンのボタンで話せます" }
            : { tone: "ok", text: "待機中 — 画面のボタンで話せます" }
          : accessoryOk === false
            ? {
                tone: "warn",
                text: "待機中 — このiPhoneではイヤホンのボタンは使えません。ロック画面のトークボタンで話せます",
              }
            : { tone: "ok", text: "待機中 — イヤホンのボタンで話せます" }
      : connecting
        ? { tone: "busy", text: "接続中…" }
        : pttJoined
          ? clockedOut
            ? {
                tone: "warn",
                text: "退勤の処理が完了していません — もう一度「退勤する」を押してください",
              }
            : { tone: "warn", text: "通信が途切れています — 話すと自動で再接続します" }
          : onShift
            ? { tone: "warn", text: "通信が途切れています — 「再接続する」を押してください" }
            : { tone: "idle", text: "勤務外（未接続）" };
  const talkLabel = holding
    ? micOn
      ? "話しています…（離すと終了）"
      : "準備中…"
    : micOn
      ? "送信中 — 押して離すと停止"
      : "押して話す";

  // 聞くルーム(複数可。「全体」は常に聞く)と話す先(聞くルームの中から1つ)の選択。
  // 出勤前と出勤中で同じものを使う(出勤中は接続し直さずに切り替わる)。
  const renderChannelPickers = (disabled: boolean) => (
    <>
      <Text style={[styles.cardLabel, { marginTop: 16 }]}>聞くルーム（複数可）</Text>
      <View style={styles.roomRow}>
        {channels.map((room) => {
          const always = room.id === BROADCAST_CHANNEL;
          const selected = always || listen.includes(room.id);
          return (
            <Pressable
              key={room.id}
              onPress={() => toggleListen(room.id)}
              disabled={disabled || always}
              style={[styles.roomChip, selected && styles.roomChipOn, disabled && styles.disabled]}
            >
              <Text style={[styles.roomChipText, selected && styles.roomChipTextOn]}>
                {selected ? "✓ " : ""}
                {room.label}
                {always ? "（常に）" : ""}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={[styles.cardLabel, { marginTop: 16 }]}>話す先</Text>
      <View style={styles.roomRow}>
        {listenedChannels.map((room) => {
          const selected = !dmTarget && room.id === talkChannel;
          return (
            <Pressable
              key={room.id}
              onPress={() => chooseTalkChannel(room.id)}
              disabled={disabled}
              style={[styles.roomChip, selected && styles.roomChipOn, disabled && styles.disabled]}
            >
              <Text style={[styles.roomChipText, selected && styles.roomChipTextOn]}>
                {room.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {!channels.some((c) => c.id === talkChannel) ? (
        <Text style={[styles.hint, styles.warnText]}>
          ⚠️ 話す先のルーム「{talkChannel}」は管理画面で削除されました。話す先を選び直してください。
        </Text>
      ) : null}
      {dmTarget ? (
        <Text style={styles.hint}>
          いまは {dmTarget.name}さんに個別で話す設定です。ルームを選ぶと個別を終えて、そのルームに話します。
        </Text>
      ) : (
        <Text style={styles.hint}>
          「全体」の声は常に聞こえます。話す先は、聞くルームの中から選びます（「全体」を選ぶと全員に届きます）。
        </Text>
      )}
    </>
  );

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <Text style={styles.brand}>MIRAI LINK</Text>
        <Text style={styles.title}>院内音声インカム</Text>

        {micOn ? (
          <View style={styles.liveBanner}>
            <Text style={styles.liveText}>🔴 送信中（マイクON）→ {liveTalkText}</Text>
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

        {notice ? (
          <Pressable style={styles.noticeBox} onPress={() => setNotice(null)}>
            <Text style={styles.noticeText}>{notice}</Text>
            <Text style={styles.noticeClose}>タップで閉じる</Text>
          </Pressable>
        ) : null}

        {authState === "needLogin" ? (
          <View style={styles.card}>
            <Text style={styles.guideTitle}>はじめに：この端末を登録します</Text>
            <Text style={styles.hint}>
              医院の共通パスワード（PC版のログインと同じもの）を入力してください。
              一度登録すると、この端末では約半年間そのまま使えます。
            </Text>
            <TextInput
              style={[styles.input, { marginTop: 14 }]}
              value={loginPassword}
              onChangeText={setLoginPassword}
              placeholder="医院のパスワード"
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              editable={!loginBusy}
              returnKeyType="done"
              onSubmitEditing={() => void submitLogin()}
            />
            <Pressable
              style={[styles.primary, loginBusy && styles.disabled]}
              onPress={() => void submitLogin()}
              disabled={loginBusy}
            >
              <Text style={styles.primaryText}>{loginBusy ? "確認中..." : "登録する"}</Text>
            </Pressable>
          </View>
        ) : authState === "loading" ? null : (
        <>
        <View style={styles.card}>
          <View style={styles.statusRow}>
            <View style={[styles.statusDot, { backgroundColor: STATUS_COLORS[statusView.tone] }]} />
            <Text style={styles.statusText}>{statusView.text}</Text>
          </View>

          {onShift && !needsName ? (
            <>
              <Text style={styles.shiftSummary}>
                {identity.trim()} ・ 話す先: {currentTalkText}
              </Text>
              <Text style={styles.shiftSub}>聞く: {listenLabel}</Text>
            </>
          ) : (
            <>
              <Text style={[styles.cardLabel, { marginTop: 14 }]}>スタッフ名</Text>
              <TextInput
                style={styles.input}
                value={identity}
                onChangeText={setIdentity}
                placeholder="例: DH田中"
                editable={!connecting}
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={DISPLAY_NAME_MAX}
                returnKeyType="done"
              />

              {/* 出勤前に選ぶ(出勤中も下の「ルーム・個別に話す」で切り替えられる) */}
              {onShift ? null : renderChannelPickers(connecting)}
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

        {onShift && !clockedOut ? (
          <View style={styles.card}>
            {remoteSpeakers.map((s) => (
              <Text key={s.key} style={[styles.speakingNow, s.dm && styles.speakingDm]}>
                {s.dm ? s.text : `${s.text} が話しています`}
              </Text>
            ))}

            {dmTarget ? (
              <View style={styles.dmBox}>
                <Text style={styles.dmTitle}>🔒 {dmTarget.name}さんだけに個別で話す設定です</Text>
                <Text style={styles.dmSub}>
                  {talkLocked
                    ? `送信中（話し終えてから${DM_REVERT_MS / 1000}秒で「${roomLabel}」に戻ります）`
                    : dmLeftSec > 0
                      ? `あと${dmLeftSec}秒で「${roomLabel}」（全員）に戻ります`
                      : `まもなく「${roomLabel}」（全員）に戻ります`}
                </Text>
                <Pressable
                  style={[styles.dmRevert, talkLocked && styles.disabled]}
                  onPress={revertDmManually}
                  disabled={talkLocked}
                >
                  <Text style={styles.dmRevertText}>全員（ルーム）に戻す</Text>
                </Pressable>
              </View>
            ) : (
              <Text style={styles.talkTarget}>話す先: {roomLabel}</Text>
            )}

            <Pressable
              style={[
                styles.ptt,
                (micOn || holding) && styles.pttOn,
                !connected && !pttJoined && styles.disabled,
              ]}
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
            {Platform.OS === "android" ? (
              <Text style={styles.hint}>
                ・Bluetoothイヤホンのボタンを押すと送信開始、もう一度押すと終了（機種によって1回押し・2回押しのどちらかで反応します）。
                {"\n"}・押し忘れても45秒で自動的に止まります。
                {"\n"}・通知欄に「MIRAI LINK 勤務中」が出ている間は、画面を消してポケットに入れても使えます。
                {"\n"}・勤務中は音楽アプリを終了しておいてください（ボタンが音楽側に取られることがあります）。取られた時はこの画面を一度開くと戻ります。
                {"\n"}・受信音はイヤホン接続中はイヤホンから流れます（周囲には聞こえません）。
                {"\n"}・うまく送れない時は「退勤する」→「出勤する」で直ります。
              </Text>
            ) : (
            <Text style={styles.hint}>
              ・Bluetoothイヤホンのボタンを押すと送信開始、もう一度同じ押し方で終了（押し方は機種によって違い、多くは「2回押し」）。
              {"\n"}・押し忘れても45秒で自動的に止まります。
              {"\n"}・一般的なBluetoothイヤホンで使えます（AirPodsは不可・iOS 17以降）。
              {"\n"}・勤務中は音楽アプリを終了しておいてください（再生中・一時停止中の音楽アプリがあると、ボタンが音楽側に取られることがあります）。
              {"\n"}・イヤホンが無い時は、画面上部やロック画面の「MIRAI LINK」表示を開き、トークボタンを押している間だけ話せます。
              {"\n"}・受信音はイヤホン接続中はイヤホンから流れます（周囲には聞こえません）。
              {"\n"}・うまく送れない時は「退勤する」→「出勤する」で直ります。
            </Text>
            )}
            <Text style={[styles.hint, { marginTop: 6 }]}>
              診療中は患者さんの個人情報を言わず、チェア番号やセット名で伝えてください。
            </Text>
          </View>
        ) : null}

        {onShift && !clockedOut ? (
          <View style={styles.card}>
            <Text style={styles.bleTitle}>📢 ルームの切り替え・個別に話す</Text>
            {renderChannelPickers(talkLocked)}
            {talkLocked ? (
              <Text style={[styles.hint, { color: "#b76e00" }]}>
                送信中は切り替えられません（話し終えると選べます）。
              </Text>
            ) : null}

            <Text style={[styles.cardLabel, { marginTop: 18 }]}>
              個別に話す（選んだ1人だけに届きます）
            </Text>
            {!connected ? (
              <Text style={styles.hint}>接続している間だけ、出勤中の人を選べます。</Text>
            ) : people.length === 0 ? (
              <Text style={styles.hint}>いま出勤中のほかのスタッフはいません。</Text>
            ) : (
              <View style={styles.roomRow}>
                {people.map((p) => {
                  const selected = dmTarget?.identity === p.identity;
                  return (
                    <Pressable
                      key={p.identity}
                      onPress={() => selectDmTarget(p)}
                      disabled={talkLocked}
                      style={[
                        styles.roomChip,
                        selected && styles.dmChipOn,
                        talkLocked && styles.disabled,
                      ]}
                    >
                      <Text style={[styles.roomChipText, selected && styles.roomChipTextOn]}>
                        {selected ? "🔒 " : ""}
                        {p.name}
                        {p.home ? `（${channelLabel(p.home, channels)}）` : ""}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            )}
            <Text style={styles.hint}>
              ・個別にすると、選んだ人だけに声が届きます（ほかの人には聞こえません）。
              {"\n"}・最後に話し終えてから{DM_REVERT_MS / 1000}
              秒たつと、自動で全員（ルーム）に戻ります。すぐ戻す時は「全員（ルーム）に戻す」。
              {"\n"}・相手が退勤・切断すると、すぐ全員（ルーム）に戻ります。
            </Text>
          </View>
        ) : null}

        {/* 退勤中も表示する(出勤前にボタンの登録・解除・テストができるように。
            退勤中の押下は送信されない。話すための案内は「出勤する」を促す) */}
        <View style={styles.card}>
          <View style={styles.bleHeader}>
            <Text style={styles.bleTitle}>🔘 物理ボタン</Text>
            <View style={[styles.pill, { backgroundColor: STATUS_COLORS[blePill.tone] }]}>
              <Text style={styles.pillText}>{blePill.text}</Text>
            </View>
          </View>

          {!BleButton ? (
            <Text style={styles.hint}>
              このアプリは物理ボタンに未対応です（アプリの更新が必要です）。
            </Text>
          ) : bleStatus.registered ? (
            <>
              <Text style={styles.bleName}>{bleStatus.name ?? "BLEボタン"}</Text>
              <Text style={styles.bleModeNow}>{bleModeLabel}</Text>

              {bleTestLeft > 0 ? (
                <View style={styles.bleTestBox}>
                  <Text style={styles.bleTestTitle}>
                    テスト中（残り{bleTestLeft}秒）: ボタンを押してみてください。この間は送信しません
                  </Text>
                  <Text style={styles.bleTestResult}>
                    {bleTestHit
                      ? `反応しました ✅（押した: ${bleTestHit.presses}回${
                          bleTestHit.released ? "・離したも確認" : ""
                        }）`
                      : "まだ反応がありません"}
                  </Text>
                </View>
              ) : null}

              {blePill.tone !== "ok" && bleDetail ? (
                <Text style={[styles.hint, { color: "#8a5200" }]}>{bleDetail}</Text>
              ) : null}
              {blePill.text === "許可が必要" ? (
                <Pressable
                  style={styles.errorAction}
                  onPress={() => {
                    void Linking.openSettings();
                  }}
                >
                  <Text style={styles.errorActionText}>設定を開く</Text>
                </Pressable>
              ) : null}

              {bleHoldCapable && typeof BleButton.setMode === "function" ? (
                <>
                  <Text style={[styles.cardLabel, { marginTop: 14 }]}>押し方</Text>
                  <View style={styles.modeRow}>
                    {(["hold", "toggle"] as const).map((m) => {
                      const selected = bleMode === m;
                      return (
                        <Pressable
                          key={m}
                          style={[styles.modeChip, selected && styles.modeChipOn]}
                          onPress={() => {
                            if (!selected) changeBleMode(m);
                          }}
                        >
                          <Text style={[styles.modeChipText, selected && styles.modeChipTextOn]}>
                            {m === "hold"
                              ? "押している間だけ話す"
                              : "押すたびにON/OFF（30秒で自動停止）"}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </>
              ) : null}

              {Platform.OS === "ios" && PttChannel && !pttJoined ? (
                <Text style={[styles.hint, { color: "#b76e00" }]}>
                  {connected
                    ? "⚠️ ロック中にボタンで話すには「ロック中でも話せるようにする」を押してください。"
                    : "⚠️ ボタンで話すには「出勤する」を押してください（ロック中に話す機能も準備されます）。"}
                </Text>
              ) : null}
              {Platform.OS === "android" && AndroidPtt && !androidButtonReady ? (
                <Text style={[styles.hint, { color: "#b76e00" }]}>
                  ⚠️ ロック中にボタンで話すには「出勤する」を押してください（通知欄に「MIRAI LINK 勤務中」が出ている間だけ使えます）。
                </Text>
              ) : null}

              <View style={styles.bleActions}>
                <Pressable
                  style={[styles.smallButton, (bleTestLeft > 0 || micOn) && styles.disabled]}
                  onPress={startBleTest}
                  disabled={bleTestLeft > 0 || micOn}
                >
                  <Text style={styles.smallButtonText}>テスト（10秒）</Text>
                </Pressable>
                <Pressable style={styles.smallButton} onPress={unregisterBleButton}>
                  <Text style={styles.smallButtonText}>登録を解除</Text>
                </Pressable>
              </View>
            </>
          ) : (
            <>
              <Text style={styles.hint}>
                服や名札に付けたボタンで、スマホを取り出さずに話せます（画面ロック中・ポケットの中でも使えます）。
              </Text>
              <Text style={styles.guideTitle}>登録のしかた（1回だけ）</Text>
              <Text style={styles.bleStep}>1. ボタンの電源を入れる</Text>
              <Text style={styles.bleStep}>2. スマホのそばに置いて、画面をつけたまま待つ</Text>
              <Text style={styles.bleStep}>3. 案内が出たら、ボタンを短く2回押す</Text>
              {bleBusy && bleDetail ? (
                <View style={styles.bleTestBox}>
                  <Text style={styles.bleTestTitle}>▶ {bleDetail}</Text>
                </View>
              ) : null}
              <Pressable
                style={[styles.primary, bleBusy && styles.disabled]}
                onPress={() => void setupBleButton()}
                disabled={bleBusy}
              >
                <Text style={styles.primaryText}>
                  {bleBusy ? "登録中…（案内に従ってください）" : "ボタンを登録する"}
                </Text>
              </Pressable>
              <Text style={styles.hint}>
                使えるボタン: iTag型（紛失防止タグ）・Zello用PTTボタン（PTT-Z01等）。
                {"\n"}※シャッターリモコン等のキーボード型は、画面ロック中は使えません。
                {"\n"}※登録は1台ずつ。ほかのボタンやタグは離しておいてください。
              </Text>
            </>
          )}

          {BleButton ? (
            <>
              <Text style={styles.guideTitle}>📌 ボタンを使う時の約束</Text>
              <Text style={styles.hint}>
                ・アプリを上にスワイプして終了しない
                {"\n"}・Bluetoothをオフにしない
                {"\n"}・スマホを再起動したら、一度アプリを開く
                {"\n"}・iTag型は長押ししない（電源が切れます）
              </Text>
            </>
          ) : null}
        </View>
        </>
        )}

        <Pressable style={styles.advancedHeader} onPress={() => setAdvancedOpen((v) => !v)}>
          <Text style={styles.advancedHeaderText}>
            {advancedOpen ? "▼" : "▶"} 詳細設定・診断
          </Text>
        </Pressable>

        {advancedOpen ? (
          <View style={styles.card}>
            <Text style={styles.cardLabel}>端末の状態</Text>
            <Text style={styles.hint}>
              ロック中に話す機能:{" "}
              {Platform.OS === "android"
                ? AndroidPtt
                  ? `対応（${androidButtonReady ? "準備済み" : "出勤すると準備されます"}）`
                  : "未対応（アプリの更新が必要）"
                : PttChannel
                  ? `対応（${pttJoined ? "準備済み" : "未準備"}）`
                  : "未対応（iOS16以上が必要）"}
              {"\n"}ビルド: {RemotePtt?.buildTag ?? AndroidPtt?.buildTag ?? "旧ビルド"} /{" "}
              {Platform.OS === "android" ? "Android API" : "iOS"} {String(Platform.Version)}
              {"\n"}端末ID: {getDeviceTag()}
            </Text>
            {hasDeviceToken && !onShift ? (
              <Pressable style={styles.secondary} onPress={() => void logoutDevice()}>
                <Text style={styles.secondaryText}>この端末の登録を解除する</Text>
              </Pressable>
            ) : null}

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

            <Text style={[styles.cardLabel, { marginTop: 18 }]}>🔘 物理ボタン（診断）</Text>
            <Text style={styles.hint}>
              {BleButton
                ? `ビルド ${BleButton.buildTag ?? "旧ビルド"} / ${
                    bleStatus.registered ? `登録: ${bleStatus.name ?? "BLEボタン"}` : "未登録"
                  } / リンク ${bleStatus.connected ? "あり" : "なし"} / 準備 ${
                    bleStatus.ready === undefined ? "不明" : bleStatus.ready ? "完了" : "未完了"
                  } / 方式 ${bleStatus.mode ?? "-"}${bleStatus.holdCapable ? "（離した通知あり）" : ""}${
                    bleStatus.noCccd ? " / 互換モード（購読設定なし）" : ""
                  }`
                : "このビルドは未対応（再ビルドが必要）"}
              {bleState ? `\n最後の状態: ${bleState} ${bleDetail ?? ""}` : ""}
            </Text>

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
  shiftSub: { marginTop: 4, color: "#667085", fontSize: 13 },
  speakingNow: {
    color: "#0f4bd8",
    fontSize: 16,
    fontWeight: "700",
    marginBottom: 12,
    textAlign: "center",
  },
  // 自分あての個別(ほかの人には聞こえていない)。通常の受信と見分けられる色にする。
  speakingDm: { color: "#6b2fb3" },
  talkTarget: {
    color: "#27354f",
    fontSize: 15,
    fontWeight: "700",
    marginBottom: 10,
    textAlign: "center",
  },
  // 個別に話す設定中の表示
  dmBox: {
    marginBottom: 12,
    backgroundColor: "#f4eefc",
    borderColor: "#d5c2f0",
    borderWidth: 1,
    borderRadius: 14,
    padding: 12,
  },
  dmTitle: { color: "#4b1f87", fontSize: 15, fontWeight: "800", lineHeight: 21 },
  dmSub: { marginTop: 4, color: "#5b3f80", fontSize: 13, lineHeight: 19 },
  dmRevert: {
    marginTop: 10,
    backgroundColor: "#4b1f87",
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: "center",
  },
  dmRevertText: { color: "#ffffff", fontSize: 15, fontWeight: "700" },
  dmChipOn: { backgroundColor: "#4b1f87" },
  noticeBox: {
    backgroundColor: "#eef4ff",
    borderColor: "#b9cdf7",
    borderWidth: 1,
    borderRadius: 16,
    padding: 14,
    marginBottom: 16,
  },
  noticeText: { color: "#1f3f8a", lineHeight: 20 },
  noticeClose: { marginTop: 6, color: "#667085", fontSize: 12 },
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
  // 物理ボタンのカード
  bleHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  bleTitle: { color: "#1f2f58", fontSize: 17, fontWeight: "800", flexShrink: 1 },
  pill: { borderRadius: 999, paddingHorizontal: 12, paddingVertical: 5, marginLeft: 8 },
  pillText: { color: "#ffffff", fontSize: 13, fontWeight: "700" },
  bleName: { marginTop: 12, color: "#172033", fontSize: 16, fontWeight: "700" },
  bleModeNow: { marginTop: 4, color: "#475467", fontSize: 14 },
  bleStep: { marginTop: 8, color: "#172033", fontSize: 15, fontWeight: "600", lineHeight: 21 },
  bleTestBox: {
    marginTop: 12,
    backgroundColor: "#eef4ff",
    borderColor: "#b9cdf7",
    borderWidth: 1,
    borderRadius: 14,
    padding: 12,
  },
  bleTestTitle: { color: "#0f4bd8", fontSize: 15, fontWeight: "700", lineHeight: 21 },
  bleTestResult: { marginTop: 8, color: "#0f8f4f", fontSize: 18, fontWeight: "800" },
  modeRow: { gap: 8 },
  modeChip: {
    backgroundColor: "#edf1f8",
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  modeChipOn: { backgroundColor: "#27354f" },
  modeChipText: { color: "#27354f", fontWeight: "600", fontSize: 15 },
  modeChipTextOn: { color: "#ffffff" },
  bleActions: { flexDirection: "row", gap: 8, marginTop: 16 },
  smallButton: {
    flex: 1,
    backgroundColor: "#e6eaf2",
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: "center",
  },
  smallButtonText: { color: "#1f2f58", fontSize: 15, fontWeight: "700" },
});
