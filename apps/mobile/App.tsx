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
import { ConnectionState, DisconnectReason, Room, RoomEvent, Track } from "livekit-client";
import { useRemotePtt } from "./hooks/useRemotePtt";
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

async function fetchToken(body: {
  identity: string;
  name: string;
  room: string;
}): Promise<{ token: string; url: string }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const deviceToken = await loadDeviceToken();
  if (deviceToken) headers.Authorization = `Bearer ${deviceToken}`;
  else if (INTERCOM_KEY) headers["x-intercom-key"] = INTERCOM_KEY;
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
    // 1回の送信で10行前後出るため、数回分さかのぼれるよう多めに保持する。
    setDebugLog((prev) => [...prev.slice(-(DEBUG_LOG_MAX - 1)), `${t} ${msg}`]);
  }, []);

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
      bleTxIntentRef.current = false;
      bleToggleInitiatedRef.current = false;
    }, BLE_BEGIN_WATCHDOG_MS);
  }, [logDebug]);

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

  const cleanup = useCallback(async () => {
    clearAutoOff();
    try {
      await roomRef.current?.disconnect();
    } catch {
      // noop
    }
    roomRef.current = null;
    // 音声セッションの有効化/無効化は、上のエンジン連動処理(WebRTCの録音/再生
    // ON・OFFに追従)とPushToTalkに一本化しているため、ここでは手動で止めない
    // (手動でも止めると二重制御になり、PTT起動時などに活性化が失敗する原因になる)。
    setConnected(false);
    setMicOn(false);
    setRemoteSpeakers([]);
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
      if (DISPLAY_NAME_ALLOWED && !DISPLAY_NAME_ALLOWED.test(displayName)) {
        setError(
          "スタッフ名に使えない文字が含まれています（使える文字: 文字・数字・空白・「・」「_」「-」「.」）",
        );
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

        const data = await fetchToken({
          identity: buildIdentity(displayName, getDeviceTag()),
          name: displayName,
          room,
        });
        logDebug(`connect: トークン取得OK(+${Date.now() - startedAt}ms)`);
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
          setRemoteSpeakers([]);
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
        if (await abandoned()) return false;
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
        established = true;
        setConnected(true);
        setMicOn(false);
        lastAliveRef.current = Date.now();
        wantConnectedRef.current = true;
        setShiftOn(true);
        // 次回起動時(バックグラウンド再起動を含む)に同じ名前・ルームで入れるよう保存。
        writeSettings({
          [SETTINGS_KEYS.displayName]: displayName,
          [SETTINGS_KEYS.room]: room,
        });
        setNameMissing(false);
        return true;
      } catch (e) {
        logDebug(`connect: エラー ${errMsg(e)}`);
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
        // トグル側が先に記録した「意図」を実態(OFF)に戻す(次の押下が空振りしないように)。
        micOnRef.current = false;
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
        // 切替に失敗したら、トグル側が先に記録した「意図」を実態に戻す。
        micOnRef.current = room.localParticipant.isMicrophoneEnabled;
        showError(e, "マイクを操作できませんでした");
      }
    },
    [clearAutoOff, logDebug, logMicStats],
  );

  // タップ/ハードボタン用トグル: ONにしたら AUTO_OFF_MS で自動OFF。
  // (Android のロック中も止まるよう、自動OFFは armAutoOff でネイティブのタイマーも使う)
  const toggleMic = useCallback((autoOffMs: number = AUTO_OFF_MS) => {
    const next = !micOnRef.current;
    // 意図をすぐ記録する。micOnRef は送信の切替が終わってから更新されるため、
    // その間の2度目の押下が「停止」でなく「再開始」になってしまうのを防ぐ。
    micOnRef.current = next;
    void setMic(next);
    clearAutoOff();
    if (next) {
      armAutoOff(autoOffMs, () => {
        logDebug("自動停止(切り忘れ防止)");
        micOnRef.current = false;
        void setMic(false);
      });
    }
  }, [armAutoOff, clearAutoOff, logDebug, setMic]);


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

    // 後から新しい送信が始まっていたら、この処理はもう何もしない(新しい送信の
    // 状態を誤って止めたり、マイクを開いたりしないため)。await のたびに確認する。
    const superseded = () => txGenRef.current !== gen;
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
      if (superseded()) return;
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
    if (superseded()) return;
    if (result === "timeout") {
      // この送信は諦めてシステムの「送信中」表示を消す(無音のまま送信中が
      // 続くのを防ぐ)。
      await abortTransmit("再接続タイムアウト");
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
    if (superseded()) return;
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

  // PushToTalkフレームワークのイベントを購読。
  // システム(ロック画面/Dynamic Island)からの送信開始/停止で LiveKit のマイクをON/OFF。
  useEffect(() => {
    if (!PttChannel) return;
    // 送信開始が確定した時の処理(onBeginTransmitting と、購読前に始まっていた
    // 送信の引き継ぎの両方から呼ぶ)。
    const handleBegin = (source: string) => {
      logDebug(`PTT送信開始: ${source}`);
      // 確定が届いたので、BLEボタンの「確定待ち」の見張りは不要。
      clearBleBeginWatchdog();
      // 退勤済みなのにチャンネルが残っていた(退出がシステムに拒否された等)。
      // 再接続も送信もせずに止め、退出をやり直す(帰宅後の誤送信を防ぐ)。
      if (clockedOutRef.current) {
        logDebug("PTT: 退勤済みのため送信しない → 退出をやり直す");
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
      void pttTransmitStart();
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
        PttChannel?.beginTransmitting().catch((e) => {
          // 失敗したら意図もリセットする(離した時・次の押下で無関係な送信を止めないように)。
          bleTxIntentRef.current = false;
          bleToggleInitiatedRef.current = false;
          clearBleBeginWatchdog();
          logDebug(`BLEボタン: 開始失敗 ${errMsg(e)}`);
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
    logDebug,
    pttTransmitStart,
    pttTransmitEnd,
    setMic,
    setError,
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
    wantConnectedRef.current = false;
    setShiftOn(false);
    txActiveRef.current = false;
    bleTxIntentRef.current = false;
    bleToggleInitiatedRef.current = false;
    bleDirectActiveRef.current = false;
    bleBeginAfterEndRef.current = null;
    clearBleBeginWatchdog();
    stopBleTest();
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
  }, [cleanup, clearBleBeginWatchdog, logDebug, setError, stopBleTest]);

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
      const fromKeyboard = payload === undefined;
      const kind: BlePressKind =
        payload?.kind === "down" || payload?.kind === "up" ? payload.kind : "toggle";
      const replayed = payload?.replayed === true;
      const ageMs = typeof payload?.ageMs === "number" ? payload.ageMs : 0;
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
          PttChannel.beginTransmitting().catch((e) => {
            // 失敗したら意図もリセットする(離した時に無関係な送信を止めないように)。
            bleTxIntentRef.current = false;
            bleToggleInitiatedRef.current = false;
            clearBleBeginWatchdog();
            logDebug(`BLEボタン: 開始失敗 ${errMsg(e)}`);
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
          PttChannel.beginTransmitting().catch((e) => {
            // 失敗したら意図もリセットする(次の押下がまた「開始」になるように)。
            bleTxIntentRef.current = false;
            bleToggleInitiatedRef.current = false;
            clearBleBeginWatchdog();
            logDebug(`BLEボタン: 開始失敗 ${errMsg(e)}`);
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
        toggleMic(AUTO_OFF_MS);
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
      void (async () => {
        await setMic(true);
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
      logDebug,
      setMic,
      stopBleTransmission,
      toggleMic,
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
      toggleMic(EARPHONE_AUTO_OFF_MS);
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
      // ルームも必ず一緒に読み直す(名前だけ戻すと既定のルームに入ってしまうため)。
      if (!identityRef.current.trim()) {
        const savedName = readSetting(SETTINGS_KEYS.displayName);
        if (savedName && savedName.trim()) {
          identityRef.current = savedName;
          setIdentity(savedName);
          const savedRoom = readSetting(SETTINGS_KEYS.room);
          if (savedRoom && ROOMS.some((r) => r.id === savedRoom)) {
            roomIdRef.current = savedRoom;
            setRoomId(savedRoom);
          }
          setNameMissing(false);
        }
      }
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
  }, [connect, logDebug, restartBleButton]);

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
      logDebug("端末ログイン: 成功");
      setLoginPassword("");
      setHasDeviceToken(true);
      setAuthState("ok");
    } catch (e) {
      logDebug(`端末ログイン: 失敗 ${errMsg(e)}`);
      showError(e, "ログインできませんでした");
    } finally {
      setLoginBusy(false);
    }
  };

  const logoutDevice = async () => {
    await saveDeviceToken(null);
    setHasDeviceToken(false);
    logDebug("端末ログイン: 解除");
    if (!INTERCOM_KEY) setAuthState("needLogin");
  };

  const onShift = shiftOn || connected || pttJoined;
  // 勤務中なのに名前が保存されていない(名前を保存する前の版から更新した直後に、
  // iOSがチャンネルを復元した場合など)。入力欄を隠すと先に進めなくなるので、その時は出す。
  const needsName = nameMissing && !connected;
  const roomLabel = ROOMS.find((r) => r.id === roomId)?.label ?? roomId;
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
    ? { tone: "live", text: "送信中 — あなたの声が流れています" }
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

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <Text style={styles.brand}>MIRAI LINK</Text>
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
                placeholder="例: DH田中"
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

        {onShift && !clockedOut ? (
          <View style={styles.card}>
            {remoteSpeakers.length > 0 ? (
              <Text style={styles.speakingNow}>🗣 {remoteSpeakers.join("、")} が話しています</Text>
            ) : null}

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
