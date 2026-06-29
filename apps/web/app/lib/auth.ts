// ログインセッションの発行・検証。
// 署名付きCookie(HMAC-SHA256)で「医院スタッフ」か「管理者」かを保持する。
// Web Crypto を使うので Edge(middleware) でも Node(API) でも動く。
// 将来、個別ログインに差し替える場合も、ここの role/payload を拡張するだけで済む。

export const SESSION_COOKIE = "mirise_session";
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12時間

export type Role = "staff" | "admin";
export type Session = { role: Role; exp: number };

const encoder = new TextEncoder();

function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(value: string): Uint8Array {
  const padded = value.length % 4 === 0 ? value : value + "=".repeat(4 - (value.length % 4));
  const b64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// TS 5.x の厳格な型(Uint8Array<ArrayBufferLike>)を crypto.subtle が受け取れるように整える。
function asBufferSource(bytes: Uint8Array): BufferSource {
  return bytes as unknown as BufferSource;
}

async function getKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    asBufferSource(encoder.encode(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export async function createSessionToken(session: Session, secret: string): Promise<string> {
  const payload = bytesToB64url(encoder.encode(JSON.stringify(session)));
  const key = await getKey(secret);
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, asBufferSource(encoder.encode(payload)))
  );
  return `${payload}.${bytesToB64url(signature)}`;
}

export async function verifySessionToken(
  token: string | undefined | null,
  secret: string
): Promise<Session | null> {
  if (!token) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  try {
    const key = await getKey(secret);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      asBufferSource(b64urlToBytes(signature)),
      asBufferSource(encoder.encode(payload))
    );
    if (!valid) return null;
    const session = JSON.parse(new TextDecoder().decode(b64urlToBytes(payload))) as Session;
    if (typeof session.exp !== "number" || session.exp < Date.now()) return null;
    if (session.role !== "staff" && session.role !== "admin") return null;
    return session;
  } catch {
    return null;
  }
}

// タイミング攻撃を避けた固定長比較。
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i += 1) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}
