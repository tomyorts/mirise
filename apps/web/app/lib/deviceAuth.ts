// iPhoneアプリ用の「端末トークン」。
// 以前はアプリの中に共通の合言葉(EXPO_PUBLIC_INTERCOM_KEY)を埋め込んでいたため、
// アプリが院外に渡ると誰でもトークンAPIを使えてしまった。
// 今後は、アプリの初回起動時に医院の共通パスワードを入力してもらい、その端末専用の
// 署名付きトークン(長期間有効)を発行する。アプリはそれを端末の安全な保存領域
// (iOSのキーチェーン)に保管し、トークンAPIへ Authorization: Bearer で送る。
//
// 失効のさせ方: 医院の共通パスワード(CLINIC_PASSWORD)を変えると、署名鍵が変わるので
// それまでに発行した端末トークンはすべて無効になる(退職者の端末・紛失した端末など)。
// その後は、各スタッフが新しいパスワードでもう一度ログインする。

export const DEVICE_TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1000; // 180日

export type DeviceToken = { typ: "device"; iat: number; exp: number };

const encoder = new TextEncoder();

function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(value: string): Uint8Array {
  const padded = value.length % 4 === 0 ? value : value + "=".repeat(4 - (value.length % 4));
  const bin = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function asBufferSource(bytes: Uint8Array): BufferSource {
  return bytes as unknown as BufferSource;
}

// 署名鍵は「AUTH_SECRET + 医院の共通パスワード」から作る。ログイン用Cookieとは別の鍵に
// なるので、Cookieの値を端末トークンとして使い回すことはできない。
async function getDeviceKey(authSecret: string, clinicPassword: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    asBufferSource(encoder.encode(`device-token:v1:${authSecret}:${clinicPassword}`)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export async function createDeviceToken(authSecret: string, clinicPassword: string): Promise<{
  token: string;
  expiresAt: number;
}> {
  const now = Date.now();
  const body: DeviceToken = { typ: "device", iat: now, exp: now + DEVICE_TOKEN_TTL_MS };
  const payload = bytesToB64url(encoder.encode(JSON.stringify(body)));
  const key = await getDeviceKey(authSecret, clinicPassword);
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, asBufferSource(encoder.encode(payload)))
  );
  return { token: `${payload}.${bytesToB64url(signature)}`, expiresAt: body.exp };
}

export async function verifyDeviceToken(
  token: string | null | undefined,
  authSecret: string,
  clinicPassword: string
): Promise<DeviceToken | null> {
  if (!token) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  try {
    const key = await getDeviceKey(authSecret, clinicPassword);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      asBufferSource(b64urlToBytes(signature)),
      asBufferSource(encoder.encode(payload))
    );
    if (!valid) return null;
    const body = JSON.parse(new TextDecoder().decode(b64urlToBytes(payload))) as DeviceToken;
    if (body.typ !== "device" || typeof body.exp !== "number" || body.exp < Date.now()) return null;
    return body;
  } catch {
    return null;
  }
}

/** Authorization: Bearer <token> からトークン部分を取り出す。 */
export function bearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}
