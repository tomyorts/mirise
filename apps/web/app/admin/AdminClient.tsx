"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { IntercomRoom } from "../lib/rooms";

type StaffMember = { name: string; role: string };

type AdminData = {
  rooms: IntercomRoom[];
  staff: StaffMember[];
  storeConfigured: boolean;
};

function parseCsv(text: string): StaffMember[] {
  const lines = text.split(/\r?\n/);
  const staff: StaffMember[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const cells = line.split(",").map((cell) => cell.trim());
    const name = cells[0] ?? "";
    const role = cells[1] ?? "";
    if (!name) continue;
    // ヘッダー行(name,role / 名前,職種 等)はスキップ
    if (["name", "名前", "氏名", "スタッフ名"].includes(name.toLowerCase())) continue;
    staff.push({ name: name.slice(0, 64), role: role.slice(0, 40) });
  }
  return staff;
}

export function AdminClient() {
  const [rooms, setRooms] = useState<IntercomRoom[]>([]);
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [storeConfigured, setStoreConfigured] = useState(true);
  const [csvText, setCsvText] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const response = await fetch("/api/admin");
        const data = (await response.json()) as AdminData & { error?: string };
        if (!response.ok) throw new Error(data.error ?? "読み込みに失敗しました");
        setRooms(data.rooms);
        setStaff(data.staff);
        setStoreConfigured(data.storeConfigured);
      } catch (err) {
        setError(err instanceof Error ? err.message : "読み込みに失敗しました");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const updateRoom = (index: number, patch: Partial<IntercomRoom>) => {
    setRooms((prev) => prev.map((room, i) => (i === index ? { ...room, ...patch } : room)));
  };

  const removeRoom = (index: number) => {
    setRooms((prev) => prev.filter((_, i) => i !== index));
  };

  const addRoom = () => {
    setRooms((prev) => [...prev, { id: `room${prev.length + 1}`, label: "", description: "" }]);
  };

  const importCsv = () => {
    const parsed = parseCsv(csvText);
    if (parsed.length === 0) {
      setError("CSVからスタッフを読み取れませんでした（1行に「名前,職種」）");
      return;
    }
    setStaff(parsed);
    setError(null);
    setMessage(`${parsed.length}名を読み込みました（保存するには下の「保存する」を押してください）`);
  };

  const onFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setCsvText(String(reader.result ?? ""));
    reader.readAsText(file);
  };

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rooms, staff }),
      });
      const data = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error ?? "保存に失敗しました");
      setMessage("保存しました。スタッフのアプリにも反映されます。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存に失敗しました");
    } finally {
      setSaving(false);
    }
  }, [rooms, staff]);

  if (loading) {
    return (
      <main className="shell">
        <p>読み込み中...</p>
      </main>
    );
  }

  return (
    <main className="shell">
      <header className="brandBar">
        <img src="/mirise-logo.png" alt="MIRISE WELLMEDICAL GROUP" className="brandLogo" />
        <Link className="logoutButton" href="/">
          インカムへ戻る
        </Link>
      </header>

      <section className="hero">
        <div>
          <p className="eyebrow">Admin</p>
          <h1>管理画面</h1>
          <p className="lead">ルーム名やスタッフを編集できます。保存すると全員のアプリに反映されます。</p>
        </div>
      </section>

      {!storeConfigured ? (
        <div className="error">
          ⚠️ 保存先データベースが未設定です。編集はできますが「保存」はできません。
          管理者にデータベース（Upstash Redis）の接続設定を依頼してください。
        </div>
      ) : null}

      <section className="panel">
        <div className="roomHeader">
          <div>
            <p className="eyebrow">ルーム</p>
            <h2>ルームの編集</h2>
          </div>
          <button className="secondary adminAddBtn" onClick={addRoom}>
            ＋ ルームを追加
          </button>
        </div>

        {rooms.map((room, index) => (
          <div key={index} className="adminRow">
            <label className="field">
              <span>ルーム名（表示名）</span>
              <input
                value={room.label}
                onChange={(event) => updateRoom(index, { label: event.target.value })}
                placeholder="例: 診療室"
              />
            </label>
            <label className="field">
              <span>説明（任意）</span>
              <input
                value={room.description}
                onChange={(event) => updateRoom(index, { description: event.target.value })}
                placeholder="例: 診療中の通常連携"
              />
            </label>
            <label className="field">
              <span>ID（英数字）</span>
              <input
                value={room.id}
                onChange={(event) => updateRoom(index, { id: event.target.value })}
                placeholder="clinic"
              />
            </label>
            <button className="adminRemoveBtn" onClick={() => removeRoom(index)} title="削除">
              削除
            </button>
          </div>
        ))}
        <p className="hint">
          ※ ID は内部識別子です（英数字・ハイフン）。普段は「ルーム名」だけ変えればOK。
          緊急用の全体ルームは ID を <code>all</code> にしておくと分かりやすいです。
        </p>
      </section>

      <section className="panel">
        <div className="roomHeader">
          <div>
            <p className="eyebrow">Staff</p>
            <h2>スタッフ（CSV取り込み）</h2>
          </div>
          <div className="adminStaffCount">現在 {staff.length} 名</div>
        </div>

        <p className="hint">
          1行に「名前,職種」の形式で貼り付けるか、CSVファイルを選んでください。例:
          <br />
          <code>佐藤,歯科医師</code> / <code>田中,歯科衛生士</code>
        </p>

        <input type="file" accept=".csv,text/csv,text/plain" onChange={onFile} className="adminFile" />

        <textarea
          className="adminTextarea"
          value={csvText}
          onChange={(event) => setCsvText(event.target.value)}
          placeholder={"名前,職種\n佐藤,歯科医師\n田中,歯科衛生士"}
          rows={6}
        />
        <button className="secondary" onClick={importCsv}>
          CSVを読み込む
        </button>

        {staff.length > 0 ? (
          <ul className="participants adminStaffList">
            {staff.slice(0, 50).map((member, i) => (
              <li key={i}>
                {member.name}
                {member.role ? `（${member.role}）` : ""}
              </li>
            ))}
            {staff.length > 50 ? <li>…ほか {staff.length - 50} 名</li> : null}
          </ul>
        ) : null}
      </section>

      <section className="panel">
        <button className="primary" onClick={() => void save()} disabled={saving || !storeConfigured}>
          {saving ? "保存中..." : "保存する"}
        </button>
        {message ? <p className="adminMessage">{message}</p> : null}
        {error ? <p className="error">{error}</p> : null}
      </section>
    </main>
  );
}
