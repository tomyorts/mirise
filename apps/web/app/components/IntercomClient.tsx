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
} from "livekit-client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BROADCAST_ROOM_ID, INTERCOM_ROOMS, type IntercomRoom } from "../lib/rooms";
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
};

type ConnectOptions = {
  // 切断後の自動再接続(ユーザー操作なし)のとき true
  auto?: boolean;
};

// タップ送信の自動停止までの時間(iPhoneアプリの AUTO_OFF_MS と同じ30秒)。
const AUTO_OFF_MS = 30_000;
// 緊急呼び出しを押したとき、自動でマイクをONにしておく時間。
const EMERGENCY_TALK_MS = 8_000;
// 「押して話す」を押し続けたときの送信の上限(離したことを検知できなかった場合の保険)。
const HOLD_MAX_MS = 60_000;
// 自動再接続の待ち時間(失敗するたびに次の値へ。最後の値を繰り返す)。
const RECONNECT_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000];

// ブラウザに保存する値(localStorage)。
const DEVICE_TAG_KEY = "mirise.deviceTag";
const LAST_NAME_KEY = "mirise.lastDisplayName";
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

export function IntercomClient() {
  const roomRef = useRef<Room | null>(null);
  const localTrackRef = useRef<LocalAudioTrack | null>(null);
  const audioContainerRef = useRef<HTMLDivElement | null>(null);
  const currentRoomIdRef = useRef("clinic");
  const displayNameRef = useRef("");
  // 最後に接続できたスタッフ名(自動再接続で使う)。
  const lastNameRef = useRef<string | null>(null);
  // 送信状態は state だと更新が遅れるため ref でも持つ。
  const micOnRef = useRef(false);
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
  const connectRef = useRef<
    ((targetRoomId: string, options?: ConnectOptions) => Promise<boolean>) | null
  >(null);
  // 音量ブースト用(Web Audioで100%超の増幅を可能にする)。
  const audioCtxRef = useRef<AudioContext | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const volumeRef = useRef(1.5);
  // 受信中の各音声要素。音量変更時に再生経路を切り替える。
  const remoteAudiosRef = useRef<
    Map<object, { element: HTMLMediaElement; source: MediaStreamAudioSourceNode | null }>
  >(new Map());

  const [displayName, setDisplayName] = useState("");
  const [roomId, setRoomId] = useState("clinic");
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
  const [staffNames, setStaffNames] = useState<string[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  // 受信音量(1.0=100%)。100%超で端末の最大音量よりさらに大きくできる。
  const [volume, setVolume] = useState(1.5);

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
  const selectedRoomLabel = useMemo(
    () => rooms.find((room) => room.id === roomId)?.label ?? roomId,
    [rooms, roomId]
  );

  // 前回のスタッフ名・ルームを復元し、管理画面で編集されたルーム・スタッフを読み込む。
  useEffect(() => {
    let cancelled = false;
    const savedName = readStored(LAST_NAME_KEY);
    const savedRoom = readStored(LAST_ROOM_KEY);
    if (savedName && !validateDisplayName(savedName)) {
      setDisplayName((current) => (current ? current : savedName.trim()));
    }

    (async () => {
      let roomList: IntercomRoom[] = INTERCOM_ROOMS;
      try {
        const response = await fetch("/api/config");
        if (response.ok) {
          const data = (await response.json()) as {
            rooms?: IntercomRoom[];
            staff?: string[];
            role?: string;
          };
          if (Array.isArray(data.rooms) && data.rooms.length > 0) {
            roomList = data.rooms;
            if (!cancelled) setRooms(data.rooms);
          }
          if (!cancelled && Array.isArray(data.staff)) setStaffNames(data.staff);
          if (!cancelled) setIsAdmin(data.role === "admin");
        }
      } catch {
        // 取得失敗時は初期ルームのまま
      }
      if (cancelled || roomRef.current) return;
      // 保存していたルームが今もあればそれを選ぶ。なければ一覧の先頭へ。
      setRoomId((current) => {
        if (savedRoom && roomList.some((room) => room.id === savedRoom)) return savedRoom;
        if (roomList.some((room) => room.id === current)) return current;
        return roomList[0]?.id ?? current;
      });
    })();

    return () => {
      cancelled = true;
    };
  }, []);

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
    };
    const remotes: ParticipantEntry[] = Array.from(room.remoteParticipants.values()).map(
      (participant) => ({
        id: participant.identity,
        label: participant.name || participant.identity,
        isLocal: false,
      })
    );
    setParticipants([local, ...remotes]);
  }, []);

  const clearAutoOff = useCallback(() => {
    if (autoOffTimerRef.current !== null) {
      window.clearTimeout(autoOffTimerRef.current);
      autoOffTimerRef.current = null;
    }
    setAutoOffAt(null);
  }, []);

  const setMicrophone = useCallback(
    async (enabled: boolean) => {
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
    },
    [clearAutoOff]
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
        if (micOnRef.current) {
          void setMicrophone(false);
          setNotice(message);
        }
      }, durationMs);
    },
    [setMicrophone]
  );

  // 送信の残り秒数表示を更新する。
  useEffect(() => {
    if (autoOffAt === null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [autoOffAt]);

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

      localTrack?.stop();
      if (room) void room.disconnect();

      setIsMicOn(false);
      setCanTalk(false);
      setMicWarning(null);
      setAudioBlocked(false);
      setParticipants([]);
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
    [clearAutoOff, endHoldState]
  );

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
    void connectRef.current?.(currentRoomIdRef.current, { auto: true });
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
        "インカムの接続が切れました。通信が戻ると自動で再接続します（再接続後のマイクはOFFです）。"
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

  const connect = useCallback(
    async (targetRoomId: string, options: ConnectOptions = {}): Promise<boolean> => {
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
        const tokenResponse = await requestToken(identity, name, targetRoomId);
        if (userDisconnectedRef.current) return false;

        const thisRoom = new Room({
          adaptiveStream: false,
          dynacast: false,
        });
        room = thisRoom;
        let joined = false;

        roomRef.current = thisRoom;
        currentRoomIdRef.current = targetRoomId;

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
          .on(RoomEvent.ParticipantConnected, () => {
            if (roomRef.current !== thisRoom) return;
            refreshParticipants();
          })
          .on(RoomEvent.ParticipantDisconnected, () => {
            if (roomRef.current !== thisRoom) return;
            refreshParticipants();
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

        await thisRoom.connect(tokenResponse.url, tokenResponse.token);
        if (roomRef.current !== thisRoom) return false;
        joined = true;

        lastNameRef.current = name;
        setRoomId(targetRoomId);
        setConnectionState(thisRoom.state);
        setAudioBlocked(!thisRoom.canPlaybackAudio);
        refreshParticipants();
        writeStored(LAST_NAME_KEY, name);
        writeStored(LAST_ROOM_KEY, targetRoomId);

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
      applyVolume,
      cancelAutoReconnect,
      clearReconnectTimer,
      ensureAudioGraph,
      handleRoomDisconnected,
      refreshParticipants,
      scheduleReconnect,
      setupMicrophone,
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

  // どの方法で送信していても止める(画面を離れたとき等)。
  const stopAllTransmit = useCallback(
    (message?: string) => {
      const wasTransmitting = micOnRef.current || holdActiveRef.current;
      endHoldState();
      clearAutoOff();
      if (micOnRef.current) void setMicrophone(false);
      if (wasTransmitting && message) setNotice(message);
    },
    [clearAutoOff, endHoldState, setMicrophone]
  );

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
      void setMicrophone(true);
    },
    [clearAutoOff, setMicrophone, stopAllTransmit]
  );

  const stopHold = useCallback(() => {
    if (!holdActiveRef.current) return;
    endHoldState();
    void setMicrophone(false);
  }, [endHoldState, setMicrophone]);

  // タップで送信開始/停止。送信は30秒で自動停止する。
  const toggleTransmit = useCallback(() => {
    if (!localTrackRef.current) return;
    endHoldState();
    if (micOnRef.current) {
      void setMicrophone(false);
      return;
    }
    setNotice(null);
    void setMicrophone(true);
    armAutoOff(AUTO_OFF_MS, "30秒たったため、送信を自動で停止しました。");
  }, [armAutoOff, endHoldState, setMicrophone]);

  const switchRoom = useCallback(
    async (targetRoomId: string) => {
      if (targetRoomId === currentRoomIdRef.current && isConnected) return;
      await connect(targetRoomId);
    },
    [connect, isConnected]
  );

  // 緊急呼び出し: このパソコンを「全体」ルームへ移し、通知を送って8秒間マイクをONにする。
  // 届くのは「全体」ルームに接続中の端末だけ(ほかのルームにいる端末には届かない)。
  const emergencyAllCall = useCallback(async () => {
    setNotice(null);
    if (currentRoomIdRef.current !== BROADCAST_ROOM_ID || !roomRef.current) {
      const joined = await connect(BROADCAST_ROOM_ID);
      if (!joined || !roomRef.current) {
        setError(
          "緊急呼び出しを送れませんでした（全体ルームに接続できませんでした）。通信状況を確認して、もう一度押してください。"
        );
        return;
      }
    }

    const sent = await sendSignal({
      type: "emergency",
      from: lastNameRef.current ?? displayNameRef.current.trim(),
      room: BROADCAST_ROOM_ID,
      sentAt: new Date().toISOString(),
      message: "緊急全体呼び出し",
    });

    const hasMic = !!localTrackRef.current;
    // 接続を待っている間に別のウィンドウ・タブへ移っていたら、マイクはONにしない
    // (見ていない画面で送信が始まり、赤い表示にも気づけないため)。
    const screenActive = document.visibilityState === "visible" && document.hasFocus();
    const autoTalk = hasMic && screenActive;
    if (autoTalk) {
      endHoldState();
      void setMicrophone(true);
      armAutoOff(EMERGENCY_TALK_MS, "緊急呼び出しの送信を終了しました（マイクOFF）。");
    }

    if (sent) {
      setError(null);
      setNotice(
        autoTalk
          ? "全体ルームで緊急呼び出しを送りました。8秒間マイクがONになるので、そのまま話してください。届くのは全体ルームに接続中の端末だけです。このパソコンは全体ルームに入ったままです。"
          : hasMic
            ? "全体ルームで緊急呼び出しを送りました。画面が切り替わったため、マイクはONにしていません。声で呼びかける場合は、この画面で「押して話す」を使ってください。届くのは全体ルームに接続中の端末だけです。"
            : "全体ルームで緊急呼び出しを送りました（マイクが使えないため、声は送れません）。届くのは全体ルームに接続中の端末だけです。"
      );
    } else {
      setError(
        autoTalk
          ? "緊急の通知を送れませんでした。全体ルームでマイクが8秒間ONになっているので、声で呼びかけてください。"
          : hasMic
            ? "緊急の通知を送れませんでした。画面が切り替わったため、マイクもONにしていません。この画面で、もう一度押してください。"
            : "緊急の通知を送れませんでした。通信状況を確認して、もう一度押してください。"
      );
    }
  }, [armAutoOff, connect, endHoldState, sendSignal, setMicrophone]);

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
  }, [stopAllTransmit, tryAutoReconnect]);

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
          🔴 送信中（マイクON）—{" "}
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
            受付のパソコンから、スタッフのイヤホンへ声で連絡できます。スタッフ名とルームを選んで「接続する」を押してください。
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

        <label className="field">
          <span>参加ルーム</span>
          <select
            value={roomId}
            onChange={(event) => setRoomId(event.target.value)}
            disabled={isBusy || inSession}
          >
            {rooms.map((room) => (
              <option key={room.id} value={room.id}>
                {room.label}
              </option>
            ))}
          </select>
        </label>

        <div className="actions">
          {inSession ? (
            <button className="secondary" onClick={disconnect}>
              切断する
            </button>
          ) : reconnectPending ? (
            <div className="actionStack">
              <button className="primary" onClick={() => void connect(roomId)} disabled={isBusy}>
                {isBusy ? "再接続しています..." : "今すぐ再接続する"}
              </button>
              <button className="secondary" onClick={disconnect}>
                切断する（自動再接続をやめる）
              </button>
            </div>
          ) : (
            <button className="primary" onClick={() => void connect(roomId)} disabled={isBusy}>
              {isBusy ? "接続しています..." : "接続する"}
            </button>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="roomHeader">
          <div>
            <p className="eyebrow">現在のルーム</p>
            <h2>{selectedRoomLabel}</h2>
          </div>
          <div className={`micPill ${isTransmitting ? "micOn" : ""}`}>
            {inSession && !canTalk
              ? micPending
                ? "マイク準備中"
                : "聞くだけ"
              : isTransmitting
                ? "マイクON"
                : "マイクOFF"}
          </div>
        </div>

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
          {isMicOn ? "■ 送信中 — 押すと停止" : "● タップで送信開始（30秒で自動停止）"}
        </button>

        <p className="hint">
          話し方は2通りです。
          <br />・<strong>押して話す</strong>：大きなボタン（またはキーボードのスペースキー）を押している間だけ送信します（押し続けても{HOLD_MAX_MS / 1000}秒で停止）。
          <br />・<strong>タップで送信</strong>：1回押すと送信開始、もう1回押すと停止します。止め忘れても30秒で自動停止します。
          <br />
          送信中は画面上部に<strong>赤く表示</strong>されます。別の画面に切り替えると送信は止まります。患者さんのお名前などは話さず、チェア番号などで伝えてください。
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
        <p className="eyebrow">ルームの切り替え</p>
        <div className="roomButtons">
          {rooms.map((room) => (
            <button
              key={room.id}
              className={room.id === roomId ? "selected" : ""}
              onClick={() => void switchRoom(room.id)}
              disabled={!isConnected || isBusy}
              title={room.description}
            >
              {room.label}
            </button>
          ))}
        </div>

        <button
          className="emergency"
          onClick={(event) => {
            // キーボード操作(Enter等)の誤作動で緊急呼び出しをしない。
            if (event.detail === 0) return;
            void emergencyAllCall();
          }}
          disabled={!isConnected || isBusy}
        >
          緊急：全体ルームで呼び出す
        </button>
        <p className="hint">
          ※ 押すとこのパソコンが「全体」ルームに移り、8秒間マイクがONになります。声が届くのは、その時点で「全体」ルームに接続している端末だけです（ほかのルームにいるスタッフには届きません）。
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
