import { Redis } from "@upstash/redis";
import { INTERCOM_ROOMS, type IntercomRoom } from "./rooms";

// 管理画面で編集するデータ(ルーム・スタッフ)の保存先。
// Upstash Redis(無料)を使う。未設定の場合は初期値で動く(編集・保存は不可)。

export type StaffMember = { name: string; role: string };

const ROOMS_KEY = "mirise:rooms";
const STAFF_KEY = "mirise:staff";

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

export function isStoreConfigured(): boolean {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

export async function getRooms(): Promise<IntercomRoom[]> {
  return (await readRooms()).rooms;
}

// ルーム一覧と、保存先から正しく読めたか(ok=false: 読み込みに失敗し、初期値で代用した)。
// アプリ・PC画面向けの /api/config は、代用した一覧を返さない。一時的な失敗(Upstash の
// タイムアウト等)で初期値を返すと、管理画面で追加したルームが「削除された」と扱われ、
// 各端末の聞くルームから外されてしまうため。
// 未設定(編集できない)・未保存(まだ一度も編集していない)の初期値は、正しい一覧として扱う。
export async function readRooms(): Promise<{ rooms: IntercomRoom[]; ok: boolean }> {
  const redis = getRedis();
  if (!redis) return { rooms: INTERCOM_ROOMS, ok: true };
  try {
    const data = await redis.get<IntercomRoom[]>(ROOMS_KEY);
    if (Array.isArray(data) && data.length > 0) return { rooms: data, ok: true };
    // 保存した値の形が違う(壊れている)時は、読めなかった扱いにする。
    return { rooms: INTERCOM_ROOMS, ok: data === null || Array.isArray(data) };
  } catch {
    return { rooms: INTERCOM_ROOMS, ok: false };
  }
}

export async function saveRooms(rooms: IntercomRoom[]): Promise<void> {
  const redis = getRedis();
  if (!redis) throw new Error("データベースが未設定です");
  await redis.set(ROOMS_KEY, rooms);
}

export async function getStaff(): Promise<StaffMember[]> {
  return (await readStaff()).staff;
}

// スタッフ一覧と、保存先から正しく読めたか(ok=false: 読み込みに失敗し、空で代用した)。
// 管理画面は、代用した一覧のまま保存すると登録済みのスタッフが消えるため、読み込み失敗を区別する。
export async function readStaff(): Promise<{ staff: StaffMember[]; ok: boolean }> {
  const redis = getRedis();
  if (!redis) return { staff: [], ok: true };
  try {
    const data = await redis.get<StaffMember[]>(STAFF_KEY);
    if (Array.isArray(data)) return { staff: data, ok: true };
    return { staff: [], ok: data === null };
  } catch {
    return { staff: [], ok: false };
  }
}

export async function saveStaff(staff: StaffMember[]): Promise<void> {
  const redis = getRedis();
  if (!redis) throw new Error("データベースが未設定です");
  await redis.set(STAFF_KEY, staff);
}
