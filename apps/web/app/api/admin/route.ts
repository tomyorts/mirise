import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { SESSION_COOKIE, verifySessionToken } from "@/app/lib/auth";
import { getRooms, getStaff, isStoreConfigured, saveRooms, saveStaff } from "@/app/lib/store";

async function requireAdmin(request: NextRequest) {
  const secret = process.env.AUTH_SECRET;
  const session = secret
    ? await verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value, secret)
    : null;
  return session && session.role === "admin" ? session : null;
}

const roomSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-zA-Z0-9_-]+$/, "ルームIDは英数字・ハイフン・アンダースコアのみ"),
  label: z.string().min(1, "ルーム名を入力してください").max(40),
  description: z.string().max(120).default(""),
});

const staffSchema = z.object({
  name: z.string().min(1).max(64),
  role: z.string().max(40).default(""),
});

const saveSchema = z.object({
  rooms: z.array(roomSchema).min(1, "ルームは1つ以上必要です").max(50),
  staff: z.array(staffSchema).max(2000),
});

export async function GET(request: NextRequest) {
  if (!(await requireAdmin(request))) {
    return NextResponse.json({ error: "管理者のみアクセスできます" }, { status: 403 });
  }
  const [rooms, staff] = await Promise.all([getRooms(), getStaff()]);
  return NextResponse.json({ rooms, staff, storeConfigured: isStoreConfigured() });
}

export async function POST(request: NextRequest) {
  if (!(await requireAdmin(request))) {
    return NextResponse.json({ error: "管理者のみアクセスできます" }, { status: 403 });
  }
  if (!isStoreConfigured()) {
    return NextResponse.json(
      { error: "保存先データベースが未設定です（UPSTASH_REDIS_REST_URL / TOKEN を設定してください）" },
      { status: 503 }
    );
  }
  try {
    const body = await request.json();
    const { rooms, staff } = saveSchema.parse(body);

    // ルームIDの重複チェック
    const ids = new Set<string>();
    for (const room of rooms) {
      if (ids.has(room.id)) {
        return NextResponse.json({ error: `ルームIDが重複しています: ${room.id}` }, { status: 400 });
      }
      ids.add(room.id);
    }

    await Promise.all([saveRooms(rooms), saveStaff(staff)]);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.errors[0]?.message ?? "入力値が不正です" }, { status: 400 });
    }
    return NextResponse.json({ error: "保存に失敗しました" }, { status: 500 });
  }
}
