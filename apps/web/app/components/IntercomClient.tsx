"use client";

import {
  ConnectionState,
  DisconnectReason,
  LocalAudioTrack,
  MediaDeviceFailure,
  RemoteParticipant,
  Room,
  RoomEvent,
  Track,
  createLocalAudioTrack,
  type LocalParticipant,
  type Participant,
} from "livekit-client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  normalizeListen,
  parseListen,
  pickTalkChannel,
  serializeListen,
  shouldHear,
  speakerLabel,
  withBroadcastChannel,
} from "../lib/channels";
import { INTERCOM_ROOMS, type IntercomRoom } from "../lib/rooms";
import { buildIdentity, validateDisplayName } from "../lib/staffIdentity";

type TokenResponse = {
  token: string;
  url: string;
  room: string;
  identity: string;
  name?: string;
};

type SignalMessage = {
  type: "emergency" | "notice";
  from: string;
  room: string;
  sentAt: string;
  message?: string;
};

type ParticipantEntry = {
  id: string;
  label: string;
  isLocal: boolean;
  // 主なチャンネル(参加者属性 ml.home)。未設定なら空文字。
  home: string;
};

// 個別に話す相手。
type DmTarget = {
  identity: string;
  name: string;
};

type ConnectOptions = {
  // 切断後の自動再接続(ユーザー操作なし)のとき true
  auto?: boolean;
};

// タップ送信の自動停止までの時間(iPhoneアプリの AUTO_OFF_MS と同じ30秒)。
const AUTO_OFF_MS = 30_000;
// 緊急呼び出しを押したとき、話す先を「全体」にして自動でマイクをONにしておく時間。
const EMERGENCY_TALK_MS = 8_000;
// 「押して話す」を押し続けたときの送信の上限(離したことを検知できなかった場合の保険)。
const HOLD_MAX_MS = 60_000;
// 自動再接続の待ち時間(失敗するたびに次の値へ。最後の値を繰り返す)。
const RECONNECT_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000];
// 話す先(自分の参加者属性)がサーバーに反映されるのを待つ上限(1回の更新あたり)。
const ATTR_SYNC_TIMEOUT_MS = 5_000;
// 押した時点で話す先が未反映のとき、反映を待つ上限。これを超えたら送信しない。
const TALK_READY_WAIT_MS = 6_000;
// 話す先(ルーム)が変わった直後に話し始めるまでの待ち時間。前の話す先を聞いていた人が
// 購読を外すのはこちらと同時に変更を受け取ってからなので、すぐ話すと話し始めがその人たちにも
// 届く。変わった直後の送信だけ待つ(ふだんの送信は待たない)。
const TALK_SETTLE_MS = 400;
// 管理画面で変えたルームを取り込むため、画面に戻ったときに読み直す最短の間隔。
const CONFIG_REFRESH_MS = 60_000;
// 初めて使うときの話す先(以前の既定ルームと同じ)。
const DEFAULT_TALK_CHANNEL = "clinic";
// 「全体」の既定の内容(管理画面で消されていても必ず出す)。
const DEFAULT_BROADCAST_ROOM: IntercomRoom = INTERCOM_ROOMS.find(
  (room) => room.id === BROADCAST_CHANNEL
) ?? { id: BROADCAST_CHANNEL, label: BROADCAST_LABEL, description: "全体呼び出し・緊急連絡" };

// ブラウザに保存する値(localStorage)。
const DEVICE_TAG_KEY = "mirise.deviceTag";
const LAST_NAME_KEY = "mirise.lastDisplayName";
// 聞くルーム(カンマ区切り)と話す先のルーム。個別に話す相手は保存しない。
const LISTEN_KEY = "mirise.listen";
const TALK_KEY = "mirise.talk";
// 旧形式(ルームを1つだけ選んでいた頃)。初回の引き継ぎにだけ読む。
const LAST_ROOM_KEY = "mirise.lastRoom";

const DEVICE_TAG_PATTERN = /^[a-z0-9]{6}$/;

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 保存できない環境(プライベートモード等)では何もしない
  }
}

function generateDeviceTag(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(6);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

// このブラウザ固有のタグ(英小文字・数字6桁)。一度作ったら保存して使い続ける。
// 保存できない環境では、このタブを開いている間だけ同じタグを使う。
let memoryDeviceTag: string | null = null;

function getDeviceTag(): string {
  if (memoryDeviceTag) return memoryDeviceTag;
  const stored = readStored(DEVICE_TAG_KEY);
  if (stored && DEVICE_TAG_PATTERN.test(stored)) {
    memoryDeviceTag = stored;
    return stored;
  }
  const tag = generateDeviceTag();
  writeStored(DEVICE_TAG_KEY, tag);
  memoryDeviceTag = tag;
  return tag;
}

class TokenRequestError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "TokenRequestError";
  }
}

const NETWORK_ERROR_MESSAGE =
  "サーバーに接続できません。インターネット接続を確認して、もう一度お試しください。";

async function requestToken(identity: string, name: string, room: string): Promise<TokenResponse> {
  let response: Response;
  try {
    response = await fetch("/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identity, name, room }),
    });
  } catch {
    throw new TokenRequestError(NETWORK_ERROR_MESSAGE, 0);
  }

  let data: (Partial<TokenResponse> & { error?: string }) | null = null;
  if (response.headers.get("content-type")?.includes("application/json")) {
    try {
      data = (await response.json()) as Partial<TokenResponse> & { error?: string };
    } catch {
      data = null;
    }
  }

  if (response.status === 401) {
    throw new TokenRequestError(
      data?.error ?? "ログインの有効期限が切れました。もう一度ログインしてください。",
      401
    );
  }

  if (!response.ok || !data?.token || !data?.url) {
    throw new TokenRequestError(
      data?.error ?? "接続の準備に失敗しました。しばらくしてから、もう一度お試しください。",
      response.status
    );
  }

  return data as TokenResponse;
}

function connectionLabel(state: ConnectionState): string {
  switch (state) {
    case ConnectionState.Connected:
      return "接続中";
    case ConnectionState.Connecting:
      return "接続しています";
    case ConnectionState.Reconnecting:
    case ConnectionState.SignalReconnecting:
      return "再接続中";
    case ConnectionState.Disconnected:
      return "未接続";
    default:
      return String(state);
  }
}

// マイクが使えなかった理由を、スタッフ向けの日本語にする。
function micErrorMessage(error: unknown): string {
  const suffix = "聞くだけの状態で接続しています（こちらから話すことはできません）。";
  const name = (error as { name?: string } | null)?.name;
  if (name === "DeviceUnsupportedError") {
    return `この環境ではマイクを使えないため、${suffix}`;
  }
  if (name === "SecurityError") {
    return `マイクの使用が許可されていないため、${suffix}アドレスバー左のアイコンからマイクを「許可」にしてから「マイクを再確認」を押してください。`;
  }
  switch (MediaDeviceFailure.getFailure(error)) {
    case MediaDeviceFailure.NotFound:
      return `マイクが見つからないため、${suffix}マイクをつないでから「マイクを再確認」を押してください。`;
    case MediaDeviceFailure.PermissionDenied:
      return `マイクの使用が許可されていないため、${suffix}アドレスバー左のアイコンからマイクを「許可」にしてから「マイクを再確認」を押してください。`;
    case MediaDeviceFailure.DeviceInUse:
      return `マイクがほかのアプリで使用中のため、${suffix}ほかのアプリを閉じてから「マイクを再確認」を押してください。`;
    default:
      return `マイクを使えないため、${suffix}`;
  }
}

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  const tag = element.tagName;
  return tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || element.isContentEditable;
}

// 聞くチャンネルを、ルーム一覧の順に並べて整える(一覧に無いものは後ろ。"all" は必ず先頭)。
function orderListen(ids: readonly string[], rooms: readonly IntercomRoom[]): string[] {
  const order = rooms.map((room) => room.id);
  const rank = (id: string) => {
    const index = order.indexOf(id);
    return index === -1 ? order.length : index;
  };
  return normalizeListen([...ids].sort((a, b) => rank(a) - rank(b)));
}

// 自分の参加者属性がサーバーに反映済みか(サーバーから届いた値と比べる。'' は未設定と同じ)。
function attributesApplied(participant: LocalParticipant, attrs: Record<string, string>): boolean {
  const current = participant.attributes;
  return Object.entries(attrs).every(([key, value]) => (current[key] ?? "") === value);
}

// 自分の参加者属性を更新し、サーバーに反映されるまで待つ(true=反映済み)。
// 反映は、サーバーから届く自分の ParticipantAttributesChanged で確かめる
// (setAttributes() 自体の待ちはタイマー頼みで、画面が裏にあると遅れて失敗扱いになることがあるため)。
function setAttributesAndWait(
  room: Room,
  attrs: Record<string, string>,
  timeoutMs: number
): Promise<boolean> {
  const participant = room.localParticipant;
  if (attributesApplied(participant, attrs)) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: number | null = null;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      if (timer !== null) window.clearTimeout(timer);
      room.off(RoomEvent.ParticipantAttributesChanged, onChanged);
      room.off(RoomEvent.Disconnected, onDisconnected);
      resolve(ok);
    };
    const onChanged = (_changed: Record<string, string>, changedParticipant: Participant) => {
      if (changedParticipant === participant && attributesApplied(participant, attrs)) finish(true);
    };
    const onDisconnected = () => finish(false);
    room.on(RoomEvent.ParticipantAttributesChanged, onChanged);
    room.on(RoomEvent.Disconnected, onDisconnected);
    timer = window.setTimeout(() => finish(attributesApplied(participant, attrs)), timeoutMs);
    participant.setAttributes(attrs).then(
      () => finish(attributesApplied(participant, attrs)),
      (attrError: unknown) => {
        console.warn("参加者属性(聞く・話す先)の更新に失敗しました", attrError);
        finish(attributesApplied(participant, attrs));
      }
    );
  });
}

// 一定時間で待つのをやめる(時間切れ・失敗のときは fallback を返す)。
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = window.setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      () => {
        window.clearTimeout(timer);
        resolve(fallback);
      }
    );
  });
}

export function IntercomClient() {
  const roomRef = useRef<Room | null>(null);
  const localTrackRef = useRef<LocalAudioTrack | null>(null);
  const audioContainerRef = useRef<HTMLDivElement | null>(null);
  const displayNameRef = useRef("");
  // 最後に接続できたスタッフ名(自動再接続で使う)。
  const lastNameRef = useRef<string | null>(null);
  // 送信状態は state だと更新が遅れるため ref でも持つ。
  const micOnRef = useRef(false);
  // マイクのON/OFF処理(最後に呼んだもの)。話す先を変える前に、OFFが終わるのを待つため。
  const micOpRef = useRef<Promise<void>>(Promise.resolve());
  // 「押して話す」ボタン/スペースキーを押している間 true。
  const holdActiveRef = useRef(false);
  // 押して話す の操作元(ボタン=pointer / スペースキー=key)と、ボタンを押している指・マウスのID。
  const holdSourceRef = useRef<"pointer" | "key" | null>(null);
  const holdPointerIdRef = useRef<number | null>(null);
  // 押し続けの上限タイマー。
  const holdLimitTimerRef = useRef<number | null>(null);
  const autoOffTimerRef = useRef<number | null>(null);
  const connectingRef = useRef(false);
  // マイク準備中の部屋(同じ部屋で二重に準備しないため)。
  const micSetupRoomRef = useRef<Room | null>(null);
  // 「切断する」を押した(または未接続の)とき true。自動再接続しない。
  const userDisconnectedRef = useRef(true);
  const reconnectWantedRef = useRef(false);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const connectRef = useRef<((options?: ConnectOptions) => Promise<boolean>) | null>(null);
  // 音量ブースト用(Web Audioで100%超の増幅を可能にする)。
  const audioCtxRef = useRef<AudioContext | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const volumeRef = useRef(1.5);
  // 受信中の各音声要素。音量変更時に再生経路を切り替える。
  const remoteAudiosRef = useRef<
    Map<object, { element: HTMLMediaElement; source: MediaStreamAudioSourceNode | null }>
  >(new Map());
  // ルーム(チャンネル)一覧。イベント処理の中から最新の一覧を読むため ref でも持つ。
  const roomsRef = useRef<IntercomRoom[]>(INTERCOM_ROOMS);
  // サーバーからルーム一覧を読めたか。読めるまでは既定の一覧なので、それに無いルームを
  // 「削除された」として聞くルームから外さない。
  const roomsLoadedRef = useRef(false);
  const configFetchedAtRef = useRef(0);
  // 聞くチャンネル(必ず "all" を含む)と、ふだんの話す先チャンネル(個別・緊急呼び出しでないとき)。
  const listenRef = useRef<string[]>(normalizeListen([DEFAULT_TALK_CHANNEL]));
  const roomTalkRef = useRef(DEFAULT_TALK_CHANNEL);
  // 個別に話す相手(null=個別でない)と、自動で全員(ルーム)に戻すまでの時間の起点
  // (最後に個別で話し終えた時刻。まだ話していなければ選んだ時刻)。
  const dmTargetRef = useRef<DmTarget | null>(null);
  const dmSinceRef = useRef(0);
  const dmTimerRef = useRef<number | null>(null);
  const checkDmExpiryRef = useRef<(() => void) | null>(null);
  // 緊急呼び出しで、一時的に「全体」へ話している間の期限。
  const emergencyRef = useRef<{ until: number } | null>(null);
  const emergencyTimerRef = useRef<number | null>(null);
  // 送信の世代。止める・切断するたびに進め、話す先の確認待ちの間に止められた送信開始を無効にする。
  const txGenRef = useRef(0);
  // 送信の開始〜終了の間 true(話す先の確認待ちを含む)。この間は話す先・聞くルームを変えない。
  const txActiveRef = useRef(false);
  // 今の送信の話す先(サーバーに反映済みの値)と、緊急呼び出しの送信かどうか。
  const txTalkRef = useRef<string | null>(null);
  const txEmergencyRef = useRef(false);
  // サーバーに知らせた個別の受信許可(null=全員に許可 / identity=その人だけに許可)。
  const permTargetRef = useRef<string | null>(null);
  // 話す先の反映処理(同時に1つだけ動かす)と、送信中などで後回しにした反映があるか。
  const syncPromiseRef = useRef<Promise<boolean> | null>(null);
  const syncAgainRef = useRef(false);
  const syncPendingRef = useRef(false);
  // サーバーに反映された自分の話す先(属性 ml.talk)が最後に変わった時刻(TALK_SETTLE_MS 用)。
  const talkChangedAtRef = useRef(0);
  // 無くなったルームの整理を送信中のため後回しにしたか、と整理の処理(後で定義する)。
  const reconcilePendingRef = useRef(false);
  const reconcileRef = useRef<(() => void) | null>(null);
  // 「話す先のルームが無くなった」と知らせたルーム(同じ知らせを何度も出さない)。
  const missingTalkNotifiedRef = useRef<string | null>(null);
  // 緊急呼び出しの処理中か(ダブルクリックで二重に動かさない)。
  const emergencyBusyRef = useRef(false);
  // サーバーの音声検出による「今話している人」の最新の一覧(聞くルームが変わった時に出し直す)。
  const activeSpeakersRef = useRef<Participant[]>([]);

  const [displayName, setDisplayName] = useState("");
  const [connectionState, setConnectionState] = useState<ConnectionState>(ConnectionState.Disconnected);
  const [isMicOn, setIsMicOn] = useState(false);
  const [canTalk, setCanTalk] = useState(false);
  const [micPending, setMicPending] = useState(false);
  const [micWarning, setMicWarning] = useState<string | null>(null);
  const [autoOffAt, setAutoOffAt] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const [participants, setParticipants] = useState<ParticipantEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [lastSignal, setLastSignal] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [reconnectPending, setReconnectPending] = useState(false);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [lastKeyCode, setLastKeyCode] = useState<string | null>(null);
  const [rooms, setRooms] = useState<IntercomRoom[]>(INTERCOM_ROOMS);
  // サーバーからルーム一覧を読めたか(読めるまでは既定の一覧なので「削除された」と表示しない)。
  const [roomsLoaded, setRoomsLoaded] = useState(false);
  const [staffNames, setStaffNames] = useState<string[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  // 受信音量(1.0=100%)。100%超で端末の最大音量よりさらに大きくできる。
  const [volume, setVolume] = useState(1.5);
  // 聞くルーム・話す先・個別の相手・緊急呼び出し中か(表示用。処理は ref を使う)。
  const [listen, setListen] = useState<string[]>(() => normalizeListen([DEFAULT_TALK_CHANNEL]));
  const [roomTalk, setRoomTalk] = useState(DEFAULT_TALK_CHANNEL);
  const [dmTarget, setDmTarget] = useState<DmTarget | null>(null);
  const [dmSince, setDmSince] = useState(0);
  const [emergencyActive, setEmergencyActive] = useState(false);
  // 送信の開始〜終了の間 true(話す先の切り替え待ちを含む)と、切り替え待ちの間 true。
  const [txActive, setTxActive] = useState(false);
  const [txStarting, setTxStarting] = useState(false);
  const [txTalk, setTxTalk] = useState<string | null>(null);
  // 今話している人(自分に聞こえる人だけ)の表示。
  const [speakers, setSpeakers] = useState<string[]>([]);

  const isConnected = connectionState === ConnectionState.Connected;
  // 接続中、またはLiveKitが自動で再接続を試みている間
  const inSession =
    isConnected ||
    connectionState === ConnectionState.Reconnecting ||
    connectionState === ConnectionState.SignalReconnecting;

  useEffect(() => {
    displayNameRef.current = displayName;
  }, [displayName]);

  // Web Audioのグラフ(増幅用)を用意する。未対応環境では null。
  const ensureAudioGraph = useCallback(() => {
    if (typeof window === "undefined") return null;
    if (!audioCtxRef.current) {
      const Ctx =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return null;
      const ctx = new Ctx();
      const gain = ctx.createGain();
      gain.gain.value = volumeRef.current;
      gain.connect(ctx.destination);
      audioCtxRef.current = ctx;
      gainRef.current = gain;
    }
    return audioCtxRef.current;
  }, []);

  // 音量を各音声要素に反映する。
  // 100%以下: 素の<audio>要素で再生(実績のある経路・回帰リスクなし)。
  // 100%超: Web AudioのGainNodeで増幅(端末の最大音量を超えられる)。
  // Web Audio生成に失敗した要素は素の再生(最大100%)にフォールバックし、無音を防ぐ。
  const applyVolume = useCallback(
    (vol: number) => {
      volumeRef.current = vol;
      const boost = vol > 1.0;
      const ctx = boost ? ensureAudioGraph() : audioCtxRef.current;
      if (gainRef.current) gainRef.current.gain.value = vol;

      remoteAudiosRef.current.forEach((rec) => {
        if (boost && ctx && gainRef.current) {
          if (!rec.source && rec.element.srcObject instanceof MediaStream) {
            try {
              rec.source = ctx.createMediaStreamSource(rec.element.srcObject);
              rec.source.connect(gainRef.current);
            } catch {
              rec.source = null;
            }
          }
          if (rec.source) {
            rec.element.muted = true; // 音はWeb Audio側から
            if (ctx.state === "suspended") void ctx.resume();
          } else {
            rec.element.muted = false; // 失敗時は素の100%再生
            rec.element.volume = 1;
          }
        } else {
          // 100%以下: Web Audio経路を切り、素の要素で再生。
          if (rec.source) {
            try {
              rec.source.disconnect();
            } catch {
              // noop
            }
            rec.source = null;
          }
          rec.element.muted = false;
          rec.element.volume = Math.min(1, vol);
        }
      });
    },
    [ensureAudioGraph]
  );

  // スライダーの値を反映。
  useEffect(() => {
    applyVolume(volume);
  }, [volume, applyVolume]);

  const refreshParticipants = useCallback(() => {
    const room = roomRef.current;
    if (!room) {
      setParticipants([]);
      return;
    }

    const local: ParticipantEntry = {
      id: room.localParticipant.identity,
      label: room.localParticipant.name || room.localParticipant.identity,
      isLocal: true,
      home: roomTalkRef.current,
    };
    const remotes: ParticipantEntry[] = Array.from(room.remoteParticipants.values()).map(
      (participant) => ({
        id: participant.identity,
        label: participant.name || participant.identity,
        isLocal: false,
        home: participant.attributes[ATTR.home] ?? "",
      })
    );
    setParticipants([local, ...remotes]);
  }, []);

  // 今話している人のうち、自分に聞こえる人だけを出す(他のルームあて・他の人あての個別は出さない)。
  // 音声検出の通知(ActiveSpeakersChanged)は話している顔ぶれが変わった時にしか来ないので、
  // 聞くルーム・相手の話す先・ルーム名が変わった時にもここで出し直す。
  const refreshSpeakers = useCallback(() => {
    const room = roomRef.current;
    if (!room) {
      setSpeakers([]);
      return;
    }
    const localIdentity = room.localParticipant.identity;
    const lines = activeSpeakersRef.current
      .filter(
        (speaker) =>
          !speaker.isLocal && shouldHear(localIdentity, listenRef.current, speaker.attributes)
      )
      .map((speaker) =>
        speakerLabel(
          speaker.name || speaker.identity,
          localIdentity,
          speaker.attributes,
          roomsRef.current
        )
      );
    setSpeakers((prev) =>
      prev.length === lines.length && prev.every((line, i) => line === lines[i]) ? prev : lines
    );
  }, []);

  const clearAutoOff = useCallback(() => {
    if (autoOffTimerRef.current !== null) {
      window.clearTimeout(autoOffTimerRef.current);
      autoOffTimerRef.current = null;
    }
    setAutoOffAt(null);
  }, []);

  const setMicrophone = useCallback(
    (enabled: boolean): Promise<void> => {
      const operation = (async () => {
        const localTrack = localTrackRef.current;
        if (!enabled || !localTrack) clearAutoOff();
        if (!localTrack) {
          micOnRef.current = false;
          setIsMicOn(false);
          return;
        }

        micOnRef.current = enabled;
        setIsMicOn(enabled);
        try {
          if (enabled) {
            await localTrack.unmute();
          } else {
            await localTrack.mute();
          }
        } catch (micError) {
          console.error(micError);
          if (enabled) {
            micOnRef.current = false;
            setIsMicOn(false);
            clearAutoOff();
            try {
              await localTrack.mute();
            } catch {
              // noop
            }
          }
        }
      })();
      micOpRef.current = operation;
      return operation;
    },
    [clearAutoOff]
  );

  // 今サーバーに知らせるべき話す先(緊急呼び出し中 > 個別 > ふだんのチャンネル)。
  const desiredTalk = useCallback((): string => {
    if (emergencyRef.current) return BROADCAST_CHANNEL;
    if (dmTargetRef.current) return dmTalk(dmTargetRef.current.identity);
    return roomTalkRef.current;
  }, []);

  const desiredAttributes = useCallback(
    () =>
      buildAttributes({ listen: listenRef.current, talk: desiredTalk(), home: roomTalkRef.current }),
    [desiredTalk]
  );

  // 話す先と個別の受信許可がサーバーに反映済みか(送信してよいかの判定)。
  const isTalkReady = useCallback(
    (room: Room) => {
      const talk = desiredTalk();
      return (
        permTargetRef.current === dmTargetOf(talk) &&
        (room.localParticipant.attributes[ATTR.talk] ?? "") === talk
      );
    },
    [desiredTalk]
  );

  // 自分の属性すべて(聞くルーム等も含む)と個別の受信許可が反映済みか。
  const isTalkSynced = useCallback(
    (room: Room) =>
      permTargetRef.current === dmTargetOf(desiredTalk()) &&
      attributesApplied(room.localParticipant, desiredAttributes()),
    [desiredAttributes, desiredTalk]
  );

  // 送信中(話す先の確認待ち・押して話すを押している間を含む)か。
  const isTransmittingNow = useCallback(
    () => txActiveRef.current || micOnRef.current || holdActiveRef.current,
    []
  );

  // 相手のマイクを聞くかどうかを、相手の話す先と自分の聞くルームから決めて購読に反映する。
  const applySubscription = useCallback((room: Room, participant: RemoteParticipant) => {
    const publication = participant.getTrackPublication(Track.Source.Microphone);
    if (!publication) return; // マイク公開前。公開されたとき(TrackPublished)に決め直す
    const want = shouldHear(
      room.localParticipant.identity,
      listenRef.current,
      participant.attributes
    );
    // 呼ぶたびにサーバーへ通知が飛ぶので、変わるときだけ呼ぶ。
    if (publication.isDesired !== want) publication.setSubscribed(want);
  }, []);

  const applyAllSubscriptions = useCallback(
    (room: Room) => {
      room.remoteParticipants.forEach((participant) => applySubscription(room, participant));
    },
    [applySubscription]
  );

  // 話す先・聞くルームを自分の参加者属性としてサーバーに知らせる(1回分)。
  // 個別にするときは、先に「相手だけが受信できる」許可にしてから話す先を知らせる(サーバー側で他の人には届かない)。
  // 個別をやめるときは、先に話す先を知らせ、反映されてから全員に受信を許可する。
  const runTalkSync = useCallback(
    async (room: Room): Promise<boolean> => {
      // 送信を止めた直後なら、マイクOFFが終わってから変える(話し終わりの声が新しい話す先に届かないように)。
      await micOpRef.current;
      if (roomRef.current !== room || room.state !== ConnectionState.Connected) return false;
      if (micOnRef.current) {
        // 送信中は話す先を変えない(送信が終わったときに反映する)。
        syncPendingRef.current = true;
        return false;
      }
      const participant = room.localParticipant;
      const target = dmTargetOf(desiredTalk());
      if (target !== null) {
        if (permTargetRef.current !== target) {
          participant.setTrackSubscriptionPermissions(false, [
            { participantIdentity: target, allowAll: true },
          ]);
          permTargetRef.current = target;
        }
        return setAttributesAndWait(room, desiredAttributes(), ATTR_SYNC_TIMEOUT_MS);
      }
      const applied = await setAttributesAndWait(room, desiredAttributes(), ATTR_SYNC_TIMEOUT_MS);
      if (!applied || roomRef.current !== room) return false;
      // 待っている間に個別へ切り替わっていたら全員には許可しない(次の回で個別の許可にする)。
      if (permTargetRef.current !== null && dmTargetOf(desiredTalk()) === null && !micOnRef.current) {
        participant.setTrackSubscriptionPermissions(true);
        permTargetRef.current = null;
      }
      return true;
    },
    [desiredAttributes, desiredTalk]
  );

  // 話す先の反映を(同時に1つだけ)行う。反映中に頼まれたら、終わったあと最新の値でもう一度行う。
  const syncTalkState = useCallback((): Promise<boolean> => {
    const room = roomRef.current;
    if (!room || room.state !== ConnectionState.Connected) {
      syncPendingRef.current = true;
      return Promise.resolve(false);
    }
    if (syncPromiseRef.current) {
      syncAgainRef.current = true;
      return syncPromiseRef.current;
    }
    syncPendingRef.current = false;
    let promise: Promise<boolean> | null = null;
    promise = (async () => {
      let ok = false;
      try {
        do {
          syncAgainRef.current = false;
          ok = await runTalkSync(room);
        } while (syncAgainRef.current && roomRef.current === room);
      } catch (syncError) {
        console.error(syncError);
        ok = false;
      } finally {
        if (syncPromiseRef.current === promise) syncPromiseRef.current = null;
      }
      return ok && roomRef.current === room && isTalkSynced(room);
    })();
    syncPromiseRef.current = promise;
    return promise;
  }, [isTalkSynced, runTalkSync]);

  // 話す先の反映を頼む。送信中なら、送信が終わってから反映する。
  const requestTalkSync = useCallback(() => {
    const room = roomRef.current;
    if (!room) return;
    if (isTransmittingNow()) {
      syncPendingRef.current = true;
      return;
    }
    if (syncPendingRef.current || syncPromiseRef.current || !isTalkSynced(room)) {
      void syncTalkState();
    }
  }, [isTalkSynced, isTransmittingNow, syncTalkState]);

  const roomTalkLabel = useCallback(
    () => channelLabel(roomTalkRef.current, roomsRef.current),
    []
  );

  // 個別の状態だけを消す(サーバーへの反映は呼び出し側で)。
  const clearDm = useCallback(() => {
    if (dmTimerRef.current !== null) {
      window.clearTimeout(dmTimerRef.current);
      dmTimerRef.current = null;
    }
    dmTargetRef.current = null;
    setDmTarget(null);
  }, []);

  // 個別をやめて、ふだんの話す先(全員・ルーム)に戻す。
  const revertDm = useCallback(
    (message: string | null) => {
      if (!dmTargetRef.current) return;
      clearDm();
      if (message) setNotice(message);
      requestTalkSync();
    },
    [clearDm, requestTalkSync]
  );

  // 個別の残り時間を確かめ、過ぎていれば全員(ルーム)に戻す。まだなら残り時間でタイマーをかけ直す。
  // 送信中は戻さない(送信が終わったときにもう一度確かめる)。
  const checkDmExpiry = useCallback(() => {
    if (dmTimerRef.current !== null) {
      window.clearTimeout(dmTimerRef.current);
      dmTimerRef.current = null;
    }
    if (!dmTargetRef.current || isTransmittingNow()) return;
    const remaining = dmRemainingMs(dmSinceRef.current, Date.now());
    if (remaining <= 0) {
      revertDm(
        `個別に話す時間（${DM_REVERT_MS / 1000}秒）が過ぎたため、話す先を「${roomTalkLabel()}」（全員・ルーム）に戻しました。`
      );
      return;
    }
    dmTimerRef.current = window.setTimeout(() => {
      dmTimerRef.current = null;
      checkDmExpiryRef.current?.();
    }, remaining + 100);
  }, [isTransmittingNow, revertDm, roomTalkLabel]);

  useEffect(() => {
    checkDmExpiryRef.current = checkDmExpiry;
  }, [checkDmExpiry]);

  // 緊急呼び出しの状態だけを消す(サーバーへの反映は呼び出し側で)。
  const clearEmergency = useCallback(() => {
    if (emergencyTimerRef.current !== null) {
      window.clearTimeout(emergencyTimerRef.current);
      emergencyTimerRef.current = null;
    }
    emergencyRef.current = null;
    setEmergencyActive(false);
  }, []);

  // 緊急呼び出しを終えて、元の話す先に戻す。
  const endEmergency = useCallback(() => {
    if (!emergencyRef.current) return;
    clearEmergency();
    requestTalkSync();
  }, [clearEmergency, requestTalkSync]);

  // 緊急呼び出しの間(EMERGENCY_TALK_MS)だけ、話す先を「全体」にする。
  const startEmergency = useCallback(() => {
    if (emergencyTimerRef.current !== null) window.clearTimeout(emergencyTimerRef.current);
    emergencyRef.current = { until: Date.now() + EMERGENCY_TALK_MS };
    setEmergencyActive(true);
    emergencyTimerRef.current = window.setTimeout(() => {
      emergencyTimerRef.current = null;
      // 送信中なら、送信が終わったときに戻す。
      if (isTransmittingNow()) return;
      endEmergency();
    }, EMERGENCY_TALK_MS);
  }, [endEmergency, isTransmittingNow]);

  // 「押して話す」の状態を解除する(マイク自体は呼び出し側で止める)。
  const endHoldState = useCallback(() => {
    holdActiveRef.current = false;
    holdSourceRef.current = null;
    holdPointerIdRef.current = null;
    if (holdLimitTimerRef.current !== null) {
      window.clearTimeout(holdLimitTimerRef.current);
      holdLimitTimerRef.current = null;
    }
  }, []);

  // 送信が終わったとき(止めた・自動停止・開始の取り消し)の後始末。
  // 送信中に後回しにした話す先の変更(個別の自動解除・緊急呼び出しの終了など)をここで反映する。
  const finishTransmit = useCallback(
    (spoke: boolean) => {
      const talk = txTalkRef.current;
      const wasEmergency = txEmergencyRef.current;
      txActiveRef.current = false;
      txTalkRef.current = null;
      txEmergencyRef.current = false;
      setTxActive(false);
      setTxStarting(false);
      setTxTalk(null);
      // 個別で話し終えたら、そこから DM_REVERT_MS たつと全員(ルーム)に戻す。
      const dm = dmTargetRef.current;
      if (spoke && dm && talk === dmTalk(dm.identity)) {
        const endedAt = Date.now();
        dmSinceRef.current = endedAt;
        setDmSince(endedAt);
        setNow(endedAt);
      }
      // 緊急呼び出しの送信が終わった(または期限を過ぎた)ら、元の話す先に戻す。
      const emergency = emergencyRef.current;
      if (emergency && (wasEmergency || Date.now() >= emergency.until)) endEmergency();
      checkDmExpiry();
      // 送信中だったために後回しにした、無くなったルームの整理を行う。
      if (reconcilePendingRef.current) reconcileRef.current?.();
      requestTalkSync();
    },
    [checkDmExpiry, endEmergency, requestTalkSync]
  );

  // どの方法で送信していても止める(画面を離れたとき等)。話す先の確認待ちの送信開始も取り消す。
  const stopAllTransmit = useCallback(
    (message?: string) => {
      const wasTransmitting = txActiveRef.current || micOnRef.current || holdActiveRef.current;
      const spoke = micOnRef.current;
      txGenRef.current += 1;
      endHoldState();
      clearAutoOff();
      if (micOnRef.current) void setMicrophone(false);
      if (wasTransmitting && message) setNotice(message);
      if (wasTransmitting) finishTransmit(spoke);
    },
    [clearAutoOff, endHoldState, finishTransmit, setMicrophone]
  );

  // 一定時間後に送信を自動で止めるタイマーをセットする(タップ送信・緊急呼び出し用)。
  const armAutoOff = useCallback(
    (durationMs: number, message: string) => {
      if (autoOffTimerRef.current !== null) window.clearTimeout(autoOffTimerRef.current);
      const startedAt = Date.now();
      setNow(startedAt);
      setAutoOffAt(startedAt + durationMs);
      autoOffTimerRef.current = window.setTimeout(() => {
        autoOffTimerRef.current = null;
        setAutoOffAt(null);
        if (holdActiveRef.current) return;
        // 話す先の確認待ち(まだマイクOFF)の送信開始も取り消す。
        if (micOnRef.current || txActiveRef.current) stopAllTransmit(message);
      }, durationMs);
    },
    [stopAllTransmit]
  );

  // 送信の残り秒数表示を更新する。
  useEffect(() => {
    if (autoOffAt === null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [autoOffAt]);

  // 個別の残り時間の表示を更新する。
  useEffect(() => {
    if (!dmTarget) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [dmTarget]);

  // 送信を始める(押して話す・タップ・緊急呼び出し共通)。
  // 話す先(参加者属性・個別の受信許可)がサーバーに反映済みであることを確かめてからマイクをONにする。
  // 反映済みならすぐONにする(待ち時間なし)。反映を待っている間に離された・止められた・切断されたら、
  // マイクはONにしない。
  const beginTransmit = useCallback(
    async (options: { emergency?: boolean } = {}): Promise<boolean> => {
      const room = roomRef.current;
      if (!room || !localTrackRef.current || room.state !== ConnectionState.Connected) {
        stopAllTransmit();
        return false;
      }
      const gen = ++txGenRef.current;
      const superseded = () => txGenRef.current !== gen || roomRef.current !== room;
      const emergency = options.emergency === true;
      txActiveRef.current = true;
      txEmergencyRef.current = emergency;
      setTxActive(true);

      if (!emergency) {
        // 個別の期限切れは押した時点でも確かめる(タイマーが遅れても、期限切れの個別のまま話さない)。
        if (dmTargetRef.current && dmRemainingMs(dmSinceRef.current, Date.now()) <= 0) {
          clearDm();
          setNotice(
            `個別に話す時間（${DM_REVERT_MS / 1000}秒）が過ぎたため、話す先を「${roomTalkLabel()}」（全員・ルーム）に戻して送信します。`
          );
        }
        // 緊急呼び出しの期限を過ぎていたら、元の話す先に戻してから送信する。
        const pendingEmergency = emergencyRef.current;
        if (pendingEmergency && Date.now() >= pendingEmergency.until) clearEmergency();
      }

      if (!isTalkReady(room)) {
        setTxStarting(true);
        await withTimeout(syncTalkState(), TALK_READY_WAIT_MS, false);
        if (superseded()) return false;
        if (!isTalkReady(room)) {
          if (!emergency) {
            setError(
              "話す先の切り替えが完了しなかったため、送信しませんでした。通信状況を確認して、もう一度押してください。"
            );
            stopAllTransmit();
            return false;
          }
          // 緊急呼び出しは、切り替えが間に合わなくても送信する。届く範囲が「全体」より狭くなることは
          // あるが、個別の受信許可は話す先の反映後にしか全員へ戻さないため、個別の相手以外に広がることはない。
          setError(
            "話す先を「全体」に切り替えられなかったため、一部の人にしか声が届いていない可能性があります。"
          );
        }
      }
      if (superseded()) return false;
      if (room.state !== ConnectionState.Connected) {
        stopAllTransmit();
        return false;
      }

      // 話す先(ルーム)が変わった直後なら、前の話す先を聞いていた人の購読が外れるまで少し待つ。
      // 「全体」あて(全員が聞く)・個別(受信許可で相手だけに絞ってある)・緊急呼び出し(急ぐ)は待たない。
      const confirmedTalk = room.localParticipant.attributes[ATTR.talk] || BROADCAST_CHANNEL;
      const settleMs = TALK_SETTLE_MS - (Date.now() - talkChangedAtRef.current);
      if (
        !emergency &&
        settleMs > 0 &&
        confirmedTalk !== BROADCAST_CHANNEL &&
        dmTargetOf(confirmedTalk) === null
      ) {
        setTxStarting(true);
        await new Promise<void>((resolve) => window.setTimeout(resolve, settleMs));
        if (superseded()) return false;
        if (room.state !== ConnectionState.Connected || !isTalkReady(room)) {
          stopAllTransmit();
          return false;
        }
      }

      const talk = room.localParticipant.attributes[ATTR.talk] || BROADCAST_CHANNEL;
      txTalkRef.current = talk;
      setTxTalk(talk);
      setTxStarting(false);
      await setMicrophone(true);
      if (superseded()) return false;
      if (!micOnRef.current) {
        // マイクをONにできなかった
        stopAllTransmit();
        return false;
      }
      return true;
    },
    [
      clearDm,
      clearEmergency,
      isTalkReady,
      roomTalkLabel,
      setMicrophone,
      stopAllTransmit,
      syncTalkState,
    ]
  );

  // 個別の相手が退出したら、すぐ全員(ルーム)に戻す。相手あてに送信中なら送信も止める
  // (相手がいないので誰にも届かず、送信中は話す先を変えられないため)。
  const handleDmTargetLeft = useCallback(
    (target: DmTarget) => {
      if (dmTargetRef.current?.identity !== target.identity) return;
      const wasTransmitting = isTransmittingNow();
      clearDm();
      if (wasTransmitting) stopAllTransmit();
      setNotice(
        `個別に話していた${target.name}さんが退出したため、${
          wasTransmitting ? "送信を止めて、" : ""
        }話す先を「${roomTalkLabel()}」（全員・ルーム）に戻しました。`
      );
      requestTalkSync();
    },
    [clearDm, isTransmittingNow, requestTalkSync, roomTalkLabel, stopAllTransmit]
  );

  // 部屋との接続だけを片付ける。AudioContext は closeAudio のときだけ閉じる
  // (自動再接続ではユーザー操作なしで作り直せないため、開いたまま使い回す)。
  const teardownRoom = useCallback(
    (options: { closeAudio?: boolean } = {}) => {
      const room = roomRef.current;
      const localTrack = localTrackRef.current;

      roomRef.current = null;
      localTrackRef.current = null;
      endHoldState();
      micOnRef.current = false;
      clearAutoOff();

      // 送信・個別・緊急呼び出しの状態も片付ける(新しい接続は、全員に受信を許可した状態から始まる)。
      txGenRef.current += 1;
      txActiveRef.current = false;
      txTalkRef.current = null;
      txEmergencyRef.current = false;
      micOpRef.current = Promise.resolve();
      clearDm();
      clearEmergency();
      permTargetRef.current = null;
      syncPromiseRef.current = null;
      syncAgainRef.current = false;
      syncPendingRef.current = false;

      localTrack?.stop();
      if (room) void room.disconnect();

      setIsMicOn(false);
      setCanTalk(false);
      setMicWarning(null);
      setAudioBlocked(false);
      setParticipants([]);
      activeSpeakersRef.current = [];
      setSpeakers([]);
      setTxActive(false);
      setTxStarting(false);
      setTxTalk(null);
      setConnectionState(ConnectionState.Disconnected);

      // 受信中の音声要素と、音量ブースト用の経路を片付ける。
      remoteAudiosRef.current.forEach((rec) => {
        if (rec.source) {
          try {
            rec.source.disconnect();
          } catch {
            // noop
          }
        }
        try {
          rec.element.pause();
        } catch {
          // noop
        }
        rec.element.srcObject = null;
        rec.element.remove();
      });
      remoteAudiosRef.current.clear();
      if (audioContainerRef.current) {
        audioContainerRef.current.innerHTML = "";
      }

      if (options.closeAudio && audioCtxRef.current) {
        audioCtxRef.current.close().catch(() => {});
        audioCtxRef.current = null;
        gainRef.current = null;
      }
    },
    [clearAutoOff, clearDm, clearEmergency, endHoldState]
  );

  // ルーム一覧(サーバーから正しく読めたもの)に無くなったルームを、聞くルームから外す。
  // 話す先のルームが無くなったときは、話す先を勝手に別のルーム・「全体」に変えない(広げると、
  // そのルームの人だけに話すつもりの声が全員に届いてしまう)。話す先はそのまま(聞くルームにも
  // 残す)にして知らせ、選び直してもらう。
  // 送信中は聞くルームを変えないので、送信が終わってから行う(finishTransmit)。
  const reconcileChannels = useCallback(() => {
    if (!roomsLoadedRef.current) return;
    if (isTransmittingNow()) {
      reconcilePendingRef.current = true;
      return;
    }
    reconcilePendingRef.current = false;
    const roomList = roomsRef.current;
    const ids = roomList.map((room) => room.id);
    const talk = roomTalkRef.current;
    const nextListen = orderListen(
      listenRef.current.filter((id) => ids.includes(id) || id === talk),
      roomList
    );
    if (serializeListen(nextListen) !== serializeListen(listenRef.current)) {
      listenRef.current = nextListen;
      setListen(nextListen);
      writeStored(LISTEN_KEY, serializeListen(nextListen));
      const room = roomRef.current;
      if (room) applyAllSubscriptions(room);
      refreshParticipants();
      requestTalkSync();
    }
    // ルーム名の変更も含めて、話している人の表示を出し直す。
    refreshSpeakers();
    if (ids.includes(talk)) {
      missingTalkNotifiedRef.current = null;
    } else if (missingTalkNotifiedRef.current !== talk) {
      missingTalkNotifiedRef.current = talk;
      setNotice(
        `話す先のルーム「${talk}」は管理画面で削除されました。話す先を選び直してください（選び直すまでは、ほかの人に声が届かないことがあります）。`
      );
    }
  }, [
    applyAllSubscriptions,
    isTransmittingNow,
    refreshParticipants,
    refreshSpeakers,
    requestTalkSync,
  ]);

  useEffect(() => {
    reconcileRef.current = reconcileChannels;
  }, [reconcileChannels]);

  // 管理画面で編集されたルーム・スタッフを読み込む。
  // サーバーが保存先を読めなかったとき(503)は、今のルーム一覧のまま(聞くルームも変えない)。
  const loadConfig = useCallback(async () => {
    configFetchedAtRef.current = Date.now();
    try {
      const response = await fetch("/api/config", { cache: "no-store" });
      if (!response.ok) return;
      const data = (await response.json()) as {
        rooms?: IntercomRoom[];
        staff?: string[];
        role?: string;
      };
      if (Array.isArray(data.rooms) && data.rooms.length > 0) {
        // 「全体」は全員が必ず聞く・緊急呼び出し先なので、一覧に無くても必ず出す。
        const roomList = withBroadcastChannel(
          data.rooms.filter(
            (room) => !!room && typeof room.id === "string" && typeof room.label === "string"
          ),
          DEFAULT_BROADCAST_ROOM
        );
        roomsRef.current = roomList;
        roomsLoadedRef.current = true;
        setRooms(roomList);
        setRoomsLoaded(true);
        reconcileChannels();
      }
      if (Array.isArray(data.staff)) setStaffNames(data.staff);
      setIsAdmin(data.role === "admin");
    } catch {
      // 取得失敗時は今のルーム一覧のまま
    }
  }, [reconcileChannels]);

  // 前回のスタッフ名・聞くルーム・話す先を復元し、管理画面で編集されたルーム・スタッフを読み込む。
  useEffect(() => {
    const savedName = readStored(LAST_NAME_KEY);
    if (savedName && !validateDisplayName(savedName)) {
      setDisplayName((current) => (current ? current : savedName.trim()));
    }

    if (!roomRef.current) {
      // 旧形式(ルームを1つだけ保存)からも引き継ぐ: そのルームを聞いて、そのルームに話す。
      const savedListen = readStored(LISTEN_KEY);
      const savedTalk = readStored(TALK_KEY);
      const legacyRoom = readStored(LAST_ROOM_KEY);
      const restoredListen =
        savedListen !== null
          ? parseListen(savedListen)
          : normalizeListen([legacyRoom ?? DEFAULT_TALK_CHANNEL]);
      const restoredTalk = pickTalkChannel(
        savedTalk ?? legacyRoom ?? DEFAULT_TALK_CHANNEL,
        restoredListen
      );
      listenRef.current = restoredListen;
      roomTalkRef.current = restoredTalk;
      setListen(restoredListen);
      setRoomTalk(restoredTalk);
    }

    void loadConfig();
  }, [loadConfig]);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const cancelAutoReconnect = useCallback(() => {
    reconnectWantedRef.current = false;
    reconnectAttemptRef.current = 0;
    clearReconnectTimer();
    setReconnectPending(false);
  }, [clearReconnectTimer]);

  const tryAutoReconnect = useCallback(() => {
    if (!reconnectWantedRef.current || userDisconnectedRef.current) return;
    if (connectingRef.current || roomRef.current) return;
    // オフライン中は 'online' イベントを待つ。
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    clearReconnectTimer();
    void connectRef.current?.({ auto: true });
  }, [clearReconnectTimer]);

  const scheduleReconnect = useCallback(() => {
    if (!reconnectWantedRef.current || userDisconnectedRef.current) return;
    clearReconnectTimer();
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    const index = Math.min(reconnectAttemptRef.current, RECONNECT_DELAYS_MS.length - 1);
    reconnectAttemptRef.current += 1;
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;
      tryAutoReconnect();
    }, RECONNECT_DELAYS_MS[index]);
  }, [clearReconnectTimer, tryAutoReconnect]);

  // サーバー側・通信の都合で切断されたとき。
  const handleRoomDisconnected = useCallback(
    (reason?: DisconnectReason) => {
      // 個別に話す設定は切断で解除される(再接続後は全員(ルーム)あて)ので、知らせるために覚えておく。
      const endedDm = dmTargetRef.current;
      teardownRoom();

      if (reason === DisconnectReason.CLIENT_INITIATED) return;

      if (reason === DisconnectReason.DUPLICATE_IDENTITY) {
        cancelAutoReconnect();
        setError(
          "同じIDの別の端末（このパソコンの別のタブ・ウィンドウを含む）がインカムに接続したため、この画面の接続は切れました。使わない方の画面を閉じてから、もう一度「接続する」を押してください。"
        );
        return;
      }

      if (reason === DisconnectReason.PARTICIPANT_REMOVED) {
        cancelAutoReconnect();
        setError(
          "サーバー側でこの画面の接続が解除されました。必要な場合は、もう一度「接続する」を押してください。"
        );
        return;
      }

      if (userDisconnectedRef.current) return;

      reconnectWantedRef.current = true;
      reconnectAttemptRef.current = 0;
      setReconnectPending(true);
      setNotice(null);
      setError(
        `インカムの接続が切れました。通信が戻ると自動で再接続します（再接続後のマイクはOFFです）。${
          endedDm ? `${endedDm.name}さんとの個別は解除されました（再接続後の話す先は全員（ルーム）です）。` : ""
        }`
      );
      scheduleReconnect();
    },
    [cancelAutoReconnect, scheduleReconnect, teardownRoom]
  );

  // マイクを用意して送信できるようにする。使えない場合は「聞くだけ」で接続を続ける。
  const setupMicrophone = useCallback(async (room: Room): Promise<boolean> => {
    if (localTrackRef.current) return true;
    if (micSetupRoomRef.current === room) return false;
    micSetupRoomRef.current = room;
    setMicPending(true);
    let track: LocalAudioTrack | null = null;
    let published = false;
    try {
      track = await createLocalAudioTrack({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      });
      if (roomRef.current !== room) {
        track.stop();
        return false;
      }

      // 接続直後は必ずマイクOFF(送信しない)。公開する前にミュートしておき、
      // ほかの端末へ一瞬でもマイクONの状態で届かないようにする。
      await track.mute();
      if (roomRef.current !== room) {
        track.stop();
        return false;
      }

      await room.localParticipant.publishTrack(track, {
        source: Track.Source.Microphone,
      });
      published = true;

      if (roomRef.current !== room) {
        track.stop();
        return false;
      }

      localTrackRef.current = track;
      micOnRef.current = false;
      setIsMicOn(false);
      setCanTalk(true);
      setMicWarning(null);
      return true;
    } catch (micError) {
      console.error(micError);
      if (track) {
        track.stop();
        if (published) {
          try {
            await room.localParticipant.unpublishTrack(track);
          } catch {
            // noop
          }
        }
      }
      if (roomRef.current !== room) return false;
      localTrackRef.current = null;
      micOnRef.current = false;
      setIsMicOn(false);
      setCanTalk(false);
      setMicWarning(micErrorMessage(micError));
      return false;
    } finally {
      if (micSetupRoomRef.current === room) {
        micSetupRoomRef.current = null;
        setMicPending(false);
      }
    }
  }, []);

  // 共通ルーム(SHARED_ROOM)に接続する。ルームは接続の中の「チャンネル」なので、
  // 聞くルーム・話す先の切り替えでは接続し直さない。
  const connect = useCallback(
    async (options: ConnectOptions = {}): Promise<boolean> => {
      if (connectingRef.current) return false;
      const auto = options.auto === true;

      let name: string;
      if (auto && lastNameRef.current) {
        name = lastNameRef.current;
      } else {
        const trimmed = displayNameRef.current.trim();
        const nameError = validateDisplayName(trimmed);
        if (nameError) {
          setError(nameError);
          return false;
        }
        name = trimmed;
      }

      connectingRef.current = true;
      if (!auto) userDisconnectedRef.current = false;
      clearReconnectTimer();
      setIsBusy(true);
      if (!auto) {
        setError(null);
        setNotice(null);
      }

      teardownRoom();

      // ユーザー操作(接続ボタン)の中でAudioContextを起動しておく(自動再生制限対策)。
      const ctx = ensureAudioGraph();
      if (ctx && ctx.state === "suspended") void ctx.resume();

      let room: Room | null = null;
      try {
        const identity = buildIdentity(name, getDeviceTag());
        const tokenResponse = await requestToken(identity, name, SHARED_ROOM);
        if (userDisconnectedRef.current) return false;

        const thisRoom = new Room({
          adaptiveStream: false,
          dynacast: false,
        });
        room = thisRoom;
        let joined = false;

        roomRef.current = thisRoom;

        thisRoom
          .on(RoomEvent.ConnectionStateChanged, (state: ConnectionState) => {
            if (roomRef.current !== thisRoom) return;
            setConnectionState(state);
          })
          .on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
            if (roomRef.current !== thisRoom || !joined) return;
            handleRoomDisconnected(reason);
          })
          .on(RoomEvent.AudioPlaybackStatusChanged, () => {
            if (roomRef.current !== thisRoom) return;
            setAudioBlocked(!thisRoom.canPlaybackAudio);
          })
          .on(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => {
            if (roomRef.current !== thisRoom) return;
            applySubscription(thisRoom, participant);
            refreshParticipants();
          })
          .on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
            if (roomRef.current !== thisRoom) return;
            refreshParticipants();
            const target = dmTargetRef.current;
            if (!target || target.identity !== participant.identity) return;
            // 完全な再接続の始まりにも、全員分の ParticipantDisconnected が来る(直後に再接続中になる)。
            // 状態を確かめてから判断する。再接続中なら、再接続できたとき(Reconnected)に確かめ直す。
            void Promise.resolve().then(() => {
              if (roomRef.current !== thisRoom) return;
              if (thisRoom.state !== ConnectionState.Connected) return;
              if (thisRoom.remoteParticipants.has(target.identity)) return;
              handleDmTargetLeft(target);
            });
          })
          .on(RoomEvent.TrackPublished, (publication, participant) => {
            if (roomRef.current !== thisRoom) return;
            if (publication.source !== Track.Source.Microphone) return;
            applySubscription(thisRoom, participant);
          })
          .on(RoomEvent.ParticipantAttributesChanged, (changed, participant) => {
            if (roomRef.current !== thisRoom) return;
            if (participant.isLocal) {
              // サーバーに反映された話す先が変わった時刻(変わった直後の送信は少し待つ。TALK_SETTLE_MS)。
              if (ATTR.talk in changed) talkChangedAtRef.current = Date.now();
              // 聞く判定は自分の聞くルーム(手元の値)で決めているので結果は変わらないが、念のため決め直す
              // (変わらない相手には何も送らない)。
              applyAllSubscriptions(thisRoom);
              // 完全な再接続などで、サーバー側の自分の属性が消えた・違うときは貼り直す。
              if (!isTalkSynced(thisRoom)) requestTalkSync();
              return;
            }
            // 相手の話す先が変わったら、聞くかどうかを決め直す(話している最中の表示も出し直す)。
            applySubscription(thisRoom, participant as RemoteParticipant);
            refreshParticipants();
            refreshSpeakers();
          })
          .on(RoomEvent.Reconnected, () => {
            if (roomRef.current !== thisRoom) return;
            // 完全な再接続では購読と自分の属性が消えるので、全員分を決め直して貼り直す。
            applyAllSubscriptions(thisRoom);
            refreshParticipants();
            const target = dmTargetRef.current;
            if (target && !thisRoom.remoteParticipants.has(target.identity)) {
              handleDmTargetLeft(target);
              return;
            }
            requestTalkSync();
          })
          .on(RoomEvent.ActiveSpeakersChanged, (active: Participant[]) => {
            if (roomRef.current !== thisRoom) return;
            // 共通ルームでは全員の発話がここに来るので、自分に聞こえる人だけを出す
            // (他のルームあて・他の人あての個別は出さない。refreshSpeakers)。
            activeSpeakersRef.current = active;
            refreshSpeakers();
          })
          .on(RoomEvent.TrackSubscribed, (track) => {
            if (roomRef.current !== thisRoom) return;
            if (track.kind !== Track.Kind.Audio) return;
            const element = track.attach();
            element.autoplay = true;
            element.dataset.livekitTrack = "remote-audio";
            audioContainerRef.current?.appendChild(element);
            // 要素を登録し、現在の音量設定を適用(必要なら増幅経路に切替)。
            remoteAudiosRef.current.set(track, { element, source: null });
            applyVolume(volumeRef.current);
          })
          .on(RoomEvent.TrackUnsubscribed, (track) => {
            if (roomRef.current !== thisRoom) return;
            const rec = remoteAudiosRef.current.get(track);
            if (rec?.source) {
              try {
                rec.source.disconnect();
              } catch {
                // noop
              }
            }
            remoteAudiosRef.current.delete(track);
            track.detach().forEach((element) => element.remove());
          })
          .on(
            RoomEvent.DataReceived,
            (payload: Uint8Array, participant?: RemoteParticipant, _kind?: unknown, topic?: string) => {
              if (roomRef.current !== thisRoom) return;
              if (topic !== "intercom.signal") return;
              try {
                const decoded = new TextDecoder().decode(payload);
                const signal = JSON.parse(decoded) as SignalMessage;
                const from = participant?.name || participant?.identity || signal.from;
                setLastSignal(`${from}: ${signal.message ?? signal.type}`);
              } catch {
                setLastSignal("お知らせを受信しました");
              }
            }
          );

        // 自動購読はしない。誰の声を聞くかは、相手の話す先と自分の聞くルームで決める(shouldHear)。
        await thisRoom.connect(tokenResponse.url, tokenResponse.token, { autoSubscribe: false });
        if (roomRef.current !== thisRoom) return false;
        joined = true;

        lastNameRef.current = name;
        setConnectionState(thisRoom.state);
        setAudioBlocked(!thisRoom.canPlaybackAudio);
        // 接続前から居た人には ParticipantConnected/TrackPublished が来ないので、ここで全員分を決める。
        applyAllSubscriptions(thisRoom);
        refreshParticipants();
        // 聞くルーム・話す先を自分の属性として知らせる(マイクの準備より先に始める。反映は待たない)。
        void syncTalkState();
        writeStored(LAST_NAME_KEY, name);

        const wasReconnecting = reconnectWantedRef.current;
        reconnectWantedRef.current = false;
        reconnectAttemptRef.current = 0;
        setReconnectPending(false);
        if (wasReconnecting) {
          setError(null);
          setNotice("インカムに再接続しました（マイクはOFFです）。");
        }

        connectingRef.current = false;
        setIsBusy(false);

        // マイクの準備(許可ダイアログが出ることがある)。失敗しても受信は続ける。
        await setupMicrophone(thisRoom);
        return true;
      } catch (connectError) {
        console.error(connectError);
        // 途中で「切断する」が押された、または別の接続に切り替わった場合は何もしない。
        if (userDisconnectedRef.current || (room !== null && roomRef.current !== room)) {
          return false;
        }
        teardownRoom();

        if (connectError instanceof TokenRequestError && connectError.status === 401) {
          cancelAutoReconnect();
          setError(connectError.message);
          window.location.href = "/login";
          return false;
        }

        const message =
          connectError instanceof TokenRequestError
            ? connectError.message
            : "インカムのサーバーに接続できませんでした。通信状況を確認して、もう一度お試しください。";

        if (auto || reconnectWantedRef.current) {
          setError(`インカムの接続が切れています。自動で再接続を続けています…（${message}）`);
          scheduleReconnect();
        } else {
          setError(message);
        }
        return false;
      } finally {
        if (connectingRef.current) {
          connectingRef.current = false;
          setIsBusy(false);
        }
      }
    },
    [
      applyAllSubscriptions,
      applySubscription,
      applyVolume,
      cancelAutoReconnect,
      clearReconnectTimer,
      ensureAudioGraph,
      handleDmTargetLeft,
      handleRoomDisconnected,
      isTalkSynced,
      refreshParticipants,
      refreshSpeakers,
      requestTalkSync,
      scheduleReconnect,
      setupMicrophone,
      syncTalkState,
      teardownRoom,
    ]
  );

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  // 「切断する」ボタン。自動再接続もしない。
  const disconnect = useCallback(() => {
    userDisconnectedRef.current = true;
    cancelAutoReconnect();
    teardownRoom({ closeAudio: true });
    setError(null);
    setNotice(null);
  }, [cancelAutoReconnect, teardownRoom]);

  const logout = useCallback(async () => {
    disconnect();
    try {
      await fetch("/api/logout", { method: "POST" });
    } catch {
      // ネットワークエラーでもログイン画面へ戻す
    }
    window.location.href = "/login";
  }, [disconnect]);

  const retryMicrophone = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    setMicWarning(null);
    await setupMicrophone(room);
  }, [setupMicrophone]);

  const resumeAudio = useCallback(async () => {
    const ctx = audioCtxRef.current;
    if (ctx && ctx.state !== "running") {
      try {
        await ctx.resume();
      } catch {
        // noop
      }
    }
    const room = roomRef.current;
    if (!room) return;
    try {
      await room.startAudio();
    } catch {
      // noop
    }
    setAudioBlocked(!room.canPlaybackAudio);
  }, []);

  const sendSignal = useCallback(async (message: SignalMessage): Promise<boolean> => {
    const room = roomRef.current;
    if (!room || room.state !== ConnectionState.Connected) return false;

    try {
      const payload = new TextEncoder().encode(JSON.stringify(message));
      await room.localParticipant.publishData(payload, {
        reliable: true,
        topic: "intercom.signal",
      });
      return true;
    } catch (signalError) {
      console.error(signalError);
      return false;
    }
  }, []);

  // 押している間だけ送信(大きなボタン/スペースキー)。
  // 離したことを検知できなかった場合に備えて、押し続けても HOLD_MAX_MS で止める。
  const startHold = useCallback(
    (source: "pointer" | "key", pointerId?: number) => {
      if (!localTrackRef.current || holdActiveRef.current) return;
      // 再接続中などは送信を始めない。
      if (roomRef.current?.state !== ConnectionState.Connected) return;
      holdActiveRef.current = true;
      holdSourceRef.current = source;
      holdPointerIdRef.current = pointerId ?? null;
      clearAutoOff();
      if (holdLimitTimerRef.current !== null) window.clearTimeout(holdLimitTimerRef.current);
      holdLimitTimerRef.current = window.setTimeout(() => {
        holdLimitTimerRef.current = null;
        if (!holdActiveRef.current) return;
        stopAllTransmit(
          `${HOLD_MAX_MS / 1000}秒以上押し続けているため、送信を停止しました。話す場合は、いったん離してからもう一度押してください。`
        );
      }, HOLD_MAX_MS);
      // タップ送信中(または開始待ち)に押した場合は、そのまま「押している間だけ」に切り替える。
      if (txActiveRef.current) return;
      void beginTransmit();
    },
    [beginTransmit, clearAutoOff, stopAllTransmit]
  );

  const stopHold = useCallback(() => {
    if (!holdActiveRef.current) return;
    stopAllTransmit();
  }, [stopAllTransmit]);

  // タップで送信開始/停止。送信は30秒で自動停止する。
  const toggleTransmit = useCallback(() => {
    if (!localTrackRef.current) return;
    if (txActiveRef.current || micOnRef.current) {
      stopAllTransmit();
      return;
    }
    endHoldState();
    setNotice(null);
    armAutoOff(AUTO_OFF_MS, "30秒たったため、送信を自動で停止しました。");
    void beginTransmit();
  }, [armAutoOff, beginTransmit, endHoldState, stopAllTransmit]);

  // 聞くルームの追加・解除(「全体」は外せない)。接続し直さずに、聞く相手をすぐ切り替える。
  const toggleListen = useCallback(
    (id: string) => {
      // 送信中は変えない。
      if (id === BROADCAST_CHANNEL || isTransmittingNow()) return;
      const current = listenRef.current;
      const nextListen = orderListen(
        current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
        roomsRef.current
      );
      listenRef.current = nextListen;
      setListen(nextListen);
      writeStored(LISTEN_KEY, serializeListen(nextListen));
      // 話す先のルームを聞くルームから外したら、話す先も聞いているルームに移す。
      const nextTalk = pickTalkChannel(roomTalkRef.current, nextListen);
      if (nextTalk !== roomTalkRef.current) {
        roomTalkRef.current = nextTalk;
        setRoomTalk(nextTalk);
        writeStored(TALK_KEY, nextTalk);
        setNotice(`話す先を「${channelLabel(nextTalk, roomsRef.current)}」に変えました。`);
      }
      const room = roomRef.current;
      if (room) applyAllSubscriptions(room);
      refreshParticipants();
      refreshSpeakers();
      requestTalkSync();
    },
    [applyAllSubscriptions, isTransmittingNow, refreshParticipants, refreshSpeakers, requestTalkSync]
  );

  // 話す先のルームを選ぶ。個別・緊急呼び出し中なら、それを終えてこのルームに話す。
  const selectTalkChannel = useCallback(
    (id: string) => {
      if (isTransmittingNow() || !listenRef.current.includes(id)) return;
      clearDm();
      clearEmergency();
      roomTalkRef.current = id;
      setRoomTalk(id);
      writeStored(TALK_KEY, id);
      refreshParticipants();
      // 無くなったルームを話す先にしていた場合は、選び直したので聞くルームからも外す。
      reconcileChannels();
      requestTalkSync();
    },
    [
      clearDm,
      clearEmergency,
      isTransmittingNow,
      reconcileChannels,
      refreshParticipants,
      requestTalkSync,
    ]
  );

  // 個別に話す相手を選ぶ(接続中の人だけ)。話す先は、その人だけに届く設定になる。
  const selectDm = useCallback(
    (identity: string, name: string) => {
      const room = roomRef.current;
      if (!room || room.state !== ConnectionState.Connected || isTransmittingNow()) return;
      if (!room.remoteParticipants.has(identity)) {
        setNotice(`${name}さんは退出しました。`);
        refreshParticipants();
        return;
      }
      // 同じ人をもう一度押しても何もしない(誤って全員に戻らないように)。
      if (dmTargetRef.current?.identity === identity) return;
      clearEmergency();
      const since = Date.now();
      dmTargetRef.current = { identity, name };
      dmSinceRef.current = since;
      setDmTarget({ identity, name });
      setDmSince(since);
      setNow(since);
      setNotice(null);
      checkDmExpiry();
      requestTalkSync();
    },
    [checkDmExpiry, clearEmergency, isTransmittingNow, refreshParticipants, requestTalkSync]
  );

  // 「全員（ルーム）に戻す」ボタン。
  const revertDmManually = useCallback(() => {
    if (isTransmittingNow()) return;
    revertDm(`話す先を「${roomTalkLabel()}」（全員・ルーム）に戻しました。`);
  }, [isTransmittingNow, revertDm, roomTalkLabel]);

  // 緊急呼び出し: 通知を送り、話す先を8秒間だけ「全体」にしてマイクをONにする。
  // 「全体」は全員が必ず聞くので、どのルームを聞いている人にも届く(聞くルーム・接続は変えない)。
  // 終わったら元の話す先に戻す(このパソコンを「全体」に話したままにしない)。
  const runEmergencyAllCall = useCallback(async () => {
    setNotice(null);
    setError(null);
    const room = roomRef.current;
    if (!room || room.state !== ConnectionState.Connected) {
      setError(
        "緊急呼び出しを送れませんでした（インカムに接続していません）。通信状況を確認して、もう一度押してください。"
      );
      return;
    }

    // 話す先を変えるので、送信中ならいったん止める。
    stopAllTransmit();
    // 個別に話す設定中なら終える(緊急は全員へ)。
    const endedDm = dmTargetRef.current;
    if (endedDm) clearDm();
    startEmergency();
    // 「全体」への切り替えを、通知の送信と並行して始めておく。
    requestTalkSync();

    const sent = await sendSignal({
      type: "emergency",
      from: lastNameRef.current ?? displayNameRef.current.trim(),
      room: BROADCAST_CHANNEL,
      sentAt: new Date().toISOString(),
      message: "緊急全体呼び出し",
    });
    if (roomRef.current !== room) return;

    const hasMic = !!localTrackRef.current;
    // 通知を送っている間に別のウィンドウ・タブへ移っていたら、マイクはONにしない
    // (見ていない画面で送信が始まり、赤い表示にも気づけないため)。
    // 自分で送信を始めた・話す先を選び直した場合も、自動ではONにしない。
    const screenActive = document.visibilityState === "visible" && document.hasFocus();
    let autoTalk = false;
    if (hasMic && screenActive && emergencyRef.current !== null && !isTransmittingNow()) {
      endHoldState();
      armAutoOff(EMERGENCY_TALK_MS, "緊急呼び出しの送信を終了しました（マイクOFF）。元の話す先に戻しました。");
      autoTalk = await beginTransmit({ emergency: true });
      if (roomRef.current !== room) return;
    }

    const dmNote = endedDm ? `${endedDm.name}さんとの個別は終了しました。` : "";
    if (sent) {
      setNotice(
        autoTalk
          ? `緊急呼び出しを送りました。8秒間、全員に向けてマイクがONになるので、そのまま話してください（どのルームを聞いている人にも届きます）。終わると元の話す先に戻ります。${dmNote}`
          : hasMic
            ? `緊急呼び出しを送りました。マイクはONにしていません。声で呼びかける場合は、8秒以内にこの画面で「押して話す」を使ってください（その間は全員に届きます）。${dmNote}`
            : `緊急呼び出しを送りました（マイクが使えないため、声は送れません）。${dmNote}`
      );
    } else {
      setError(
        autoTalk
          ? "緊急の通知を送れませんでした。8秒間、全員に向けてマイクがONになっているので、声で呼びかけてください。"
          : hasMic
            ? "緊急の通知を送れませんでした。マイクもONにしていません。この画面で、もう一度押してください。"
            : "緊急の通知を送れませんでした。通信状況を確認して、もう一度押してください。"
      );
    }
  }, [
    armAutoOff,
    beginTransmit,
    clearDm,
    endHoldState,
    isTransmittingNow,
    requestTalkSync,
    sendSignal,
    startEmergency,
    stopAllTransmit,
  ]);

  // 緊急呼び出しのボタン。処理中にもう一度押された(慌てたダブルクリック等)ときは何もしない
  // (通知を二重に送らない・1回目の送信を止めてしまわない・マイクの状態と案内を食い違わせない)。
  const emergencyAllCall = useCallback(async () => {
    if (emergencyBusyRef.current) return;
    emergencyBusyRef.current = true;
    try {
      await runEmergencyAllCall();
    } finally {
      emergencyBusyRef.current = false;
    }
  }, [runEmergencyAllCall]);

  // キーボード: スペースキーを押している間だけ送信。ほかのキー(Enter・矢印・ページ送り・
  // メディアキー等)では送信しない。キーのリピートは無視する。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      if (isTypingTarget(event.target)) return;
      if (!roomRef.current) return;
      // ページのスクロールや、選択中のボタンが押されてしまうのを防ぐ。
      event.preventDefault();
      if (event.repeat) return;
      startHold("key");
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      if (holdActiveRef.current) {
        event.preventDefault();
        stopHold();
        return;
      }
      if (!isTypingTarget(event.target) && roomRef.current) event.preventDefault();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [startHold, stopHold]);

  // 「押して話す」ボタンを離したことを、ボタンの外(ページのどこか)でも拾う保険。
  // ボタンが途中で押せない状態になると、ボタン自体には離した操作が届かないブラウザがあるため。
  useEffect(() => {
    const onPointerEnd = (event: PointerEvent) => {
      if (!holdActiveRef.current || holdSourceRef.current !== "pointer") return;
      const pointerId = holdPointerIdRef.current;
      if (pointerId !== null && event.pointerId !== pointerId) return;
      stopHold();
    };
    window.addEventListener("pointerup", onPointerEnd);
    window.addEventListener("pointercancel", onPointerEnd);
    return () => {
      window.removeEventListener("pointerup", onPointerEnd);
      window.removeEventListener("pointercancel", onPointerEnd);
    };
  }, [stopHold]);

  // 通信が不安定になって再接続が始まったら、送信を止める
  // (再接続中は送信ボタンが押せず、止められなくなるため)。
  useEffect(() => {
    if (
      connectionState === ConnectionState.Reconnecting ||
      connectionState === ConnectionState.SignalReconnecting
    ) {
      stopAllTransmit(
        "通信が不安定になったため、送信を停止しました。つながったら、もう一度押して話してください。"
      );
    }
  }, [connectionState, stopAllTransmit]);

  // 送信の止め忘れ防止: 別のウィンドウに移った・画面が隠れた・ページを離れたときは送信を止める。
  // 自動再接続: 通信が戻ったとき・画面が再表示されたときにすぐ試す。
  // 画面が再表示されたときは、裏で遅れたタイマー(個別・緊急呼び出しの期限)の確認と、
  // 管理画面で変わったルーム一覧の読み直しもする。
  useEffect(() => {
    const onBlur = () => {
      stopAllTransmit("別の画面に切り替わったため、送信を停止しました。");
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        stopAllTransmit("画面が非表示になったため、送信を停止しました。");
      } else {
        reconnectAttemptRef.current = 0;
        tryAutoReconnect();
        checkDmExpiryRef.current?.();
        const emergency = emergencyRef.current;
        if (emergency && Date.now() >= emergency.until && !isTransmittingNow()) endEmergency();
        if (Date.now() - configFetchedAtRef.current >= CONFIG_REFRESH_MS) void loadConfig();
      }
    };
    const onPageHide = () => {
      stopAllTransmit();
    };
    const onOnline = () => {
      reconnectAttemptRef.current = 0;
      tryAutoReconnect();
    };

    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("online", onOnline);

    return () => {
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("online", onOnline);
    };
  }, [endEmergency, isTransmittingNow, loadConfig, stopAllTransmit, tryAutoReconnect]);

  // ボタン/リモコンの確認用: 押されたキーを常に記録(入力欄での入力中は除く)。
  useEffect(() => {
    const onAnyKey = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      setLastKeyCode(event.code);
    };
    window.addEventListener("keydown", onAnyKey);
    return () => window.removeEventListener("keydown", onAnyKey);
  }, []);

  useEffect(() => {
    return () => {
      userDisconnectedRef.current = true;
      cancelAutoReconnect();
      teardownRoom({ closeAudio: true });
    };
  }, [cancelAutoReconnect, teardownRoom]);

  const displayNameError = displayName.trim() ? validateDisplayName(displayName) : null;
  // 候補には、スタッフ名の規則に合う名前だけを出す(合わない名前は選んでも接続できないため)。
  const staffNameOptions = useMemo(
    () =>
      Array.from(new Set(staffNames.map((name) => name.trim()))).filter(
        (name) => validateDisplayName(name) === null
      ),
    [staffNames]
  );
  const autoOffRemaining =
    autoOffAt !== null ? Math.max(0, Math.ceil((autoOffAt - now) / 1000)) : null;
  const isTransmitting = isMicOn && connectionState !== ConnectionState.Disconnected;
  // 送信中(切り替え待ちを含む)は、聞くルーム・話す先・個別の相手を変えられない。
  const talkLocked = txActive || isMicOn;
  // 今の話す先(緊急呼び出し中 > 個別 > ふだんのルーム)。
  const currentTalk = emergencyActive
    ? BROADCAST_CHANNEL
    : dmTarget
      ? dmTalk(dmTarget.identity)
      : roomTalk;
  const talkLabelOf = (talk: string): string => {
    const target = dmTargetOf(talk);
    if (target !== null) {
      const name =
        participants.find((participant) => participant.id === target)?.label ??
        (dmTarget?.identity === target ? dmTarget.name : target);
      return `🔒 ${name}さん（個別）`;
    }
    return channelLabel(talk, rooms);
  };
  const currentTalkLabel = `${talkLabelOf(currentTalk)}${emergencyActive ? "（緊急呼び出し中）" : ""}`;
  const listenedRooms = rooms.filter((room) => listen.includes(room.id));
  const otherPeople = participants.filter((participant) => !participant.isLocal);
  const dmSending = !!dmTarget && txActive && txTalk === dmTalk(dmTarget.identity);
  const dmRemainingSec = dmTarget
    ? Math.min(DM_REVERT_MS / 1000, Math.ceil(dmRemainingMs(dmSince, now) / 1000))
    : null;

  return (
    <main className="shell">
      <header className="brandBar">
        <img src="/mirise-logo.png" alt="MIRISE WELLMEDICAL GROUP" className="brandLogo" />
        <div className="brandBarActions">
          {isAdmin ? (
            <Link className="logoutButton" href="/admin">
              管理画面
            </Link>
          ) : null}
          <button className="logoutButton" onClick={() => void logout()}>
            ログアウト
          </button>
        </div>
      </header>

      {isTransmitting ? (
        <div className="liveBanner" role="status">
          🔴 送信中（マイクON）→ {talkLabelOf(txTalk ?? currentTalk)} —{" "}
          {autoOffRemaining !== null
            ? `話し終わったら停止してください（あと${autoOffRemaining}秒で自動停止）`
            : "離すと停止します"}
        </div>
      ) : null}

      {connectionState === ConnectionState.Reconnecting ||
      connectionState === ConnectionState.SignalReconnecting ? (
        <div className="reconnectBanner" role="status">
          通信が不安定なため、再接続しています…
        </div>
      ) : null}

      <section className="hero">
        <div>
          <p className="eyebrow">MIRISE</p>
          <h1>院内音声インカム</h1>
          <p className="lead">
            受付のパソコンから、スタッフのイヤホンへ声で連絡できます。スタッフ名を入れ、聞くルームと話す先を選んで「接続する」を押してください。接続したままルームを切り替えたり、1人だけに個別で話したりできます。
          </p>
        </div>
        <div className={`status ${isConnected ? "statusConnected" : ""}`}>
          {connectionLabel(connectionState)}
        </div>
      </section>

      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}

      {micWarning ? (
        <div className="warning" role="status">
          <p>{micWarning}</p>
          {inSession && !canTalk && !micPending ? (
            <button className="inlineButton" onClick={() => void retryMicrophone()}>
              マイクを再確認
            </button>
          ) : null}
        </div>
      ) : null}

      {notice ? (
        <p className="notice" role="status">
          {notice}
        </p>
      ) : null}

      {audioBlocked && inSession ? (
        <button className="primary audioResume" onClick={() => void resumeAudio()}>
          🔈 音声が止まっています。ここを押して再生してください
        </button>
      ) : null}

      <section className="panel gridTwo">
        <label className="field">
          <span>スタッフ名</span>
          <input
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder="例: 受付 佐藤"
            disabled={isBusy || inSession}
            list={staffNameOptions.length > 0 ? "staffNameList" : undefined}
            autoComplete="off"
          />
          {staffNameOptions.length > 0 ? (
            <datalist id="staffNameList">
              {staffNameOptions.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          ) : null}
          {displayNameError ? <small className="fieldError">{displayNameError}</small> : null}
        </label>

        <div className="actions">
          {inSession ? (
            <button className="secondary" onClick={disconnect}>
              切断する
            </button>
          ) : reconnectPending ? (
            <div className="actionStack">
              <button className="primary" onClick={() => void connect()} disabled={isBusy}>
                {isBusy ? "再接続しています..." : "今すぐ再接続する"}
              </button>
              <button className="secondary" onClick={disconnect}>
                切断する（自動再接続をやめる）
              </button>
            </div>
          ) : (
            <button className="primary" onClick={() => void connect()} disabled={isBusy}>
              {isBusy ? "接続しています..." : "接続する"}
            </button>
          )}
        </div>
      </section>

      <section className="panel">
        <p className="eyebrow">聞くルーム（複数可）</p>
        <div className="roomButtons">
          {rooms.map((room) => {
            const fixed = room.id === BROADCAST_CHANNEL;
            const selected = fixed || listen.includes(room.id);
            return (
              <button
                key={room.id}
                className={`${selected ? "selected" : ""} ${fixed ? "fixedChip" : ""}`}
                aria-pressed={selected}
                onClick={() => toggleListen(room.id)}
                disabled={fixed || talkLocked}
                title={fixed ? "「全体」は全員が常に聞きます（外せません）" : room.description}
              >
                {selected ? "✓ " : ""}
                {room.label}
              </button>
            );
          })}
        </div>

        <p className="eyebrow">話す先</p>
        <div className="roomButtons">
          {listenedRooms.map((room) => (
            <button
              key={room.id}
              className={!dmTarget && !emergencyActive && roomTalk === room.id ? "selected" : ""}
              aria-pressed={!dmTarget && !emergencyActive && roomTalk === room.id}
              onClick={() => selectTalkChannel(room.id)}
              disabled={talkLocked}
              title={room.description}
            >
              {room.label}
            </button>
          ))}
        </div>
        {roomsLoaded && !rooms.some((room) => room.id === roomTalk) ? (
          <div className="warning" role="status">
            <p>
              話す先のルーム「{roomTalk}」は管理画面で削除されました。話す先を選び直してください。
            </p>
          </div>
        ) : null}

        <p className="eyebrow">個別に話す（選んだ1人だけに届きます）</p>
        {inSession ? (
          otherPeople.length > 0 ? (
            <div className="roomButtons">
              {otherPeople.map((person) => (
                <button
                  key={person.id}
                  className={dmTarget?.identity === person.id ? "selected" : ""}
                  aria-pressed={dmTarget?.identity === person.id}
                  onClick={() => selectDm(person.id, person.label)}
                  disabled={talkLocked || !isConnected}
                >
                  🔒 {person.label}
                  {person.home ? `（${channelLabel(person.home, rooms)}）` : ""}
                </button>
              ))}
            </div>
          ) : (
            <p className="emptyHint">ほかに接続中の人はいません。</p>
          )
        ) : (
          <p className="emptyHint">接続すると、接続中（出勤中）の人を選んで個別に話せます。</p>
        )}

        {dmTarget ? (
          <div className="dmStatus" role="status">
            <p>
              🔒 <strong>{dmTarget.name}さん</strong>だけに話す設定です。
              {dmSending
                ? `話し終えてから${DM_REVERT_MS / 1000}秒たつと、全員（ルーム）に戻ります。`
                : `あと${dmRemainingSec ?? 0}秒で、話す先が「${channelLabel(roomTalk, rooms)}」（全員・ルーム）に戻ります。`}
            </p>
            <button className="inlineButton" onClick={revertDmManually} disabled={talkLocked}>
              全員（ルーム）に戻す
            </button>
          </div>
        ) : null}

        <p className="hint">
          ・<strong>聞くルーム</strong>：選んだルームあての声が聞こえます。「全体」あての声は常に聞こえます。
          <br />・<strong>話す先</strong>：押して話したとき、そのルームを聞いている人に届きます（「全体」は全員に届きます）。
          <br />・<strong>個別に話す</strong>：選んだ1人だけに届きます。最後に話し終えてから{DM_REVERT_MS / 1000}秒たつと、自動で全員（ルーム）に戻ります。
          <br />
          接続したまま切り替えられます（送信中は切り替えできません）。
        </p>
      </section>

      <section className="panel">
        <div className="roomHeader">
          <div>
            <p className="eyebrow">話す先</p>
            <h2>{currentTalkLabel}</h2>
          </div>
          <div className={`micPill ${isTransmitting ? "micOn" : ""}`}>
            {inSession && !canTalk
              ? micPending
                ? "マイク準備中"
                : "聞くだけ"
              : isTransmitting
                ? "マイクON"
                : txStarting
                  ? "話す先を切り替え中…"
                  : "マイクOFF"}
          </div>
        </div>

        {speakers.length > 0 ? (
          <div className="speakers" aria-live="polite">
            {speakers.map((line, index) => (
              <p
                key={`${index}-${line}`}
                className={`speakerLine ${line.startsWith("🔒") ? "speakerDm" : ""}`}
              >
                {line}
              </p>
            ))}
          </div>
        ) : null}

        <div className="volumeRow">
          <label htmlFor="volume">
            🔊 受信音量 <strong>{Math.round(volume * 100)}%</strong>
          </label>
          <input
            id="volume"
            type="range"
            min={0.5}
            max={3}
            step={0.1}
            value={volume}
            onChange={(event) => setVolume(parseFloat(event.target.value))}
          />
          <span className="volumeHint">
            100%超で端末の最大音量よりさらに大きくできます（イヤホン推奨・大きすぎ注意）
          </span>
        </div>

        <button
          className={`ptt ${isMicOn ? "pttActive" : ""}`}
          onPointerDown={(event) => {
            if (event.pointerType === "mouse" && event.button !== 0) return;
            event.preventDefault();
            // 指・マウスがボタンの外へずれても、離した操作がこのボタンに届くようにする。
            try {
              event.currentTarget.setPointerCapture(event.pointerId);
            } catch {
              // 捕捉できない環境では、下の pointerleave と画面全体での検知で止める
            }
            startHold("pointer", event.pointerId);
          }}
          onPointerUp={() => stopHold()}
          onPointerLeave={() => stopHold()}
          onPointerCancel={() => stopHold()}
          onLostPointerCapture={() => stopHold()}
          onContextMenu={(event) => event.preventDefault()}
          disabled={!isConnected || !canTalk}
        >
          押して話す
        </button>

        <button
          className={`toggleTransmit ${isMicOn ? "toggleOn" : ""}`}
          onClick={(event) => {
            // Enterキー等のキーボード操作では送信しない(誤送信防止)。
            if (event.detail === 0) return;
            toggleTransmit();
          }}
          disabled={!isConnected || !canTalk}
        >
          {isMicOn
            ? "■ 送信中 — 押すと停止"
            : txStarting
              ? "■ 話す先を切り替え中 — 押すと取り消し"
              : "● タップで送信開始（30秒で自動停止）"}
        </button>

        <p className="hint">
          話し方は2通りです。
          <br />・<strong>押して話す</strong>：大きなボタン（またはキーボードのスペースキー）を押している間だけ送信します（押し続けても{HOLD_MAX_MS / 1000}秒で停止）。
          <br />・<strong>タップで送信</strong>：1回押すと送信開始、もう1回押すと停止します。止め忘れても30秒で自動停止します。
          <br />
          送信中は画面上部に<strong>赤く表示</strong>されます（話す先も表示されます）。別の画面に切り替えると送信は止まります。患者さんのお名前などは話さず、チェア番号などで伝えてください。
        </p>

        <details className="remoteTest">
          <summary>設定・動作確認：ボタン/リモコン</summary>
          <p className="hint">
            キーボードやBluetoothボタンのキーを押すと、送られたキーがここに表示されます。誤送信を防ぐため、送信に使えるのはスペースキー（押している間だけ）です。
          </p>
          <div className="remoteKey">
            最後に押されたキー: <strong>{lastKeyCode ?? "（まだありません）"}</strong>
            {lastKeyCode ? (
              lastKeyCode === "Space" ? (
                <span className="okTag">✅ 押している間だけ送信できます</span>
              ) : (
                <span className="ngTag">このキーは送信操作に割り当てられていません</span>
              )
            ) : null}
          </div>
        </details>
      </section>

      <section className="panel">
        <p className="eyebrow">緊急呼び出し</p>
        <button
          className="emergency"
          onClick={(event) => {
            // キーボード操作(Enter等)の誤作動で緊急呼び出しをしない。
            if (event.detail === 0) return;
            void emergencyAllCall();
          }}
          disabled={!isConnected || isBusy}
        >
          緊急：全員に呼び出す
        </button>
        <p className="hint">
          ※ 押すと、話す先が8秒間だけ「全体」になり、マイクがONになります。「全体」は全員が常に聞いているので、どのルームを聞いているスタッフにも届きます。終わると元の話す先に戻ります（個別に話す設定中だった場合は、全員（ルーム）に戻ります）。
        </p>
      </section>

      <section className="panel gridTwo">
        <div>
          <p className="eyebrow">接続中のメンバー</p>
          <ul className="participants">
            {participants.length === 0 ? (
              <li>接続していません</li>
            ) : (
              participants.map((participant) => (
                <li key={participant.id}>
                  {participant.label}
                  {participant.home ? `（${channelLabel(participant.home, rooms)}）` : null}
                  {participant.isLocal ? <span className="selfTag">（このパソコン）</span> : null}
                </li>
              ))
            )}
          </ul>
        </div>
        <div>
          <p className="eyebrow">お知らせ</p>
          <p className="signal">{lastSignal ?? "お知らせはありません"}</p>
        </div>
      </section>

      <div ref={audioContainerRef} className="audioContainer" aria-hidden="true" />
    </main>
  );
}
