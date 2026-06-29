import { AccessToken } from "livekit-server-sdk";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { safeEqual, SESSION_COOKIE, verifySessionToken } from "@/app/lib/auth";

const tokenRequestSchema = z.object({
  identity: z
    .string()
    .min(2, "スタッフ名は2文字以上で入力してください")
    .max(64, "スタッフ名は64文字以内で入力してください")
    .regex(/^[\p{L}\p{N}_\-. ]+$/u, "スタッフ名に使用できない文字が含まれています"),
  room: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[a-zA-Z0-9_-]+$/, "ルーム名が不正です"),
});

export async function POST(request: NextRequest) {
  try {
    // 認証: ログイン済みセッション、またはネイティブアプリ用のAPIキー。
    // INTERCOM_API_KEY を設定しない場合はログインセッションのみ許可。
    const authSecret = process.env.AUTH_SECRET;
    const session = authSecret
      ? await verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value, authSecret)
      : null;
    const intercomApiKey = process.env.INTERCOM_API_KEY;
    const headerKey = request.headers.get("x-intercom-key");
    const authedByKey = !!intercomApiKey && !!headerKey && safeEqual(headerKey, intercomApiKey);
    if (!session && !authedByKey) {
      return NextResponse.json(
        { error: "認証が必要です。ログインしてください。" },
        { status: 401 }
      );
    }

    const body = await request.json();
    const { identity, room } = tokenRequestSchema.parse(body);

    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    const livekitUrl = process.env.NEXT_PUBLIC_LIVEKIT_URL;

    if (!apiKey || !apiSecret || !livekitUrl) {
      return NextResponse.json(
        { error: "LiveKit環境変数が設定されていません" },
        { status: 500 }
      );
    }

    const token = new AccessToken(apiKey, apiSecret, {
      identity,
      name: identity,
      ttl: "8h",
    });

    token.addGrant({
      room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    return NextResponse.json({
      token: await token.toJwt(),
      url: livekitUrl,
      room,
      identity,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: error.errors[0]?.message ?? "入力値が不正です" },
        { status: 400 }
      );
    }

    console.error("token issue failed", error);
    return NextResponse.json({ error: "トークン発行に失敗しました" }, { status: 500 });
  }
}
