import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/app/lib/auth";
import { getRooms, getStaff } from "@/app/lib/store";

// ログイン済みユーザー向け: 現在のルーム一覧とスタッフ名を返す。
// インカム画面がこれを読んで、管理画面での変更を即反映する。
export async function GET(request: NextRequest) {
  const secret = process.env.AUTH_SECRET;
  const session = secret
    ? await verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value, secret)
    : null;
  if (!session) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 });
  }

  const [rooms, staff] = await Promise.all([getRooms(), getStaff()]);
  return NextResponse.json({
    rooms,
    staff: staff.map((member) => member.name),
    role: session.role,
  });
}
