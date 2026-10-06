import { NextRequest, NextResponse } from "next/server";
import { safeEqual } from "@/app/lib/auth";
import { createDeviceToken } from "@/app/lib/deviceAuth";

// iPhoneアプリの初回ログイン。医院の共通パスワード(または管理者パスワード)が合えば、
// その端末専用のトークン(180日有効)を返す。アプリはキーチェーンに保存して使う。
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as { password?: unknown };
    const password = typeof body.password === "string" ? body.password : "";

    const clinicPassword = process.env.CLINIC_PASSWORD;
    const adminPassword = process.env.ADMIN_PASSWORD;
    const secret = process.env.AUTH_SECRET;
    if (!secret || !clinicPassword) {
      return NextResponse.json(
        { error: "サーバー設定が未完了です（環境変数を確認してください）" },
        { status: 500 }
      );
    }
    if (!password) {
      return NextResponse.json({ error: "医院のパスワードを入力してください" }, { status: 400 });
    }
    const ok =
      safeEqual(password, clinicPassword) || (!!adminPassword && safeEqual(password, adminPassword));
    if (!ok) {
      return NextResponse.json({ error: "パスワードが違います" }, { status: 401 });
    }

    // 署名は常に医院の共通パスワードを鍵にする(管理者パスワードで入っても同じ)。
    // 共通パスワードを変えれば、全端末のトークンがまとめて無効になる。
    const { token, expiresAt } = await createDeviceToken(secret, clinicPassword);
    return NextResponse.json({ token, expiresAt });
  } catch {
    return NextResponse.json({ error: "ログインに失敗しました" }, { status: 500 });
  }
}
