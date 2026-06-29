import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/app/lib/auth";

// 未ログインのアクセスは /login へ送る。管理画面(/admin)は管理者のみ。
export async function middleware(req: NextRequest) {
  const secret = process.env.AUTH_SECRET ?? "";
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = secret ? await verifySessionToken(token, secret) : null;
  const { pathname } = req.nextUrl;

  if (pathname.startsWith("/admin")) {
    if (!session) return redirectTo(req, "/login");
    if (session.role !== "admin") return redirectTo(req, "/login?admin=1");
    return NextResponse.next();
  }

  if (!session) return redirectTo(req, "/login");
  return NextResponse.next();
}

function redirectTo(req: NextRequest, target: string) {
  const [pathname, search] = target.split("?");
  const url = req.nextUrl.clone();
  url.pathname = pathname;
  url.search = search ? `?${search}` : "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/", "/admin", "/admin/:path*"],
};
