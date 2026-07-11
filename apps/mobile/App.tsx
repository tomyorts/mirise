import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { AudioSession, registerGlobals } from "@livekit/react-native";
import { Room, RoomEvent } from "livekit-client";
import { useRemotePtt } from "./hooks/useRemotePtt";
import PttChannel from "./modules/ptt-channel";

// 止め忘れ防止: トグルでONにしたら一定時間で自動OFF(ミリ秒)。
const AUTO_OFF_MS = 30_000;

// LiveKit(WebRTC)を使う前に一度だけグローバル初期化が必要。
registerGlobals();

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
  // トグル判定を最新値で行うための参照 + 自動OFFタイマー。
  const micOnRef = useRef(false);
  const autoOffRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    micOnRef.current = micOn;
  }, [micOn]);

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
    try {
      await AudioSession.stopAudioSession();
    } catch {
      // noop
    }
    setConnected(false);
    setMicOn(false);
  }, [clearAutoOff]);

  const connect = useCallback(async () => {
    setError(null);
    setConnecting(true);
    try {
      await cleanup();

      // バックグラウンド(ポケット/画面OFF)でも音声を維持するための設定。
      // playAndRecord + voiceChat + Bluetooth許可。app.json の UIBackgroundModes:["audio"] と併用。
      // configureAudio は接続前に呼ぶ必要がある。
      // 古いビルドでAPIが無くても接続自体は続行できるよう try/catch で保護。
      try {
        await AudioSession.configureAudio({
          // イヤホン非接続時は受話口(プライベート)へ。スピーカーで患者に聞こえるのを防ぐ。
          ios: { defaultOutput: "earpiece" },
        });
        await AudioSession.setAppleAudioConfiguration({
          audioCategory: "playAndRecord",
          audioMode: "voiceChat",
          audioCategoryOptions: ["allowBluetooth", "allowBluetoothA2DP"],
        });
      } catch (audioConfigError) {
        console.warn("audio session config skipped", audioConfigError);
      }
      await AudioSession.startAudioSession();

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

      const room = new Room();
      roomRef.current = room;
      room.on(RoomEvent.Disconnected, () => {
        setConnected(false);
        setMicOn(false);
      });

      await room.connect(data.url, data.token);
      // PTT前提: 接続直後はマイクOFF(送信しない)。
      await room.localParticipant.setMicrophoneEnabled(false);
      setConnected(true);
      setMicOn(false);
    } catch (e) {
      await cleanup();
      setError(e instanceof Error ? e.message : "接続に失敗しました");
    } finally {
      setConnecting(false);
    }
  }, [cleanup, identity, roomId]);

  const setMic = useCallback(
    async (on: boolean) => {
      const room = roomRef.current;
      if (!room) return;
      try {
        await room.localParticipant.setMicrophoneEnabled(on);
        setMicOn(on);
        if (!on) clearAutoOff();
      } catch (e) {
        setError(e instanceof Error ? e.message : "マイク操作に失敗しました");
      }
    },
    [clearAutoOff],
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

  // Phase B: PushToTalkフレームワークのイベントを購読。
  // システム(ロック画面/ポケット)からの送信開始/停止で LiveKit のマイクをON/OFF。
  useEffect(() => {
    if (!PttChannel) return;
    const subs = [
      PttChannel.addListener("onJoin", () => setPttJoined(true)),
      PttChannel.addListener("onLeave", () => setPttJoined(false)),
      PttChannel.addListener("onBeginTransmitting", () => void setMic(true)),
      PttChannel.addListener("onEndTransmitting", () => void setMic(false)),
      PttChannel.addListener("onError", () => {}),
    ];
    return () => subs.forEach((s) => s?.remove());
  }, [setMic]);

  // PTTチャンネルに参加/退出。
  const joinPtt = useCallback(async () => {
    if (!PttChannel) {
      setError("この端末はPushToTalk未対応です(iOS16以上＋開発ビルドが必要)");
      return;
    }
    setPttBusy(true);
    try {
      await PttChannel.join("MIRISE Intercom");
    } catch (e) {
      setError(e instanceof Error ? e.message : "PTT参加に失敗しました");
    } finally {
      setPttBusy(false);
    }
  }, []);

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
              🎧 イヤホンの再生/停止ボタン、または 🔘 BLEリモコン（ページめくり器・指輪型など、
              Enter/矢印/ページ送りキーを送るもの）でも送信ON/OFF（トグル）できます。
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
            </Text>
            <Text style={styles.hint}>
              画面OFF・ポケットの中でも話せるかの検証です。まず「PTTを有効化」→ 下の「話す」を
              押しながら発声。動いたら、画面ロック中やロック画面のトーク表示からも試してください。
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
