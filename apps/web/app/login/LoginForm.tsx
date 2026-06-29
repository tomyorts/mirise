"use client";

import { useState } from "react";

export function LoginForm() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const response = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || !data.ok) {
        throw new Error(data.error ?? "ログインに失敗しました");
      }
      // middlewareが新しいCookieを見られるよう、完全リロードで遷移する。
      window.location.href = "/";
    } catch (err) {
      setError(err instanceof Error ? err.message : "ログインに失敗しました");
      setBusy(false);
    }
  };

  return (
    <main className="loginShell">
      <form className="loginCard" onSubmit={submit}>
        <img src="/mirise-logo.png" alt="MIRISE WELLMEDICAL GROUP" className="loginLogo" />
        <h1 className="loginTitle">院内音声インカム</h1>
        <p className="loginLead">医院のパスワードでログインしてください。</p>

        <input
          className="loginInput"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="パスワード"
          autoFocus
          autoComplete="current-password"
        />

        <button className="loginButton" type="submit" disabled={busy}>
          {busy ? "確認中..." : "ログイン"}
        </button>

        {error ? <p className="loginError">{error}</p> : null}
      </form>
    </main>
  );
}
