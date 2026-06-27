"use client";

import {
  ConnectionState,
  LocalAudioTrack,
  RemoteParticipant,
  Room,
  RoomEvent,
  Track,
  createLocalAudioTrack,
} from "livekit-client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getRoomLabel, INTERCOM_ROOMS } from "../lib/rooms";

type TokenResponse = {
  token: string;
  url: string;
  room: string;
  identity: string;
};

type TalkMode = "ptt" | "open";

type SignalMessage = {
  type: "emergency" | "notice";
  from: string;
  room: string;
  sentAt: string;
  message?: string;
};

const DEFAULT_IDENTITY = "staff";

async function requestToken(identity: string, room: string): Promise<TokenResponse> {
  const response = await fetch("/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity, room }),
  });

  const data = (await response.json()) as Partial<TokenResponse> & { error?: string };

  if (!response.ok || !data.token || !data.url) {
    throw new Error(data.error ?? "トークン発行に失敗しました");
  }

  return data as TokenResponse;
}

function connectionLabel(state: ConnectionState): string {
  switch (state) {
    case ConnectionState.Connected:
      return "接続中";
    case ConnectionState.Connecting:
      return "接続処理中";
    case ConnectionState.Reconnecting:
      return "再接続中";
    case ConnectionState.Disconnected:
      return "未接続";
    default:
      return String(state);
  }
}

export function IntercomClient() {
  const roomRef = useRef<Room | null>(null);
  const localTrackRef = useRef<LocalAudioTrack | null>(null);
  const audioContainerRef = useRef<HTMLDivElement | null>(null);
  const currentRoomIdRef = useRef("clinic");
  const pttActiveRef = useRef(false);

  const [identity, setIdentity] = useState(DEFAULT_IDENTITY);
  const [roomId, setRoomId] = useState("clinic");
  const [connectionState, setConnectionState] = useState<ConnectionState>(ConnectionState.Disconnected);
  const [talkMode, setTalkMode] = useState<TalkMode>("ptt");
  const [isMicOn, setIsMicOn] = useState(false);
  const [participants, setParticipants] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastSignal, setLastSignal] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const isConnected = connectionState === ConnectionState.Connected;
  const selectedRoomLabel = useMemo(() => getRoomLabel(roomId), [roomId]);

  const refreshParticipants = useCallback(() => {
    const room = roomRef.current;
    if (!room) {
      setParticipants([]);
      return;
    }

    const remoteNames = Array.from(room.remoteParticipants.values()).map(
      (participant) => participant.name || participant.identity
    );
    setParticipants([room.localParticipant.name || room.localParticipant.identity, ...remoteNames]);
  }, []);

  const setMicrophone = useCallback(async (enabled: boolean) => {
    const localTrack = localTrackRef.current;
    if (!localTrack) return;

    if (enabled) {
      await localTrack.unmute();
    } else {
      await localTrack.mute();
    }
    setIsMicOn(enabled);
  }, []);

  const disconnect = useCallback(() => {
    const room = roomRef.current;
    const localTrack = localTrackRef.current;

    localTrack?.stop();
    room?.disconnect();

    localTrackRef.current = null;
    roomRef.current = null;
    setIsMicOn(false);
    setParticipants([]);
    setConnectionState(ConnectionState.Disconnected);

    if (audioContainerRef.current) {
      audioContainerRef.current.innerHTML = "";
    }
  }, []);

  const connect = useCallback(
    async (targetRoomId = roomId) => {
      setError(null);
      setIsBusy(true);

      try {
        disconnect();

        const trimmedIdentity = identity.trim() || DEFAULT_IDENTITY;
        const tokenResponse = await requestToken(trimmedIdentity, targetRoomId);
        const room = new Room({
          adaptiveStream: false,
          dynacast: false,
        });

        roomRef.current = room;
        currentRoomIdRef.current = targetRoomId;

        room
          .on(RoomEvent.ConnectionStateChanged, (state: ConnectionState) => {
            setConnectionState(state);
          })
          .on(RoomEvent.ParticipantConnected, refreshParticipants)
          .on(RoomEvent.ParticipantDisconnected, refreshParticipants)
          .on(RoomEvent.TrackSubscribed, (track) => {
            if (track.kind !== Track.Kind.Audio) return;
            const element = track.attach();
            element.autoplay = true;
            element.dataset.livekitTrack = "remote-audio";
            audioContainerRef.current?.appendChild(element);
          })
          .on(RoomEvent.TrackUnsubscribed, (track) => {
            track.detach().forEach((element) => element.remove());
          })
          .on(
            RoomEvent.DataReceived,
            (payload: Uint8Array, participant?: RemoteParticipant, _kind?: unknown, topic?: string) => {
              if (topic !== "intercom.signal") return;
              try {
                const decoded = new TextDecoder().decode(payload);
                const signal = JSON.parse(decoded) as SignalMessage;
                const from = participant?.name || participant?.identity || signal.from;
                setLastSignal(`${from}: ${signal.message ?? signal.type}`);
              } catch {
                setLastSignal("シグナルを受信しました");
              }
            }
          );

        await room.connect(tokenResponse.url, tokenResponse.token);

        const localAudioTrack = await createLocalAudioTrack({
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        });

        await room.localParticipant.publishTrack(localAudioTrack, {
          source: Track.Source.Microphone,
        });

        localTrackRef.current = localAudioTrack;

        if (talkMode === "open") {
          await localAudioTrack.unmute();
          setIsMicOn(true);
        } else {
          await localAudioTrack.mute();
          setIsMicOn(false);
        }

        setRoomId(targetRoomId);
        refreshParticipants();
      } catch (connectError) {
        console.error(connectError);
        disconnect();
        setError(connectError instanceof Error ? connectError.message : "接続に失敗しました");
      } finally {
        setIsBusy(false);
      }
    },
    [disconnect, identity, refreshParticipants, roomId, talkMode]
  );

  const sendSignal = useCallback((message: SignalMessage) => {
    const room = roomRef.current;
    if (!room || room.state !== ConnectionState.Connected) return;

    const payload = new TextEncoder().encode(JSON.stringify(message));
    room.localParticipant.publishData(payload, {
      reliable: true,
      topic: "intercom.signal",
    });
  }, []);

  const startTalking = useCallback(async () => {
    if (talkMode !== "ptt") return;
    pttActiveRef.current = true;
    await setMicrophone(true);
  }, [setMicrophone, talkMode]);

  const stopTalking = useCallback(async () => {
    if (talkMode !== "ptt") return;
    pttActiveRef.current = false;
    await setMicrophone(false);
  }, [setMicrophone, talkMode]);

  const changeTalkMode = useCallback(
    async (mode: TalkMode) => {
      setTalkMode(mode);
      await setMicrophone(mode === "open");
    },
    [setMicrophone]
  );

  const switchRoom = useCallback(
    async (targetRoomId: string) => {
      if (targetRoomId === currentRoomIdRef.current && isConnected) return;
      await connect(targetRoomId);
    },
    [connect, isConnected]
  );

  const emergencyAllCall = useCallback(async () => {
    if (currentRoomIdRef.current !== "all") {
      await connect("all");
    }

    setLastSignal("緊急: 全体ルームに切り替えました");
    sendSignal({
      type: "emergency",
      from: identity.trim() || DEFAULT_IDENTITY,
      room: "all",
      sentAt: new Date().toISOString(),
      message: "緊急全体呼び出し",
    });

    if (talkMode === "ptt") {
      await setMicrophone(true);
      window.setTimeout(() => {
        if (!pttActiveRef.current) {
          void setMicrophone(false);
        }
      }, 8000);
    }
  }, [connect, identity, sendSignal, setMicrophone, talkMode]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat) return;
      if (!isConnected || talkMode !== "ptt") return;
      event.preventDefault();
      void startTalking();
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      if (!isConnected || talkMode !== "ptt") return;
      event.preventDefault();
      void stopTalking();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [isConnected, startTalking, stopTalking, talkMode]);

  useEffect(() => {
    return () => disconnect();
  }, [disconnect]);

  return (
    <main className="shell">
      <header className="brandBar">
        <img src="/mirise-logo.png" alt="MIRISE WELLMEDICAL GROUP" className="brandLogo" />
      </header>

      <section className="hero">
        <div>
          <p className="eyebrow">MIRISE Intercom MVP</p>
          <h1>院内Wi-Fi音声インカム</h1>
          <p className="lead">
            スマホとBluetoothイヤホンで、受付・診療室・オペ・滅菌を音声でつなぐ検証用MVPです。
          </p>
        </div>
        <div className={`status ${isConnected ? "statusConnected" : ""}`}>
          {connectionLabel(connectionState)}
        </div>
      </section>

      <section className="panel gridTwo">
        <label className="field">
          <span>スタッフ名</span>
          <input
            value={identity}
            onChange={(event) => setIdentity(event.target.value)}
            placeholder="例: Dr.Sato / DH Tanaka"
            disabled={isBusy || isConnected}
          />
        </label>

        <label className="field">
          <span>参加ルーム</span>
          <select
            value={roomId}
            onChange={(event) => setRoomId(event.target.value)}
            disabled={isBusy || isConnected}
          >
            {INTERCOM_ROOMS.map((room) => (
              <option key={room.id} value={room.id}>
                {room.label}
              </option>
            ))}
          </select>
        </label>

        <div className="actions">
          {!isConnected ? (
            <button className="primary" onClick={() => void connect(roomId)} disabled={isBusy}>
              {isBusy ? "接続中..." : "接続する"}
            </button>
          ) : (
            <button className="secondary" onClick={disconnect}>
              切断する
            </button>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="roomHeader">
          <div>
            <p className="eyebrow">Current Room</p>
            <h2>{selectedRoomLabel}</h2>
          </div>
          <div className={`micPill ${isMicOn ? "micOn" : ""}`}>{isMicOn ? "マイクON" : "マイクOFF"}</div>
        </div>

        <div className="modeSwitch">
          <button
            className={talkMode === "ptt" ? "selected" : ""}
            onClick={() => void changeTalkMode("ptt")}
            disabled={!isConnected}
          >
            Push to Talk
          </button>
          <button
            className={talkMode === "open" ? "selected" : ""}
            onClick={() => void changeTalkMode("open")}
            disabled={!isConnected}
          >
            常時ON
          </button>
        </div>

        <button
          className={`ptt ${isMicOn ? "pttActive" : ""}`}
          onMouseDown={() => void startTalking()}
          onMouseUp={() => void stopTalking()}
          onMouseLeave={() => void stopTalking()}
          onTouchStart={(event) => {
            event.preventDefault();
            void startTalking();
          }}
          onTouchEnd={(event) => {
            event.preventDefault();
            void stopTalking();
          }}
          disabled={!isConnected || talkMode !== "ptt"}
        >
          押して話す
        </button>

        <p className="hint">PCではスペースキー長押しでもPTTできます。診療中は患者情報を言わず、チェア番号やセット名で運用してください。</p>
      </section>

      <section className="panel">
        <div className="roomButtons">
          {INTERCOM_ROOMS.map((room) => (
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

        <button className="emergency" onClick={() => void emergencyAllCall()} disabled={!isConnected || isBusy}>
          緊急 全体呼び出し
        </button>
      </section>

      <section className="panel gridTwo">
        <div>
          <p className="eyebrow">Participants</p>
          <ul className="participants">
            {participants.length === 0 ? (
              <li>未参加</li>
            ) : (
              participants.map((participant) => <li key={participant}>{participant}</li>)
            )}
          </ul>
        </div>
        <div>
          <p className="eyebrow">Signals</p>
          <p className="signal">{lastSignal ?? "シグナルなし"}</p>
        </div>
      </section>

      {error ? <p className="error">{error}</p> : null}
      <div ref={audioContainerRef} className="audioContainer" aria-hidden="true" />
    </main>
  );
}
