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
  const redis = getRedis();
  if (!redis) return INTERCOM_ROOMS;
  try {
    const data = await redis.get<IntercomRoom[]>(ROOMS_KEY);
    return Array.isArray(data) && data.length > 0 ? data : INTERCOM_ROOMS;
  } catch {
    return INTERCOM_ROOMS;
  }
}

export async function saveRooms(rooms: IntercomRoom[]): Promise<void> {
  const redis = getRedis();
  if (!redis) throw new Error("データベースが未設定です");
  await redis.set(ROOMS_KEY, rooms);
}

export async function getStaff(): Promise<StaffMember[]> {
  const redis = getRedis();
  if (!redis) return [];
  try {
    const data = await redis.get<StaffMember[]>(STAFF_KEY);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export async function saveStaff(staff: StaffMember[]): Promise<void> {
  const redis = getRedis();
  if (!redis) throw new Error("データベースが未設定です");
  await redis.set(STAFF_KEY, staff);
}
