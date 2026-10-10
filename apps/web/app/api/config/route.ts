import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/app/lib/auth";
import { withBroadcastChannel } from "@/app/lib/channels";
import { bearerToken, verifyDeviceToken } from "@/app/lib/deviceAuth";
import { BROADCAST_ROOM_ID, INTERCOM_ROOMS } from "@/app/lib/rooms";
import { getStaff, readRooms } from "@/app/lib/store";

// 現在のルーム一覧とスタッフ名を返す。
// - PC画面(ログインセッション): インカム画面がこれを読んで、管理画面での変更を即反映する。
// - iPhone/Androidアプリ(端末トークン、Authorization: Bearer): 起動時・画面に戻った時に読み、
//   管理画面で追加・名前変更したルームをアプリにも出す。検証は /api/token と同じ。
// 保存先(Upstash)を一時的に読めない時は 503(code=rooms_unavailable)を返し、初期値は返さない。
export async function GET(request: NextRequest) {
  const authSecret = process.env.AUTH_SECRET;
  const clinicPassword = process.env.CLINIC_PASSWORD;
  const session = authSecret
    ? await verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value, authSecret)
    : null;
  const deviceTokenValue = session ? null : bearerToken(request.headers.get("authorization"));
  const device =
    deviceTokenValue && authSecret && clinicPassword
      ? await verifyDeviceToken(deviceTokenValue, authSecret, clinicPassword)
      : null;
  if (!session && !device) {
    // 端末トークンが無効(期限切れ・医院のパスワード変更)なら、アプリに再ログインを促す。
    return NextResponse.json(
      deviceTokenValue
        ? {
            error: "ログインの有効期限が切れました。医院のパスワードでもう一度ログインしてください。",
            code: "device_token_invalid",
          }
        : { error: "認証が必要です" },
      { status: 401 }
    );
  }

  const [roomsResult, staff] = await Promise.all([readRooms(), getStaff()]);
  if (!roomsResult.ok) {
    // 保存先を読めなかった(一時的な障害)。初期値を返すと、管理画面で追加したルームが
    // 「削除された」と扱われて各端末の聞くルームから外れるため、エラーにする
    // (アプリ・PC画面は保存済みの一覧のまま動き続ける)。
    return NextResponse.json(
      {
        error: "ルーム一覧を一時的に読み込めません。しばらくしてから、もう一度お試しください。",
        code: "rooms_unavailable",
      },
      { status: 503 }
    );
  }
  const storedRooms = roomsResult.rooms;
  // 「全体」(ID "all")は全員が必ず聞くチャンネル・緊急呼び出し先なので、
  // 管理画面で消されていても既定の内容で必ず返す。
  const broadcastRoom = INTERCOM_ROOMS.find((room) => room.id === BROADCAST_ROOM_ID) ?? {
    id: BROADCAST_ROOM_ID,
    label: "全体",
    description: "全体呼び出し・緊急連絡",
  };
  const rooms = withBroadcastChannel(storedRooms, broadcastRoom);
  return NextResponse.json({
    rooms,
    staff: staff.map((member) => member.name),
    // 権限(管理者かどうか)はPC画面のログインセッションにだけ返す。
    ...(session ? { role: session.role } : {}),
  });
}
