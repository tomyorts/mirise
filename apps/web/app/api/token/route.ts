import { AccessToken, TrackSource } from "livekit-server-sdk";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { safeEqual, SESSION_COOKIE, verifySessionToken } from "@/app/lib/auth";
import {
  DISPLAY_NAME_MAX_LENGTH,
  DISPLAY_NAME_MESSAGES,
  DISPLAY_NAME_PATTERN,
} from "@/app/lib/staffIdentity";

// 表示名(画面に出る名前)。日本語名を想定して緩めに受け付ける。
// 全角スペース・「・」・1文字の姓(林・森など)もOK。規則はクライアントと共通(app/lib/staffIdentity.ts)。
const displayNameSchema = z
  .string({ invalid_type_error: "スタッフ名の形式が正しくありません" })
  .trim()
  .min(1, DISPLAY_NAME_MESSAGES.required)
  .max(DISPLAY_NAME_MAX_LENGTH, DISPLAY_NAME_MESSAGES.tooLong)
  .regex(DISPLAY_NAME_PATTERN, DISPLAY_NAME_MESSAGES.invalidChars);

const tokenRequestSchema = z.object(
  {
    // identity は端末ごとに一意な内部ID(例: 佐藤-a1b2c3)。従来どおり厳密にチェックする。
    identity: z
      .string({
        required_error: "スタッフ名を入力してください",
        invalid_type_error: "スタッフ名の形式が正しくありません",
      })
      .min(2, "スタッフ名は2文字以上で入力してください")
      .max(64, "スタッフ名は64文字以内で入力してください")
      .regex(/^[\p{L}\p{N}_\-. ]+$/u, "スタッフ名に使用できない文字が含まれています"),
    // name は省略可(旧バージョンのアプリは送らない)。空文字も「省略」とみなす。
    name: z.preprocess(
      (value) =>
        value === null || (typeof value === "string" && value.trim() === "") ? undefined : value,
      displayNameSchema.optional()
    ),
    room: z
      .string({
        required_error: "ルームを選択してください",
        invalid_type_error: "ルーム名が不正です",
      })
      .min(2, "ルーム名が不正です")
      .max(64, "ルーム名が不正です")
      .regex(/^[a-zA-Z0-9_-]+$/, "ルーム名が不正です"),
  },
  {
    required_error: "リクエストの形式が正しくありません",
    invalid_type_error: "リクエストの形式が正しくありません",
  }
);

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

    // 本文がJSONとして読めない場合は 400(サーバーエラー扱いにしない)。
    const body: unknown = await request.json().catch(() => undefined);
    if (body === undefined || body === null || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json(
        { error: "リクエストの形式が正しくありません" },
        { status: 400 }
      );
    }

    const parsed = tokenRequestSchema.parse(body);
    const { identity, room } = parsed;
    const name = parsed.name ?? identity;

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
      name,
      ttl: "8h",
    });

    token.addGrant({
      room,
      roomJoin: true,
      canPublish: true,
      // 音声インカムなので、送信できるのはマイク音声だけに限定する(カメラ・画面共有は不可)。
      canPublishSources: [TrackSource.MICROPHONE],
      canSubscribe: true,
      canPublishData: true,
    });

    return NextResponse.json({
      token: await token.toJwt(),
      url: livekitUrl,
      room,
      identity,
      name,
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
