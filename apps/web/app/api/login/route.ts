import { NextRequest, NextResponse } from "next/server";
import {
  createSessionToken,
  safeEqual,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  type Role,
} from "@/app/lib/auth";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { password?: unknown };
    const password = typeof body.password === "string" ? body.password : "";

    const clinicPassword = process.env.CLINIC_PASSWORD;
    const adminPassword = process.env.ADMIN_PASSWORD;
    const secret = process.env.AUTH_SECRET;

    if (!secret || (!clinicPassword && !adminPassword)) {
      return NextResponse.json(
        { error: "サーバー設定が未完了です（環境変数を確認してください）" },
        { status: 500 }
      );
    }
    if (!password) {
      return NextResponse.json({ error: "パスワードを入力してください" }, { status: 400 });
    }

    let role: Role | null = null;
    if (adminPassword && safeEqual(password, adminPassword)) {
      role = "admin";
    } else if (clinicPassword && safeEqual(password, clinicPassword)) {
      role = "staff";
    }

    if (!role) {
      return NextResponse.json({ error: "パスワードが違います" }, { status: 401 });
    }

    const token = await createSessionToken({ role, exp: Date.now() + SESSION_TTL_MS }, secret);
    const response = NextResponse.json({ ok: true, role });
    response.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });
    return response;
  } catch {
    return NextResponse.json({ error: "ログインに失敗しました" }, { status: 500 });
  }
}
