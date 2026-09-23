import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { SESSION_COOKIE, verifySessionToken } from "@/app/lib/auth";
import {
  DISPLAY_NAME_MAX_LENGTH,
  DISPLAY_NAME_MESSAGES,
  DISPLAY_NAME_PATTERN,
} from "@/app/lib/staffIdentity";
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
    .min(1, "ルームIDを入力してください")
    .max(32, "ルームIDは32文字以内で入力してください")
    .regex(/^[a-zA-Z0-9_-]+$/, "ルームIDは英数字・ハイフン・アンダースコアのみ"),
  label: z.string().min(1, "ルーム名を入力してください").max(40, "ルーム名は40文字以内で入力してください"),
  description: z.string().max(120, "説明は120文字以内で入力してください").default(""),
});

// スタッフ名は、インカム画面・iPhoneアプリ・/api/token と同じ規則(app/lib/staffIdentity.ts)で検査する。
// 規則に合わない名前を登録すると、候補から選んでも接続できないため。
const staffSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, DISPLAY_NAME_MESSAGES.required)
    .max(DISPLAY_NAME_MAX_LENGTH, DISPLAY_NAME_MESSAGES.tooLong)
    .regex(DISPLAY_NAME_PATTERN, DISPLAY_NAME_MESSAGES.invalidChars),
  role: z.string().max(40, "職種は40文字以内で入力してください").default(""),
});

const saveSchema = z.object({
  rooms: z.array(roomSchema).min(1, "ルームは1つ以上必要です").max(50, "ルームは50個までです"),
  staff: z.array(staffSchema).max(2000, "スタッフは2000名までです"),
});

// どの行の問題かが分かるように、エラーメッセージに行番号を付ける。
function describeZodError(error: z.ZodError): string {
  const issue = error.errors[0];
  if (!issue) return "入力値が不正です";
  const [section, index] = issue.path;
  if (section === "staff" && typeof index === "number") {
    return `スタッフ一覧の${index + 1}人目: ${issue.message}`;
  }
  if (section === "rooms" && typeof index === "number") {
    return `ルーム一覧の${index + 1}つ目: ${issue.message}`;
  }
  return issue.message;
}

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
      return NextResponse.json({ error: describeZodError(error) }, { status: 400 });
    }
    return NextResponse.json({ error: "保存に失敗しました" }, { status: 500 });
  }
}
