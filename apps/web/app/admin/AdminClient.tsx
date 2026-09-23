"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BROADCAST_ROOM_ID, INTERCOM_ROOMS, type IntercomRoom } from "../lib/rooms";
import { validateDisplayName } from "../lib/staffIdentity";

type StaffMember = { name: string; role: string };

// 画面で編集中のルーム。locked は緊急呼び出し用の全体ルーム(読み込んだ時点で ID が all の行)。
// 入力途中の ID で判定しないよう、読み込み時に決めた印で扱う。
type RoomRow = IntercomRoom & { rowKey: number; locked: boolean };

// CSVのうち、スタッフ名の規則に合わず読み込めなかった行。
type CsvIssue = { line: number; name: string; reason: string };

const BROADCAST_ID_TAKEN_MESSAGE =
  "「all」は緊急呼び出し用の全体ルームのIDのため、ほかのルームには使えません";

type AdminData = {
  rooms: IntercomRoom[];
  staff: StaffMember[];
  storeConfigured: boolean;
};

function parseCsv(text: string): { staff: StaffMember[]; issues: CsvIssue[] } {
  const lines = text.split(/\r?\n/);
  const staff: StaffMember[] = [];
  const issues: CsvIssue[] = [];
  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) return;
    const cells = line.split(",").map((cell) => cell.trim());
    const name = cells[0] ?? "";
    const role = cells[1] ?? "";
    if (!name) return;
    // ヘッダー行(name,role / 名前,職種 等)はスキップ
    if (["name", "名前", "氏名", "スタッフ名"].includes(name.toLowerCase())) return;
    // インカム画面・iPhoneアプリと同じ規則で確かめる(合わない名前は候補から選んでも接続できない)。
    const reason = validateDisplayName(name);
    if (reason) {
      issues.push({ line: index + 1, name, reason });
      return;
    }
    staff.push({ name, role: role.slice(0, 40) });
  });
  return { staff, issues };
}

export function AdminClient() {
  const [rooms, setRooms] = useState<RoomRow[]>([]);
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [csvIssues, setCsvIssues] = useState<CsvIssue[]>([]);
  const nextRowKeyRef = useRef(1);
  const [storeConfigured, setStoreConfigured] = useState(true);
  const [csvText, setCsvText] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const toRows = useCallback((list: IntercomRoom[]): RoomRow[] => {
    let lockedAssigned = false;
    return list.map((room) => {
      const locked = !lockedAssigned && room.id === BROADCAST_ROOM_ID;
      if (locked) lockedAssigned = true;
      const rowKey = nextRowKeyRef.current;
      nextRowKeyRef.current += 1;
      return { ...room, rowKey, locked };
    });
  }, []);

  // 登録済みのスタッフのうち、スタッフ名の規則に合わない人(以前の画面では登録できた)。
  const invalidStaff = useMemo(
    () =>
      staff.flatMap((member, index) => {
        const reason = validateDisplayName(member.name);
        return reason ? [{ index, name: member.name, reason }] : [];
      }),
    [staff]
  );

  useEffect(() => {
    (async () => {
      try {
        const response = await fetch("/api/admin");
        const data = (await response.json()) as AdminData & { error?: string };
        if (!response.ok) throw new Error(data.error ?? "読み込みに失敗しました");
        // 緊急呼び出しに使う全体ルームが無い場合は戻しておく(保存すると反映)。
        const broadcastRoom = INTERCOM_ROOMS.find((room) => room.id === BROADCAST_ROOM_ID);
        if (broadcastRoom && !data.rooms.some((room) => room.id === BROADCAST_ROOM_ID)) {
          setRooms(toRows([...data.rooms, { ...broadcastRoom }]));
          setMessage(
            "緊急呼び出しに使う全体ルームが見つからなかったため、一覧に戻しました。「保存する」を押すと反映されます。"
          );
        } else {
          setRooms(toRows(data.rooms));
        }
        setStaff(data.staff);
        setStoreConfigured(data.storeConfigured);
      } catch (err) {
        setError(err instanceof Error ? err.message : "読み込みに失敗しました");
      } finally {
        setLoading(false);
      }
    })();
  }, [toRows]);

  const updateRoom = (index: number, patch: Partial<IntercomRoom>) => {
    setRooms((prev) =>
      prev.map((room, i) => {
        if (i !== index) return room;
        // 全体ルーム(緊急呼び出し用)の ID は変更できない。
        // ほかのルームの ID は入力途中の値をそのまま受け付け、「all」との重複は保存時に確かめる。
        if (room.locked && patch.id !== undefined) return { ...room, ...patch, id: room.id };
        return { ...room, ...patch };
      })
    );
  };

  const removeRoom = (index: number) => {
    // 全体ルーム(緊急呼び出し用)は削除できない。
    setRooms((prev) => prev.filter((room, i) => i !== index || room.locked));
  };

  const addRoom = () => {
    const rowKey = nextRowKeyRef.current;
    nextRowKeyRef.current += 1;
    setRooms((prev) => [
      ...prev,
      { id: `room${prev.length + 1}`, label: "", description: "", rowKey, locked: false },
    ]);
  };

  const importCsv = () => {
    const { staff: parsed, issues } = parseCsv(csvText);
    setCsvIssues(issues);
    if (issues.length > 0) {
      setMessage(null);
      setError(
        `スタッフ名として使えない行が${issues.length}件あるため、読み込みませんでした。下の一覧を見てCSVを直し、もう一度「CSVを読み込む」を押してください。`
      );
      return;
    }
    if (parsed.length === 0) {
      setError("CSVからスタッフを読み取れませんでした（1行に「名前,職種」）");
      return;
    }
    setStaff(parsed);
    setError(null);
    setMessage(`${parsed.length}名を読み込みました（保存するには下の「保存する」を押してください）`);
  };

  const removeInvalidStaff = () => {
    const removed = invalidStaff.length;
    setStaff((prev) => prev.filter((member) => validateDisplayName(member.name) === null));
    setError(null);
    setMessage(
      `使えない名前の${removed}名を一覧から外しました（保存するには下の「保存する」を押してください）`
    );
  };

  const onFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setCsvText(String(reader.result ?? ""));
    reader.readAsText(file);
  };

  const save = useCallback(async () => {
    setError(null);
    setMessage(null);
    if (rooms.some((room) => !room.locked && room.id.trim() === BROADCAST_ROOM_ID)) {
      setError(`${BROADCAST_ID_TAKEN_MESSAGE}。別のIDにしてから保存してください。`);
      return;
    }
    if (invalidStaff.length > 0) {
      setError(
        "スタッフ一覧に、スタッフ名として使えない名前があります。CSVを直して読み込み直すか、「使えない名前を一覧から外す」を押してから保存してください。"
      );
      return;
    }
    setSaving(true);
    try {
      const response = await fetch("/api/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rooms: rooms.map(({ id, label, description }) => ({ id, label, description })),
          staff,
        }),
      });
      const data = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error ?? "保存に失敗しました");
      setMessage("保存しました。スタッフのアプリにも反映されます。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存に失敗しました");
    } finally {
      setSaving(false);
    }
  }, [invalidStaff, rooms, staff]);

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
          <div key={room.rowKey} className="adminRow">
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
                readOnly={room.locked}
                title={
                  room.locked ? "緊急呼び出しに使う全体ルームのため、IDは変更できません" : undefined
                }
              />
              {!room.locked && room.id.trim() === BROADCAST_ROOM_ID ? (
                <small className="fieldError">{BROADCAST_ID_TAKEN_MESSAGE}</small>
              ) : null}
            </label>
            {room.locked ? (
              <span className="adminLockedTag" title="緊急呼び出しに使う全体ルームのため削除できません">
                削除不可（緊急用）
              </span>
            ) : (
              <button className="adminRemoveBtn" onClick={() => removeRoom(index)} title="削除">
                削除
              </button>
            )}
          </div>
        ))}
        <p className="hint">
          ※ ID は内部識別子です（英数字・ハイフン）。普段は「ルーム名」だけ変えればOK。
          緊急呼び出しに使う全体ルーム（ID: <code>all</code>）は、ID の変更と削除ができません（表示名は変更できます）。
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
          <br />
          ※ 名前は32文字以内で、使えるのは文字・数字・スペース・「・」「_」「-」「.」です（カッコや「/」は使えません。例:
          「田中（DH）」ではなく「田中 DH」）。
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

        {csvIssues.length > 0 ? (
          <div className="error">
            <p>次の行はスタッフ名として使えないため、読み込みませんでした。</p>
            <ul>
              {csvIssues.slice(0, 20).map((issue) => (
                <li key={issue.line}>
                  {issue.line}行目「{issue.name}」: {issue.reason}
                </li>
              ))}
              {csvIssues.length > 20 ? <li>…ほか {csvIssues.length - 20} 件</li> : null}
            </ul>
          </div>
        ) : null}

        {invalidStaff.length > 0 ? (
          <div className="warning" role="status">
            <p>
              登録済みのスタッフのうち{invalidStaff.length}名は、名前に使えない文字が含まれているか長すぎるため、インカム画面の候補に表示されません（
              {invalidStaff
                .slice(0, 5)
                .map((item) => `「${item.name}」`)
                .join("")}
              {invalidStaff.length > 5 ? "ほか" : ""}
              ）。CSVを直して読み込み直すか、一覧から外してください。
            </p>
            <button className="inlineButton" onClick={removeInvalidStaff}>
              使えない名前を一覧から外す
            </button>
          </div>
        ) : null}

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
