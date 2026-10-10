// MIRAI LINK の「チャンネル」(論理ルーム)と個別通話の共通ロジック。
//
// 新しいクライアント(iPhone/Androidアプリ・PC画面)は全員、LiveKit の同じルーム
// (SHARED_ROOM)に入り、管理画面の「ルーム」はその中のチャンネルとして扱う。
// 誰が誰の声を聞くかは、各参加者が自分に付ける参加者属性(ATTR)と shouldHear() で決める。
//
// ⚠️ このファイルは Web(apps/web/app/lib/channels.ts)とアプリ(apps/mobile/src/channels.ts)に
// 同じ内容で置いている。片方を変えたら必ずもう片方も同じに変えること
// (判定がずれると、個別の会話が他の人に聞こえる・呼び出しが届かない、といった事故になる)。
// 依存ライブラリなし(純関数と定数のみ)。

/** 新クライアントが共通で入る LiveKit のルーム名。 */
export const SHARED_ROOM = "mirai-link";

/** 全員が必ず聞く「全体」チャンネルのID(管理画面の ID "all" のルーム)。 */
export const BROADCAST_CHANNEL = "all";

/** 「全体」チャンネルの既定の表示名(サーバーから一覧が取れない時用)。 */
export const BROADCAST_LABEL = "全体";

/** 参加者属性のキー(値はすべて文字列)。 */
export const ATTR = {
  /** 属性の形式のバージョン。 */
  version: "ml.v",
  /** 聞くチャンネルIDのカンマ区切り。必ず "all" を含む。 */
  listen: "ml.listen",
  /** 話す先。チャンネルID、または個別通話なら "dm:<相手の identity>"。 */
  talk: "ml.talk",
  /** 自分の主なチャンネルID(参加者一覧での表示用)。 */
  home: "ml.home",
} as const;

/** ATTR.version に入れる値。 */
export const ATTR_VERSION = "1";

/** 個別通話の話す先に付ける接頭辞。 */
export const DM_PREFIX = "dm:";

/** 個別通話から自動で「全員(ルーム)」に戻すまでの時間(最後に個別で話し終えてから)。 */
export const DM_REVERT_MS = 60_000;

/** チャンネルIDに使える文字(管理画面・/api/token のルームIDと同じ規則)。カンマ・コロンは含まない。 */
export const CHANNEL_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

export type ChannelInfo = { id: string; label: string };

export type ParsedTalk = { kind: "channel"; id: string } | { kind: "dm"; target: string };

/** チャンネルIDとして使える文字列か。 */
export function isChannelId(value: unknown): value is string {
  return typeof value === "string" && CHANNEL_ID_PATTERN.test(value);
}

/**
 * 聞くチャンネルの一覧を整える。
 * 使えないIDを除き、重複を除き、"all" を必ず先頭に入れる(それ以外は元の順番のまま)。
 */
export function normalizeListen(ids: readonly string[] | null | undefined): string[] {
  const result: string[] = [BROADCAST_CHANNEL];
  for (const raw of ids ?? []) {
    if (typeof raw !== "string") continue;
    const id = raw.trim();
    if (!isChannelId(id) || result.includes(id)) continue;
    result.push(id);
  }
  return result;
}

/** 属性 "ml.listen"(カンマ区切り)を配列にする。未設定・空でも "all" は必ず含む。 */
export function parseListen(attr?: string | null): string[] {
  return normalizeListen(typeof attr === "string" ? attr.split(",") : []);
}

/** 聞くチャンネルの配列を属性 "ml.listen" の値(カンマ区切り)にする。"all" は必ず含む。 */
export function serializeListen(ids: readonly string[] | null | undefined): string {
  return normalizeListen(ids).join(",");
}

/** 個別通話の話す先の値("dm:<相手の identity>")を作る。 */
export function dmTalk(identity: string): string {
  return `${DM_PREFIX}${identity}`;
}

/**
 * 属性 "ml.talk" を読む。未設定・空文字は「全体」扱い(shouldHear と同じ)。
 * "dm:" で始まれば個別通話(相手が空なら誰にも聞こえない個別として扱う)。
 */
export function parseTalk(attr?: string | null): ParsedTalk {
  const talk = typeof attr === "string" && attr !== "" ? attr : BROADCAST_CHANNEL;
  if (talk.startsWith(DM_PREFIX)) return { kind: "dm", target: talk.slice(DM_PREFIX.length) };
  return { kind: "channel", id: talk };
}

/** 個別通話中なら相手の identity、そうでなければ null。 */
export function dmTargetOf(attr?: string | null): string | null {
  const talk = parseTalk(attr);
  return talk.kind === "dm" ? talk.target : null;
}

/**
 * 聞く判定(Web・アプリ共通)。自分(local)が相手(remote)の声を聞くか。
 * - 相手の話す先が "dm:<自分の identity>" なら聞く(他人あての個別は聞かない)
 * - 相手の話す先が "all" なら聞く
 * - それ以外は、相手の話す先を自分が聞くチャンネルに入れていれば聞く
 * 相手の話す先が未設定(旧形式・再接続直後など)なら「全体」扱い。
 */
export function shouldHear(
  localIdentity: string,
  localListen: readonly string[],
  remoteAttributes: Readonly<Record<string, string>> | null | undefined
): boolean {
  const talk = remoteAttributes?.[ATTR.talk] || BROADCAST_CHANNEL;
  if (talk.startsWith(DM_PREFIX)) {
    return localIdentity !== "" && talk === dmTalk(localIdentity);
  }
  return talk === BROADCAST_CHANNEL || localListen.includes(talk);
}

/** 相手が自分あてに個別で話している(話す先が "dm:<自分>")か。受信表示の切り替え用。 */
export function isDmTo(
  localIdentity: string,
  remoteAttributes: Readonly<Record<string, string>> | null | undefined
): boolean {
  const talk = remoteAttributes?.[ATTR.talk] ?? "";
  return localIdentity !== "" && talk === dmTalk(localIdentity);
}

/**
 * 自分に付ける参加者属性を作る。
 * - listen: "all" を必ず含めて整える
 * - talk: "dm:" で始まればそのまま(相手が空でも全体には広げない。誰にも聞こえないだけ)。
 *   チャンネルIDならそのまま。どちらでもない(空・不正)なら "all"
 * - home: 不正なら "all"
 */
export function buildAttributes(input: {
  listen: readonly string[];
  talk: string;
  home: string;
}): Record<string, string> {
  const talk =
    typeof input.talk === "string" && (input.talk.startsWith(DM_PREFIX) || isChannelId(input.talk))
      ? input.talk
      : BROADCAST_CHANNEL;
  return {
    [ATTR.version]: ATTR_VERSION,
    [ATTR.listen]: serializeListen(input.listen),
    [ATTR.talk]: talk,
    [ATTR.home]: isChannelId(input.home) ? input.home : BROADCAST_CHANNEL,
  };
}

/**
 * 話すチャンネルを決める。希望(preferred)が聞くチャンネルに入っていればそれ、
 * なければ "all" 以外で最初に聞いているチャンネル、それも無ければ "all"。
 * 個別通話("dm:")はここでは扱わない(チャンネルだけを返す)。
 */
export function pickTalkChannel(preferred: string | null | undefined, listen: readonly string[]): string {
  const ids = normalizeListen(listen);
  if (typeof preferred === "string" && isChannelId(preferred) && ids.includes(preferred)) {
    return preferred;
  }
  return ids.find((id) => id !== BROADCAST_CHANNEL) ?? BROADCAST_CHANNEL;
}

/**
 * チャンネル一覧に「全体」が無ければ末尾に足す(管理画面で消されても必ず残す)。
 * ID が不正なもの・重複は除く。
 */
export function withBroadcastChannel<T extends { id: string }>(
  channels: readonly T[] | null | undefined,
  broadcast: T
): T[] {
  const result: T[] = [];
  const seen: string[] = [];
  for (const channel of channels ?? []) {
    if (!channel || !isChannelId(channel.id) || seen.includes(channel.id)) continue;
    seen.push(channel.id);
    result.push(channel);
  }
  if (!seen.includes(BROADCAST_CHANNEL)) result.push(broadcast);
  return result;
}

/** チャンネルIDの表示名。一覧に無ければ ID のまま("all" は「全体」)。 */
export function channelLabel(id: string, channels: readonly ChannelInfo[] | null | undefined): string {
  const found = channels?.find((channel) => channel.id === id);
  if (found?.label) return found.label;
  return id === BROADCAST_CHANNEL ? BROADCAST_LABEL : id;
}

/**
 * 話している人の表示。
 * - 自分あての個別: 「🔒 ○○さんから個別」
 * - それ以外: 「🗣 ○○（チャンネル名）」
 * 聞こえない人(他チャンネル・他人あての個別)は、呼ぶ前に shouldHear で除くこと。
 */
export function speakerLabel(
  name: string,
  localIdentity: string,
  remoteAttributes: Readonly<Record<string, string>> | null | undefined,
  channels: readonly ChannelInfo[] | null | undefined
): string {
  if (isDmTo(localIdentity, remoteAttributes)) return `🔒 ${name}さんから個別`;
  const talk = parseTalk(remoteAttributes?.[ATTR.talk]);
  const channelId = talk.kind === "channel" ? talk.id : BROADCAST_CHANNEL;
  return `🗣 ${name}（${channelLabel(channelId, channels)}）`;
}

/** 個別通話の残り時間(ミリ秒、0以上)。since は最後に個別で話し終えた時刻(未発話なら選んだ時刻)。 */
export function dmRemainingMs(since: number, now: number): number {
  return Math.max(0, since + DM_REVERT_MS - now);
}
