# 11 MIRISE Hub Operations 技術監査（実装前調査）

本書は、既存リポジトリ `tomyorts/mirise` に **MIRISE Hub Operations**（総務・社長室・IT・施設運営・採用・広報・イベントの指示／進捗／成果物／承認／引継ぎの一元管理）を追加するための技術監査結果です。

**本書の段階ではコード変更を行っていません。** 記載のスキーマ・API・画面はすべて提案であり、実装は作業計画（§10）に従って段階的に着手します。

---

## 0. 最重要の前提確認

調査の結果、**「miriseHub」という名称のコードベースは本リポジトリに存在しません。**
現存するのは **MIRISE Intercom MVP**（院内音声インカム）です。

- `apps/web` … Next.js 製のインカム Web アプリ（Vercel `mirisevoicelink` で本番稼働中）
- `apps/mobile` … Expo/React Native 製の iOS インカムアプリ（PTT・BLE ボタン対応）
- 業務管理（タスク・承認・引継ぎ）に相当する機能は**一切存在しません**

したがって本件は「既存 Hub への機能追加」ではなく、**インカム基盤の上に業務管理アプリを新規構築する**作業になります。再利用できるのは認証の土台・デプロイ経路・UI 資産までで、データモデルは新規です。以降はこの前提で記述します。

---

## 1. 現状アーキテクチャ

### 1-1. リポジトリ構成

```
mirise/
├─ apps/web/        Next.js 15 App Router（本番: Vercel）
├─ apps/mobile/     Expo 54 / React Native 0.81（iOS 中心、EAS Build）
├─ infra/livekit/   ローカル検証用 LiveKit の docker compose
├─ docs/            00〜10 の設計・運用ドキュメント
├─ prompts/         生成AI向けプロンプト
└─ scripts/         LiveKit 鍵生成スクリプト
```

monorepo 風ですが **npm workspaces / turborepo 等のワークスペース定義はなく**、`apps/web` と `apps/mobile` がそれぞれ独立した npm プロジェクトです。ルートに `package.json` はありません。

### 1-2. 調査項目 1: フレームワーク・言語・主要ライブラリ

| 領域 | 内容 |
|---|---|
| Web | Next.js `^15`（App Router）、React `^19`、TypeScript `^5.8`（`strict: true`） |
| モバイル | Expo `~54`、React Native `0.81.5`、Swift 製カスタムネイティブモジュール 3 種（`ble-button` / `ptt-channel` / `remote-ptt`、いずれも iOS のみ） |
| 通信 | `livekit-client` / `livekit-server-sdk` / `@livekit/react-native` |
| バリデーション | `zod ^3.25`（API ルートで使用） |
| データ | `@upstash/redis ^1.38` |
| スタイル | **素の CSS 1 ファイル**（`app/globals.css` 524 行、手書きクラス名）。CSS フレームワーク・UI ライブラリ・デザインシステムなし |
| 状態管理 | React `useState` のみ。データフェッチライブラリ（SWR / TanStack Query）なし |
| 認証ライブラリ | **なし**（自前 HMAC 実装） |
| ORM | **なし** |
| テスト | **なし** |

### 1-3. 調査項目 2: 認証方式

`apps/web/app/lib/auth.ts` に自前実装。

- **共通パスワード方式**。個人アカウントは存在しない
  - `CLINIC_PASSWORD` に一致 → `role: "staff"`
  - `ADMIN_PASSWORD` に一致 → `role: "admin"`
- 認証成功で `{ role, exp }` を JSON 化 → base64url → **HMAC-SHA256（`AUTH_SECRET`）で署名**した文字列を Cookie `mirise_session` に格納
- Cookie 属性: `httpOnly`、`sameSite: lax`、`secure`（本番のみ）、有効期限 **12 時間**
- Web Crypto API を使うため Edge Middleware でも Node ランタイムでも検証可能
- パスワード比較は `safeEqual()`（長さ一致前提の定数時間比較）
- ネイティブアプリ向けの抜け道として `x-intercom-key` ヘッダー（`INTERCOM_API_KEY`）でも `/api/token` を許可

**構造的な限界（Operations にそのまま持ち込めない点）**

| # | 事実 | Operations への影響 |
|---|---|---|
| A1 | セッションに**ユーザー識別子が存在しない**（`role` と `exp` のみ） | 「主担当者 1 名」「変更履歴」「監査ログ」が原理的に成立しない。個人アカウント化が**前提条件** |
| A2 | セッション失効機構がない。検証は HMAC と `exp` のみ | 退職者の即時無効化ができない |
| A3 | `CLINIC_PASSWORD` を変更しても**既存セッションは無効化されない**（署名鍵は `AUTH_SECRET`）。docs/09 §2 の「退職者が出たら共通パスワードを変更」という運用は、最大 12 時間有効なセッションを残す | 人事情報を扱う画面では許容できない |
| A4 | `/api/login` に**レート制限・ロックアウトがない** | ブルートフォース耐性なし |
| A5 | ロールは `staff` / `admin` の 2 値のみ | 部署・機微区分の権限分離ができない |

### 1-4. 調査項目 3: ユーザー・部署・役割・権限構造

- **ユーザー**: エンティティとして存在しない。Redis 上の `mirise:staff` に `{ name: string, role: string }` の配列があるのみ。`role` は自由記述（「歯科医師」等の職種文字列）で、権限とは無関係。ID もメールアドレスもない
- **部署**: 概念が存在しない
- **施設（医院）**: 概念が存在しない。ルーム（受付・診療室・オペ・滅菌・全体）が事実上の唯一の区分軸
- **役割/権限**: `Role = "staff" | "admin"` の 2 値のみ。認可判定は 3 箇所に散在
  - `middleware.ts` … `/admin` 配下を `role === "admin"` に制限
  - `app/api/admin/route.ts` の `requireAdmin()`
  - `app/api/config/route.ts` / `app/api/token/route.ts` … ログイン済みかどうかのみ

**middleware の適用範囲に注意**：`matcher: ["/", "/admin", "/admin/:path*"]` であり **`/api/*` は対象外**です。API 保護は各ルートハンドラの自前チェックに依存しています。Operations の API を追加する際、この規約を知らずに実装すると**無防備なエンドポイントが生まれます**（§9 R3）。

### 1-5. 調査項目 4: データベースと ORM

- **RDB なし。ORM なし。マイグレーション基盤なし。**
- 唯一の永続化は **Upstash Redis（REST）** の 2 キー
  - `mirise:rooms` … `IntercomRoom[]` を JSON 丸ごと `SET`
  - `mirise:staff` … `StaffMember[]` を JSON 丸ごと `SET`
- 読み取りは失敗時に既定値へフォールバック（`getRooms()` は `INTERCOM_ROOMS` 定数へ）
- 書き込みは**全置換**。楽観ロック・バージョン・更新者・更新時刻を持たない（管理画面の CSV 取り込みも全置換仕様）
- Redis 未設定でもアプリは初期値で動作する設計

→ 業務データ（リレーション・履歴・権限行制御・集計）を載せる器としては不適格です。**Operations には別途 RDB が必須**です。

### 1-6. 調査項目 5: カレンダー・ファイル・通知の既存機能

| 機能 | 現状 |
|---|---|
| カレンダー | **なし**。日時の概念自体がコードに存在しない（セッション `exp` を除く） |
| ファイル | **なし**。ストレージ連携なし。管理画面の CSV は `FileReader` でブラウザ内読み取りするのみでアップロードしない |
| 通知 | **なし**。Web Push / メール / Slack / LINE いずれも未接続。`console.error` のみ |
| リアルタイム | LiveKit のデータチャネル（`canPublishData: true`）が有効。音声用途だが、将来の即時通知に転用余地あり |

### 1-7. 調査項目 6: モバイル / PWA 対応

- **PWA 非対応**。`manifest.json` なし、Service Worker なし、`public/` は `mirise-logo.png` のみ、`layout.tsx` に viewport / theme-color / apple-mobile-web-app 系メタなし
- レスポンシブ対応は CSS の `width: min(980px, calc(100% - 32px))` 程度。モバイル最適化された入力体系ではない
- ネイティブアプリ（Expo）は存在するが**インカム専用**。画面は `App.tsx` 1 枚で、ナビゲーション（React Navigation / expo-router）を持たない
- iOS のみ実装のネイティブモジュールがあるため、Android 版ネイティブは未成熟

→ 「スマホで 30 秒以内に進捗更新」の要件は、**Web の PWA 化で満たすのが最短**（§10 Phase 3）。Expo アプリへの機能追加は BLE/PTT の既存コードと干渉するため推奨しません。

### 1-8. 調査項目 7: 監査ログ

**存在しません。** 認証成否、管理画面での設定変更、トークン発行のいずれも記録されていません（`console.error` によるエラー出力のみ、Vercel のランタイムログに残るが構造化されておらず検索・保全に耐えない）。

さらに §1-3 A1 の通り**行為者を特定する情報がない**ため、現状の認証のままでは監査ログを実装しても意味を持ちません。

### 1-9. 調査項目 8: 現在のデプロイ方法

```
GitHub tomyorts/mirise (main) ──自動──▶ Vercel プロジェクト mirisevoicelink
                                          └─ https://mirisevoicelink.vercel.app
外部依存: LiveKit Cloud（音声SFU）/ Upstash Redis 東京（設定保存）
```

- `apps/web/vercel.json` の `ignoreCommand: "git diff --quiet HEAD^ HEAD ."` により、`apps/web` に差分がないコミットではビルドをスキップ
- **CI が存在しない**（`.github/` ディレクトリなし）。lint も型チェックもテストも自動実行されない。品質ゲートは Vercel のビルド成功のみ
- ロールバックは Vercel Deployments の Promote 操作（docs/09 §5）
- 環境変数は Vercel の Environment Variables で管理（9 変数、docs/09 §4 に一覧）
- モバイルは EAS Build（`eas.json` に development / preview / production の 3 プロファイル）
- インフラは Vercel(Hobby) / LiveKit Cloud(Free) / Upstash(Free) の**無料枠**で運用中 → Operations 追加時は Vercel Pro 相当への移行検討が必要（後述 §10）

### 1-10. 調査項目 9: テスト環境

**存在しません。** テストランナー（Jest / Vitest）、E2E（Playwright / Cypress）、テストファイル、CI いずれも未整備。`.gitignore` に `coverage` の記載があるだけです。

### 1-11. 調査項目 10: Operations を最小侵襲で追加する方法（結論）

**同一 Next.js アプリ内に Route Group で分離し、データ層とデプロイ判定は完全に別系統にする**方針を推奨します。

```
apps/web/
├─ app/
│  ├─ (intercom)/          ← 既存。ファイル移動はせず現状維持でも可
│  │   page.tsx  admin/  login/
│  ├─ ops/                 ← 追加。Operations の全画面
│  ├─ api/
│  │   ├─ token|config|admin|login|logout   ← 既存。触らない
│  │   └─ ops/             ← 追加。Operations の全 API
│  └─ lib/
│      ├─ auth.ts store.ts rooms.ts         ← 既存。auth.ts のみ後方互換で拡張
│      └─ ops/             ← 追加。db / schema / permissions / events / reports
└─ middleware.ts           ← matcher に /ops を追加（1 行）
```

最小侵襲を成立させる 5 つの規約：

1. **既存ファイルの変更は 3 つだけ** — `middleware.ts` の matcher に `/ops/:path*` 追加、`lib/auth.ts` にセッション payload の後方互換拡張（`sub` / `ver` を optional 追加）、`package.json` への依存追加。既存インカムのロジックには触れない
2. **データ層を分離** — Operations は Postgres。Upstash Redis は既存用途のまま残す（Operations 側ではレート制限・キャッシュに限定利用）
3. **フィーチャーフラグ** — `OPS_ENABLED` 環境変数。false の場合 `/ops` と `/api/ops` は 404。本番投入前でも main にマージできる
4. **セッションの二重運用** — 既存の共通パスワードセッション（`role` のみ）は `/ops` では**無効**として扱い、個人アカウントのセッション（`sub` を持つ）のみ通す。インカム側は従来通り動作する
5. **デプロイ判定** — `vercel.json` の `ignoreCommand` は `apps/web` 単位のままで問題ないが、Operations 用に DB マイグレーションを走らせるビルドステップを追加する

代替案（別 Vercel プロジェクト / 別リポジトリ）は、セッション Cookie のドメイン共有と運用者の管理対象増加のコストが上回るため非推奨です。

---

## 2. 再利用できる既存機能

| 資産 | 場所 | 再利用の仕方 | 改修量 |
|---|---|---|---|
| HMAC セッション実装 | `lib/auth.ts` | `Session` 型に `sub`（ユーザーID）・`ver`（失効世代）を追加。`createSessionToken` / `verifySessionToken` の骨格はそのまま流用可 | 小 |
| 定数時間比較 | `lib/auth.ts` `safeEqual()` | API キー・トークン比較にそのまま利用 | なし |
| Middleware による経路保護 | `middleware.ts` | matcher に `/ops/:path*` を足すだけ。redirect ヘルパもそのまま | 極小 |
| zod による入力検証パターン | `api/token`・`api/admin` | Operations の全 API で同じ書式を踏襲（`ZodError` → 400、日本語メッセージ） | なし（規約流用） |
| Upstash Redis クライアント | `lib/store.ts` | ログイン試行のレート制限、通知の重複抑止、レポートのキャッシュに転用 | 小 |
| スタッフ CSV 取り込み UI | `admin/AdminClient.tsx` | ユーザー初期投入（氏名・部署・メール）の画面としてほぼ流用可能 | 中 |
| デザイン言語・ロゴ | `globals.css`・`public/mirise-logo.png` | `.shell` `.panel` `.hero` `.field` `.primary` 等のクラス命名と配色をそのまま継承し、Operations 画面の見た目を統一 | なし |
| 日本語 UI 文言の作法 | 全画面 | 「〜してください」調、エラー文の粒度をそのまま踏襲 | なし |
| Vercel デプロイ経路 | `vercel.json`・Vercel 設定 | 同一プロジェクトに相乗り。環境変数管理・ロールバック手順（docs/09 §5）をそのまま適用 | なし |
| LiveKit データチャネル | `api/token` の `canPublishData` | Incident 発生時にインカム全体ルームへ即時通知する将来拡張の土台 | 大（将来） |
| 運用ドキュメント体系 | `docs/` | Operations の運用手順を docs/12 以降に同じ体裁で追加 | なし |

**再利用できないもの**：`lib/store.ts` の全置換保存モデル、`StaffMember` 型、`Role` 2 値、`INTERCOM_ROOMS`。これらは Operations のデータモデルとは無関係です。

---

## 3. 追加 DB スキーマ

### 3-1. 技術選定

| 項目 | 推奨 | 理由 |
|---|---|---|
| DB | **Postgres（Neon または Supabase、東京リージョン）** | リレーション・部分索引・`CHECK` 制約・JSONB・行レベルセキュリティが必要。Vercel からの接続実績が厚い |
| ORM | **Drizzle ORM** | Vercel の serverless 環境でコールドスタートが軽い。SQL に近く `CHECK` 制約や部分索引を宣言しやすい。TypeScript 型が自動導出され、既存の zod ベース検証と相性が良い（Prisma でも可だが、必須制約を DB 側に置く本設計とは Drizzle の方が噛み合う） |
| マイグレーション | `drizzle-kit` によるファイルベース。CI でチェック、デプロイ前に適用 | |
| ファイル実体 | **Vercel Blob** または S3 互換。DB にはメタデータのみ | |

### 3-2. 中核の設計判断

1. **Work Item は 1 テーブル + 型判別 + 型別詳細**
   10 種の Work Item（Task / Decision / Review / Incident / Routine Checklist / Project Milestone / Handover / System・Account / Recruitment / Procurement）は、共通項（担当者・期限・完了条件・状態・履歴・承認）が 8 割を占めます。共通部分を `work_item` に置き、型固有の属性は `work_item_detail`（JSONB、型ごとに zod スキーマで検証）に分離します。10 テーブルに分けると横断一覧・横断レポート・権限判定が破綻します。
2. **必須設計を DB の `CHECK` 制約で強制する**
   アプリ層のバリデーションだけでは、バッチ投入や将来の別クライアントで抜けます。「主担当 1 名」「期限」「完了条件」「対応中なら次アクションと次回更新日」は列の `NOT NULL` と `CHECK` で担保します。
3. **履歴は追記専用イベント列**
   全変更を `work_item_event` に追記し、日報・週報・月報はこのイベント列からの**決定論的な集計**で生成します（生成 AI は使いません。§9 R11）。
4. **機微区分は行の属性 + 参照テーブル分離の併用**
   医療情報・人事情報は `sensitivity` 列で行に区分を持たせ、加えて Recruitment（人事）の個人詳細は別テーブル `recruitment_private` に隔離して、通常経路の `SELECT *` では絶対に混ざらないようにします。
5. **秘密情報はスキーマ上に置き場所を作らない**
   System/Account は**パスワード列を持ちません**。持つのは `secret_ref`（パスワードマネージャの項目 ID / URL）だけです。

### 3-3. スキーマ（DDL スケッチ）

```sql
-- ============ 組織 ============
CREATE TABLE facility (            -- 医院・拠点
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE,          -- 'oiso' / 'minamiaoyama'
  name          text NOT NULL,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE department (          -- 総務/社長室/IT/施設運営/採用/広報/イベント
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE,          -- 'general_affairs' 等
  name          text NOT NULL,
  parent_id     uuid REFERENCES department(id),
  is_active     boolean NOT NULL DEFAULT true
);

CREATE TABLE app_user (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext NOT NULL UNIQUE,
  display_name  text NOT NULL,
  facility_id   uuid REFERENCES facility(id),
  department_id uuid REFERENCES department(id),
  status        text NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','suspended','retired')),
  session_ver   integer NOT NULL DEFAULT 1,     -- 失効世代。+1 で全セッション無効化
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- 役割はスコープ付きで複数持てる（部署マネージャは自部署のみ、等）
CREATE TABLE user_role (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  role          text NOT NULL CHECK (role IN
                  ('system_admin','executive','dept_manager','staff',
                   'hr_officer','medical_officer','auditor','viewer')),
  scope_department_id uuid REFERENCES department(id),   -- NULL = 全社
  scope_facility_id   uuid REFERENCES facility(id),
  granted_by    uuid REFERENCES app_user(id),
  granted_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role, scope_department_id, scope_facility_id)
);

-- ============ Work Item 本体 ============
CREATE TABLE work_item (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq           bigserial UNIQUE,               -- 人が読む番号 OPS-000123
  type          text NOT NULL CHECK (type IN
                  ('task','decision','review','incident','routine_checklist',
                   'project_milestone','handover','system_account',
                   'recruitment','procurement')),
  title         text NOT NULL CHECK (length(btrim(title)) > 0),
  body          text NOT NULL DEFAULT '',

  -- 必須設計①: 主担当者は必ず 1 名（複数担当を許さない）
  assignee_id   uuid NOT NULL REFERENCES app_user(id),
  requester_id  uuid NOT NULL REFERENCES app_user(id),
  department_id uuid NOT NULL REFERENCES department(id),
  facility_id   uuid REFERENCES facility(id),

  -- 必須設計②: 期限と完了条件は必須
  due_at        timestamptz NOT NULL,
  done_criteria text NOT NULL CHECK (length(btrim(done_criteria)) > 0),

  status        text NOT NULL DEFAULT 'open' CHECK (status IN
                  ('open','in_progress','waiting_decision','waiting_other',
                   'done','cancelled')),
  priority      text NOT NULL DEFAULT 'normal'
                CHECK (priority IN ('urgent','high','normal','low')),

  -- 必須設計③: 対応中なら次の行動と次回更新日が必須
  next_action   text,
  next_update_at timestamptz,
  CONSTRAINT progress_requires_next CHECK (
    status NOT IN ('in_progress','waiting_other')
    OR (next_action IS NOT NULL AND length(btrim(next_action)) > 0
        AND next_update_at IS NOT NULL)
  ),

  -- 必須設計⑨: 機微区分（医療 / 人事 / 一般）
  sensitivity   text NOT NULL DEFAULT 'general'
                CHECK (sensitivity IN ('general','medical','hr')),

  completed_at  timestamptz,
  CONSTRAINT done_requires_completed_at CHECK (
    (status = 'done') = (completed_at IS NOT NULL)
  ),

  version       integer NOT NULL DEFAULT 1,     -- 楽観ロック
  created_by    uuid NOT NULL REFERENCES app_user(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX work_item_my_open_idx
  ON work_item (assignee_id, status, due_at)
  WHERE status NOT IN ('done','cancelled');
CREATE INDEX work_item_stale_idx
  ON work_item (next_update_at)
  WHERE status IN ('in_progress','waiting_other');
CREATE INDEX work_item_dept_idx ON work_item (department_id, status, due_at);
CREATE INDEX work_item_inbox_idx
  ON work_item (created_at) WHERE status = 'waiting_decision';

-- 型固有の属性（zod で型別に検証してから格納）
CREATE TABLE work_item_detail (
  work_item_id  uuid PRIMARY KEY REFERENCES work_item(id) ON DELETE CASCADE,
  data          jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- 共同作業者・閲覧者（主担当は work_item.assignee_id のみ。ここには入れない）
CREATE TABLE work_item_watcher (
  work_item_id  uuid NOT NULL REFERENCES work_item(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('collaborator','watcher')),
  PRIMARY KEY (work_item_id, user_id)
);

CREATE TABLE work_item_link (      -- 親子・関連（Milestone ⊃ Task 等）
  from_id uuid NOT NULL REFERENCES work_item(id) ON DELETE CASCADE,
  to_id   uuid NOT NULL REFERENCES work_item(id) ON DELETE CASCADE,
  kind    text NOT NULL CHECK (kind IN ('parent','blocks','relates','duplicates')),
  PRIMARY KEY (from_id, to_id, kind),
  CHECK (from_id <> to_id)
);

-- ============ 履歴（追記専用）============
-- 必須設計⑤: 全変更履歴を保存。UPDATE/DELETE はアプリ用 DB ロールから剥奪する。
CREATE TABLE work_item_event (
  id            bigserial PRIMARY KEY,
  work_item_id  uuid NOT NULL REFERENCES work_item(id) ON DELETE RESTRICT,
  actor_id      uuid NOT NULL REFERENCES app_user(id),
  kind          text NOT NULL CHECK (kind IN
                  ('created','progress_update','status_changed','assignee_changed',
                   'due_changed','comment','attachment_added','attachment_removed',
                   'approval_requested','approved','rejected','handed_over',
                   'checklist_run','reopened','cancelled')),
  from_value    jsonb,
  to_value      jsonb,
  comment       text,
  occurred_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX work_item_event_report_idx ON work_item_event (occurred_at, actor_id);
CREATE INDEX work_item_event_item_idx  ON work_item_event (work_item_id, occurred_at);

-- ============ 承認 / 経営判断 Inbox ============
-- 必須設計④: 経営判断待ちを専用 Inbox に出す（status='waiting_decision' と連動）
CREATE TABLE approval_request (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_item_id  uuid NOT NULL REFERENCES work_item(id) ON DELETE CASCADE,
  requested_by  uuid NOT NULL REFERENCES app_user(id),
  approver_id   uuid NOT NULL REFERENCES app_user(id),  -- 承認者も 1 名に固定
  question      text NOT NULL,                          -- 何を判断してほしいか
  options       jsonb NOT NULL DEFAULT '[]'::jsonb,     -- 選択肢と各案の影響
  recommended   text,                                   -- 起案者の推奨案
  deadline_at   timestamptz NOT NULL,
  decision      text CHECK (decision IN ('approved','rejected','deferred')),
  decision_note text,
  decided_at    timestamptz,
  decided_by    uuid REFERENCES app_user(id),
  CONSTRAINT decision_consistency CHECK (
    (decision IS NULL) = (decided_at IS NULL)
    AND (decision IS NULL) = (decided_by IS NULL)
  )
);
CREATE INDEX approval_pending_idx
  ON approval_request (approver_id, deadline_at) WHERE decision IS NULL;

-- ============ 定型チェックリスト ============
CREATE TABLE checklist_template (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  department_id uuid NOT NULL REFERENCES department(id),
  facility_id uuid REFERENCES facility(id),
  cadence     text NOT NULL CHECK (cadence IN ('daily','weekly','monthly','quarterly','yearly')),
  items       jsonb NOT NULL,        -- [{ key, label, requires_note, requires_photo }]
  default_assignee_id uuid REFERENCES app_user(id),
  is_active   boolean NOT NULL DEFAULT true
);

CREATE TABLE checklist_run (        -- 実施 1 回分。work_item と 1:1 で紐づく
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id  uuid NOT NULL REFERENCES checklist_template(id),
  work_item_id uuid NOT NULL UNIQUE REFERENCES work_item(id) ON DELETE CASCADE,
  period_key   text NOT NULL,        -- '2026-07-27' / '2026-W30' / '2026-07'
  results      jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (template_id, period_key)   -- 同一期間の二重生成を防ぐ
);

-- ============ 引継ぎ ============
CREATE TABLE handover (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_item_id  uuid NOT NULL UNIQUE REFERENCES work_item(id) ON DELETE CASCADE,
  from_user_id  uuid NOT NULL REFERENCES app_user(id),
  to_user_id    uuid NOT NULL REFERENCES app_user(id),
  effective_at  timestamptz NOT NULL,
  scope_note    text NOT NULL,
  accepted_at   timestamptz,          -- 受け手の受領確認
  accepted_note text,
  CHECK (from_user_id <> to_user_id)
);

-- ============ システム / アカウント台帳 ============
-- 必須設計⑥: パスワード・秘密情報の列を作らない。参照先だけを持つ。
CREATE TABLE system_account (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_item_id  uuid NOT NULL UNIQUE REFERENCES work_item(id) ON DELETE CASCADE,
  system_name   text NOT NULL,
  vendor        text,
  account_label text NOT NULL,        -- 'admin@…' 等の識別名（パスワードは不可）
  secret_ref    text,                 -- パスワードマネージャの項目 URL/ID のみ
  owner_user_id uuid NOT NULL REFERENCES app_user(id),
  mfa_status    text CHECK (mfa_status IN ('enabled','disabled','not_supported')),
  renewal_at    date,
  monthly_cost_jpy integer
);
COMMENT ON COLUMN system_account.secret_ref IS
  'パスワードマネージャ項目への参照のみ。パスワード・APIキー等の値を入れてはならない。';

-- ============ 採用（人事機微。通常経路から隔離）============
CREATE TABLE recruitment_private (
  work_item_id  uuid PRIMARY KEY REFERENCES work_item(id) ON DELETE CASCADE,
  candidate_ref text NOT NULL,        -- 候補者は仮名/ID 参照。実名は原則ここのみ
  stage         text NOT NULL CHECK (stage IN
                  ('applied','screening','interview_1','interview_2','offer','joined','declined')),
  source        text,
  notes         text,                 -- 事実記録のみ。人物評価の自動生成は行わない
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ============ 調達 ============
CREATE TABLE procurement (
  work_item_id  uuid PRIMARY KEY REFERENCES work_item(id) ON DELETE CASCADE,
  vendor        text,
  amount_jpy    bigint,
  budget_code   text,
  quote_ref     text,
  contract_start date,
  contract_end   date
);

-- ============ 添付 ============
CREATE TABLE attachment (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_item_id  uuid NOT NULL REFERENCES work_item(id) ON DELETE CASCADE,
  storage_key   text NOT NULL,        -- Blob/S3 のキー。公開 URL は保存しない
  file_name     text NOT NULL,
  content_type  text NOT NULL,
  byte_size     bigint NOT NULL,
  sha256        text NOT NULL,
  sensitivity   text NOT NULL DEFAULT 'general'
                CHECK (sensitivity IN ('general','medical','hr')),
  uploaded_by   uuid NOT NULL REFERENCES app_user(id),
  uploaded_at   timestamptz NOT NULL DEFAULT now()
);

-- ============ 通知 ============
CREATE TABLE notification (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  work_item_id uuid REFERENCES work_item(id) ON DELETE CASCADE,
  kind         text NOT NULL,         -- 'assigned' / 'due_soon' / 'update_overdue' / 'approval'
  title        text NOT NULL,         -- 本文に機微情報を載せない（§9 R10）
  created_at   timestamptz NOT NULL DEFAULT now(),
  read_at      timestamptz
);
CREATE INDEX notification_unread_idx ON notification (user_id, created_at) WHERE read_at IS NULL;

CREATE TABLE push_subscription (     -- Web Push（PWA）
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  endpoint     text NOT NULL UNIQUE,
  p256dh       text NOT NULL,
  auth         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ============ レポート ============
CREATE TABLE report_snapshot (       -- 日報/週報/月報の確定版（イベント列から生成）
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         text NOT NULL CHECK (kind IN ('daily','weekly','monthly')),
  period_key   text NOT NULL,
  scope_kind   text NOT NULL CHECK (scope_kind IN ('user','department','company')),
  scope_id     uuid,
  payload      jsonb NOT NULL,        -- 集計結果（決定論的生成）
  generated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, period_key, scope_kind, scope_id)
);

-- ============ 監査ログ（全操作。追記専用）============
CREATE TABLE audit_log (
  id           bigserial PRIMARY KEY,
  actor_id     uuid REFERENCES app_user(id),
  action       text NOT NULL,          -- 'login' / 'read_sensitive' / 'export' / 'role_granted' …
  target_type  text,
  target_id    text,
  sensitivity  text,
  ip_hash      text,                   -- 生 IP は保存しない
  user_agent   text,
  result       text NOT NULL CHECK (result IN ('success','denied','error')),
  detail       jsonb,
  prev_hash    text,                   -- 改ざん検知用ハッシュチェーン
  row_hash     text,
  occurred_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_id, occurred_at);
CREATE INDEX audit_log_action_idx ON audit_log (action, occurred_at);
```

**追記専用の担保（マイグレーション最終段で実行）**

```sql
REVOKE UPDATE, DELETE, TRUNCATE ON work_item_event, audit_log FROM app_runtime;
GRANT  INSERT, SELECT                ON work_item_event, audit_log TO app_runtime;
```

`work_item` の `UPDATE` に対しては、変更前後を `work_item_event` に自動記録する `AFTER UPDATE` トリガを併設し、アプリ側の書き漏れがあっても履歴が欠落しない構成にします。

### 3-4. 必須設計との対応表

| 必須設計 | 実現手段 |
|---|---|
| 1 件につき主担当者 1 名 | `work_item.assignee_id` を `NOT NULL` の単一列に。共同担当は `work_item_watcher` へ分離し、担当者としては扱わない |
| 期限と完了条件を必須化 | `due_at NOT NULL` / `done_criteria NOT NULL` + 空白のみを禁じる `CHECK` |
| 対応中は次の行動と次回更新日を必須 | `CHECK progress_requires_next`（`in_progress` / `waiting_other` で強制） |
| 日報・週報・月報を更新履歴から自動生成 | `work_item_event` を期間・スコープで集計 → `report_snapshot`。**LLM は使わない決定論的集計** |
| 経営判断待ちを専用 Inbox に表示 | `status='waiting_decision'` + `approval_request`（未決定）の部分索引。`/ops/inbox` から参照 |
| 全変更履歴を保存 | `work_item_event` 追記専用 + DB 権限剥奪 + 更新トリガ |
| 医療情報と人事情報の権限分離 | `work_item.sensitivity` による行制御 + 人事詳細を `recruitment_private` に物理分離 + 閲覧を `audit_log` に記録 |
| 秘密情報を本文に保存しない | `system_account` にパスワード列を設けず `secret_ref` のみ。加えて API 層で秘密情報パターン検出（§9 R6） |
| スマホで 30 秒以内に進捗更新 | 進捗更新に必要な列を `status` / `next_action` / `next_update_at` / コメントの 4 つに限定し、専用 API `PATCH /api/ops/items/:id/progress` 1 発で完結（§6） |
| AI による人格評価・自動人事評価を行わない | スキーマに評価スコア列を作らない。`recruitment_private.notes` は事実記録用途に限定。レポート生成は集計のみ（§9 R11） |

---

## 4. 権限マトリクス

### 4-1. 役割の定義

| 役割 | 想定 | スコープ |
|---|---|---|
| `system_admin` | IT 管理者 | 全社。ただし人事・医療の**内容**は既定で不可視（設定変更権限と閲覧権限を分離） |
| `executive` | 社長・社長室 | 全社。経営判断 Inbox の名宛人 |
| `dept_manager` | 各部門長（総務・IT・施設運営・採用・広報・イベント） | 自部署（`scope_department_id`） |
| `staff` | 一般スタッフ | 自分が担当・起案・ウォッチする案件 |
| `hr_officer` | 人事担当 | `sensitivity='hr'` の閲覧・編集 |
| `medical_officer` | 医療情報責任者 | `sensitivity='medical'` の閲覧・編集 |
| `auditor` | 監査 | 全件**読み取り専用** + 監査ログ閲覧 |
| `viewer` | 外部委託等 | 明示的に共有された案件のみ閲覧 |

### 4-2. 操作 × 役割（一般案件 `sensitivity='general'`）

| 操作 | system_admin | executive | dept_manager | staff | hr_officer | medical_officer | auditor | viewer |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| 案件作成 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ |
| 自分の担当案件の閲覧 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 共有分のみ |
| 他人の案件の閲覧 | ✓ | ✓ | 自部署 | ウォッチ分のみ | ✗ | ✗ | ✓ | ✗ |
| 進捗更新（次アクション等） | ✓ | ✓ | 自部署 | 自担当のみ | 自担当 | 自担当 | ✗ | ✗ |
| 担当者の変更 | ✓ | ✓ | 自部署 | ✗ | ✗ | ✗ | ✗ | ✗ |
| 期限・完了条件の変更 | ✓ | ✓ | 自部署 | 自担当（履歴必須） | 自担当 | 自担当 | ✗ | ✗ |
| 承認依頼の起票 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ |
| 承認・却下 | ✗※ | ✓ | 自部署案件 | ✗ | ✗ | ✗ | ✗ | ✗ |
| 経営判断 Inbox の閲覧 | ✗ | ✓ | 自部署の起票分 | 自分の起票分 | ✗ | ✗ | ✓ | ✗ |
| 案件のクローズ | ✓ | ✓ | 自部署 | 自担当 | 自担当 | 自担当 | ✗ | ✗ |
| 案件の削除 | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| CSV エクスポート | ✓ | ✓ | 自部署 | ✗ | 人事のみ | 医療のみ | ✓ | ✗ |
| ユーザー・役割管理 | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| 監査ログ閲覧 | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ |

※ `system_admin` に承認権限を与えないのは、権限付与者と承認者を分離するためです。両方が必要な人には `executive` を併せて付与します。
※ **削除は全役割で不可**。取り消しは `status='cancelled'`（履歴が残る論理取消）で行います。

### 4-3. 機微区分 × 役割（閲覧可否）

| 区分 | system_admin | executive | dept_manager | staff | hr_officer | medical_officer | auditor | viewer |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `general` | ✓ | ✓ | 自部署 | 自担当/ウォッチ | ✓ | ✓ | ✓ | 共有分 |
| `hr`（人事・採用） | **✗** | ✓ | **✗** | 自担当のみ | ✓ | **✗** | ✓（記録あり） | ✗ |
| `medical`（医療情報） | **✗** | **✗** | **✗** | 自担当のみ | **✗** | ✓ | ✓（記録あり） | ✗ |

要点：

- **`system_admin` は機微情報を読めません。** システムを運用できることと、人事・医療の内容を読めることを分離します
- **`executive` も医療情報は既定で読めません。** 必要な場合は `medical_officer` を明示付与します
- 機微区分の案件を閲覧すると、**閲覧そのものが `audit_log` に `read_sensitive` として記録**されます
- 機微区分は作成後に**下げられません**（`medical`→`general` の変更を禁止）。上げる操作のみ許可し、変更は履歴に残ります

### 4-4. 実装方式

権限判定は `lib/ops/permissions.ts` の**単一の純粋関数**に集約します。

```ts
can(actor: ActorContext, action: Action, resource: ResourceRef): PermissionResult
```

- API ルート・画面・エクスポートすべてがこの 1 関数を経由する
- §4-2 / §4-3 の表をそのままテーブル駆動テストの入力にする（§8）
- さらに DB 側の Row Level Security を二重防壁として設定し、アプリのバグが機微情報の漏えいに直結しない構成にします

---

## 5. 画面構成

既存 `globals.css` のクラス体系（`.shell` `.panel` `.hero` `.field` `.primary` `.secondary`）を継承し、見た目をインカムと統一します。

| パス | 画面 | 主な役割 | 備考 |
|---|---|---|---|
| `/ops` | マイダッシュボード | 全員 | 「今日やること」「期限超過」「更新期限切れ」「自分待ちの承認」の 4 ブロック。初期表示は自分の案件のみ |
| `/ops/inbox` | **経営判断 Inbox** | executive | 未決の `approval_request` を期限順に。1 件 = 論点・選択肢・推奨案・影響・期限。その場で承認/却下/保留 + 理由入力 |
| `/ops/items` | 案件一覧 | 全員 | 部署 / 型 / 状態 / 担当 / 期限のフィルタ、保存ビュー。権限で自動的に絞り込み |
| `/ops/items/new` | 新規作成 | 全員 | 型を選ぶと必須項目（期限・完了条件）が出る。型別項目は動的フォーム |
| `/ops/items/[id]` | 案件詳細 | 権限に応じ | ヘッダ（担当1名・期限・完了条件・状態）＋ 進捗更新フォーム ＋ **全履歴タイムライン** ＋ 添付 ＋ 承認 |
| `/ops/items/[id]/handover` | 引継ぎ | 担当者・上長 | 引継ぎ先・発効日・引継ぎ範囲。受け手の受領確認まで完了しない |
| `/ops/checklists` | 定型チェックリスト | 担当部署 | 本日/今週の実施分。1 タップでチェック、備考は任意 |
| `/ops/reports` | 日報・週報・月報 | 本人・上長・executive | 期間とスコープを選ぶと履歴から自動生成。人手の作文欄は「所感」1 つだけ |
| `/ops/admin/users` | ユーザー・役割管理 | system_admin / executive | CSV 一括投入（既存 AdminClient の UI を流用）、退職処理（`session_ver` +1 で即時無効化） |
| `/ops/admin/departments` | 部署・拠点管理 | system_admin | |
| `/ops/admin/templates` | チェックリスト定義 | system_admin / dept_manager | |
| `/ops/admin/audit` | 監査ログ閲覧 | auditor / executive | 期間・行為者・操作で検索。エクスポート操作自体も記録 |

### スマホ 30 秒更新の設計（必須要件）

`/ops` を PWA としてホーム画面に追加し、**進捗更新を 1 画面 4 操作**で完結させます。

```
① 通知/ホームから該当案件を開く      … 1 タップ
② 状態を選ぶ（対応中/判断待ち/完了） … 1 タップ
③ 次の行動を入れる                   … 定型候補 or 音声入力
④ 次回更新日を選ぶ（今日/明日/今週末/日付） … 1 タップ
   → 「更新」                         … 1 タップ
```

- 入力欄は上記 4 つに限定し、それ以外の項目は詳細画面へ退避
- タップ領域は 44px 以上、片手操作を想定し操作系は画面下部に配置
- オフライン時はローカルキューに積み、復帰時に**冪等キー付き**で再送
- Web Push で「更新期限切れ」を本人に通知（通知本文は件名のみ、機微情報は載せない）

---

## 6. API 構成

既存の作法（App Router の Route Handler、zod 検証、`ZodError` → 400 の日本語メッセージ）を踏襲します。すべて `/api/ops/*` 配下で、**各ハンドラの先頭で `requireOpsSession()` を必ず呼びます**（middleware は `/api` を保護しないため。§9 R3）。

| メソッド・パス | 用途 | 権限 |
|---|---|---|
| `POST /api/ops/auth/request-link` | ログイン用マジックリンク発行（レート制限付き） | 公開 |
| `GET /api/ops/auth/callback` | リンク検証 → 個人セッション Cookie 発行 | 公開 |
| `POST /api/ops/auth/logout` | ログアウト | 認証済 |
| `GET /api/ops/me` | 自分の情報・保有ロール・機能フラグ | 認証済 |
| `GET /api/ops/items` | 一覧（フィルタ・カーソルページング）。権限で自動絞り込み | 認証済 |
| `POST /api/ops/items` | 作成。型別 zod スキーマで検証 | 認証済 |
| `GET /api/ops/items/:id` | 詳細（履歴・添付・承認を含む） | `can(read)` |
| `PATCH /api/ops/items/:id` | 一般編集（`If-Match` 相当の `version` 必須） | `can(update)` |
| **`PATCH /api/ops/items/:id/progress`** | **30 秒更新専用**。`{ status, next_action, next_update_at, comment?, idempotency_key }` のみ受け付ける | `can(update)` |
| `POST /api/ops/items/:id/handover` | 引継ぎ起票 | `can(update)` |
| `POST /api/ops/items/:id/handover/accept` | 受領確認 | 受け手本人 |
| `GET /api/ops/items/:id/events` | 変更履歴 | `can(read)` |
| `POST /api/ops/items/:id/attachments` | 署名付きアップロード URL の発行 | `can(update)` |
| `GET /api/ops/attachments/:id/url` | 短命（5 分）署名付きダウンロード URL。発行を監査記録 | `can(read)` |
| `GET /api/ops/inbox` | 経営判断待ち一覧 | executive / 起票者 |
| `POST /api/ops/approvals` | 承認依頼（案件を `waiting_decision` へ） | 認証済 |
| `POST /api/ops/approvals/:id/decide` | 承認・却下・保留（理由必須） | 承認者本人 |
| `GET /api/ops/checklists/today` | 本日実施分 | 認証済 |
| `POST /api/ops/checklists/:runId/complete` | チェック結果の記録 | 担当者 |
| `GET /api/ops/reports?kind=daily&period=…&scope=…` | 日報/週報/月報の取得（未生成なら即時生成） | 本人・上長・executive |
| `POST /api/ops/reports/generate` | 定期生成（Vercel Cron から実行、内部トークン必須） | システム |
| `GET /api/ops/export?…` | CSV 出力。件数上限・機微区分制限・監査記録あり | §4-2 準拠 |
| `POST /api/ops/push/subscribe` | Web Push 購読登録 | 認証済 |
| `GET /api/ops/admin/users` ほか | 管理系 CRUD | system_admin / executive |
| `GET /api/ops/admin/audit` | 監査ログ検索 | auditor / executive |

共通規約：

- **冪等性** — 進捗更新系は `idempotency_key` を受け取り、モバイルの再送で履歴が重複しないようにする
- **楽観ロック** — 更新系は `version` を必須にし、不一致は 409 を返して画面で差分を提示
- **エラー本文に機微情報を含めない** — 403 は理由を「権限がありません」に統一（存在推測を防ぐ）
- **全ハンドラで監査記録** — 認証・認可・機微閲覧・エクスポートを `audit_log` へ

---

## 7. 移行方法

既存インカムを**一度も止めずに**段階移行します。

### Step 1. 個人アカウント基盤の追加（インカムは無変更）

1. Postgres を用意（Neon 東京）し、`facility` / `department` / `app_user` / `user_role` を作成
2. `mirise:staff`（Redis）の氏名・職種を CSV で書き出し、メールアドレスと部署を補って `app_user` へ投入。既存の CSV 取り込み UI を `/ops/admin/users` に流用
3. ログインは**メールのマジックリンク**（または Google Workspace SSO）。共通パスワードは Operations では使わない
4. `lib/auth.ts` の `Session` を後方互換で拡張：

   ```ts
   export type Session = {
     role: Role;           // 既存。インカム用
     exp: number;          // 既存
     sub?: string;         // 追加: app_user.id
     ver?: number;         // 追加: session_ver（失効世代）
   };
   ```

   既存トークンは `sub` を持たないため、`/ops` 側は `sub` 必須として弾く。インカム側は従来通り動作し、**既存ユーザーへの影響ゼロ**

### Step 2. Operations の骨格投入（フラグ OFF）

- `app/ops/*` と `app/api/ops/*` を追加。`OPS_ENABLED !== 'true'` なら 404
- `middleware.ts` の matcher に `/ops/:path*` を追加（`/api/ops` は各ハンドラで自前チェック）
- この時点で main にマージ・本番デプロイしても、利用者からは何も見えない

### Step 3. パイロット運用（1 部署）

- 総務または社長室の 1 部署で `OPS_ENABLED=true`。2 週間、既存の運用（メール・口頭・スプレッドシート）と**並行**
- 移行するのは**進行中の案件のみ**。過去案件は移行しない（履歴の正確性を担保できないため）
- 既存スプレッドシートからの取り込みは CSV インポートで対応。取り込み時は全件 `created` イベントを記録し、出典を `detail` に残す

### Step 4. 全部署展開

- 部署ごとに 1〜2 週間ずつ追加。チェックリスト定義と役割付与を部署単位で実施
- 「今日から Hub 以外で指示を出さない」という運用ルールの明文化が成否を分けます（docs/12 として運用手順を追加）

### Step 5. 定着後

- インカム側のログインも個人アカウントに統一（共通パスワードの廃止）。これにより §9 R1・R2 が解消
- Incident 型と LiveKit 全体ルームの連携（緊急時に Hub からインカム招集）を検討

**ロールバック**：各 Step は `OPS_ENABLED=false` で即座に無効化できます。DB マイグレーションは前方互換（列追加のみ、既存列の削除を伴わない）を守り、直前デプロイへの Promote でいつでも戻せる状態を維持します。

---

## 8. テスト計画

現在テストは 0 件・CI も無いため、**Operations 用のテスト基盤の新設が Phase 1 の一部**になります。既存インカムのコードには遡及してテストを書かず、Operations の新規コードのみを対象にします。

### 8-1. 追加する基盤

| 層 | ツール | 対象 |
|---|---|---|
| 単体 | Vitest | 権限判定 `can()`、必須制約バリデータ、レポート集計、秘密情報検出、冪等キー処理 |
| DB 統合 | Vitest + Neon ブランチ（またはローカル Docker Postgres） | `CHECK` 制約・追記専用権限・トリガ・RLS の実挙動 |
| API 統合 | Vitest + Next Route Handler 直接呼び出し | 認証・認可・楽観ロック・監査記録の書き込み |
| E2E | Playwright（デスクトップ + モバイルビューポート） | ログイン→案件作成→進捗更新→承認→レポートの一連 |
| CI | GitHub Actions（**新規**） | `lint` / `tsc --noEmit` / `vitest` / `playwright` / `drizzle-kit check` |

### 8-2. 必ず自動テストで守る項目

必須設計は「レビューで気をつける」ではなく**テストで固定**します。

| # | テスト内容 | 種別 |
|---|---|---|
| T1 | 主担当を 2 名にする API 呼び出しが失敗する | API |
| T2 | 期限なし / 完了条件なしの作成が 400 になる（API 層と DB 層の両方で） | API + DB |
| T3 | `status='in_progress'` で `next_action` / `next_update_at` が空だと DB が拒否する | DB |
| T4 | `work_item_event` に対する `UPDATE` / `DELETE` が権限エラーになる | DB |
| T5 | 案件を更新すると必ず対応するイベントが 1 件増える（トリガ経由も含む） | DB |
| T6 | §4-2 / §4-3 の権限マトリクスを**表からそのまま生成した全組み合わせ**で `can()` を検証（役割 8 × 操作 13 × 機微 3） | 単体 |
| T7 | `system_admin` が `hr` / `medical` 案件を一覧・詳細・エクスポート・検索の**いずれの経路でも**取得できない | API |
| T8 | 機微案件の閲覧が `audit_log` に記録される | API |
| T9 | パスワードらしき文字列を本文・`secret_ref` に入れると拒否される（既知パターン + 高エントロピー文字列） | 単体 + API |
| T10 | 日報が同じイベント列から**常に同じ結果**を返す（決定論性）。生成に外部 AI 呼び出しが発生しないことをモックで確認 | 単体 |
| T11 | 退職処理（`session_ver` +1）後、既存 Cookie でのアクセスが即座に 401 になる | API |
| T12 | 同一 `idempotency_key` の進捗更新を 2 回送っても履歴が 1 件のまま | API |
| T13 | `version` 不一致の更新が 409 になり、データが壊れない | API |
| T14 | モバイルビューポート（iPhone SE 相当）で、案件を開いてから進捗更新完了まで**操作 5 回以内・入力欄 4 つ以内** | E2E |
| T15 | 添付のダウンロード URL が 5 分で失効し、権限のない利用者が発行できない | API |

### 8-3. 非機能・運用テスト

- 案件 10,000 件・イベント 200,000 件でのダッシュボード表示 1.5 秒以内（索引の妥当性確認）
- Vercel の Cron によるレポート定期生成が二重起動しない（`report_snapshot` の UNIQUE 制約で担保）
- パイロット部署での 2 週間 UAT：既存運用との突合、「30 秒で更新できたか」を実測で確認

---

## 9. セキュリティ上のリスク

深刻度は **高 = 本番投入前に必ず解消 / 中 = Phase 内で解消 / 低 = 継続的に管理**。

| # | リスク | 深刻度 | 根拠（現状） | 対策 |
|---|---|:-:|---|---|
| R1 | **共通パスワードでは行為者を特定できない** — 監査ログ・主担当者・変更履歴という要件が原理的に成立しない | **高** | `lib/auth.ts` の `Session = { role, exp }`。個人 ID を持たない | Operations は個人アカウント必須。`sub` を持たないセッションは `/ops` で一律拒否（§7 Step 1） |
| R2 | **セッションの即時無効化ができない** — 退職者のアクセスが最大 12 時間残る。`CLINIC_PASSWORD` を変えても既存セッションは無効化されない（署名鍵は `AUTH_SECRET`） | **高** | `verifySessionToken()` は HMAC と `exp` のみ検証。サーバ側の失効機構なし | `app_user.session_ver` をトークンに埋め、検証時に DB 値と突合。退職処理で +1 → 即時失効（T11） |
| R3 | **middleware が `/api/*` を保護しない** — この規約を知らずに Operations の API を足すと無防備なエンドポイントが生まれる | **高** | `matcher: ["/", "/admin", "/admin/:path*"]` | 全ハンドラ共通の `requireOpsSession()` を必須化し、「ハンドラ先頭で認可関数を呼んでいるか」を lint ルールと統合テストで機械的に検査 |
| R4 | **医療・人事情報の混在** — 単一テーブルに全部署の案件が入るため、絞り込み漏れが即漏えいになる | **高** | 現状該当機能なし（新規リスク） | `sensitivity` による行制御 + 人事詳細の物理分離 + **DB の RLS による二重防壁** + 機微閲覧の監査記録（§4-3、T7・T8） |
| R5 | **添付ファイルの流出** — 直リンクが共有されると権限が無効化する | **高** | 現状該当機能なし（新規リスク） | 公開 URL を保存せず、5 分失効の署名付き URL を都度発行。発行を監査記録。医療・人事添付は別バケット |
| R6 | **秘密情報の本文混入** — System/Account の運用で、担当者が本文にパスワードを貼る事故は高頻度で起きる | **高** | 現状該当機能なし（新規リスク） | パスワード列を作らない（`secret_ref` のみ）。加えて保存時に既知パターン（`password:` `api[_-]?key` `-----BEGIN` `sk-` 等）と高エントロピー文字列を検出して**保存を拒否**。既存データの定期スキャンも実施（T9） |
| R7 | **ログインのブルートフォース** — `/api/login` にレート制限・ロックアウトがない | 中 | `api/login/route.ts` に試行回数管理なし | Upstash Redis で IP + アカウント単位のレート制限。Operations のマジックリンクにも同様に適用。失敗を `audit_log` に記録 |
| R8 | **監査ログの改ざん** — 管理者が自分の操作記録を消せると監査が成立しない | 中 | 現状ログ自体が存在しない | 追記専用（`UPDATE`/`DELETE` 権限を剥奪）+ ハッシュチェーン（`prev_hash`/`row_hash`）+ `system_admin` に監査ログの閲覧権限を与えない（§4-2） |
| R9 | **一括エクスポートによる大量持ち出し** | 中 | 現状該当機能なし（新規リスク） | 役割ごとに件数上限、機微区分は既定で除外、実行を必ず監査記録、大量出力時は executive へ通知 |
| R10 | **通知経由の情報漏えい** — ロック画面のプッシュ通知に患者情報や人事情報が出る | 中 | 現状該当機能なし（新規リスク） | 通知本文は「案件の更新期限です（OPS-000123）」等の識別子のみ。内容はアプリを開いて認証後に表示（docs/04 の患者情報を残さない方針に整合） |
| R11 | **AI による人格評価・自動人事評価** — 禁止要件に反する実装が混入する | 中 | 現状 AI 機能なし | ①レポート生成は SQL 集計のみで LLM を一切呼ばない（T10）②評価スコアの列をスキーマに作らない ③`recruitment_private.notes` は事実記録限定と UI で明示 ④コードレビュー時のチェック項目として docs 化。docs/04 の「AI 文字起こしを入れない」方針と同じ立て付けにする |
| R12 | **Upstash の全置換保存による設定消失** — 管理画面の同時編集で片方の変更が消える | 中 | `saveRooms()` / `saveStaff()` が JSON 丸ごと `SET`。楽観ロックなし | Operations では行単位 + `version` による楽観ロック（T13）。既存インカム側の改善は別課題として記録 |
| R13 | **CI が無く品質ゲートが Vercel ビルドのみ** — 権限判定のリグレッションが本番に届く | 中 | `.github/` なし | GitHub Actions で lint / 型 / テストを必須化。権限マトリクステスト（T6）の失敗をマージブロック条件に |
| R14 | **依存関係の脆弱性管理がない** | 低 | Dependabot 設定なし、`npm audit` の実行経路なし | Dependabot 有効化 + CI で `npm audit --production` |
| R15 | **管理画面のネットワーク制限がない** | 低 | `/admin` はパスワードのみで到達可能 | `/ops/admin` は IP 制限または追加の再認証。docs/04「管理画面は IP 制限または二要素認証」の本番方針に沿う |
| R16 | **`INTERCOM_API_KEY` による認証バイパス経路** — ヘッダー 1 つでトークンを取得できる | 低 | `api/token/route.ts` の `x-intercom-key` | Operations では同種の抜け道を作らない。既存分はキーの定期ローテーションを運用手順に追加 |

**個人情報保護法上の留意**：採用情報・人事情報は個人情報、医療情報は要配慮個人情報に該当します（docs/04 参照）。本設計は「保存する情報を最小化し、区分ごとにアクセスを分離し、閲覧を記録する」方針で構成しています。実運用前に、保存項目・保存期間・削除手順・開示請求対応の 4 点を法務確認してください。

---

## 10. 実装を分割した作業計画

各フェーズは**単独でデプロイ可能**かつ**`OPS_ENABLED=false` で無害**です。工数は 1 名専任換算の目安です。

### Phase 0 — 基盤整備（1 週間）
- Postgres（Neon 東京）の用意、Drizzle 導入、マイグレーション運用の確立
- Vitest / Playwright / GitHub Actions（lint・型・テスト）の新設 ← **現状ゼロからの構築**
- `OPS_ENABLED` フラグと `/ops` の空スケルトン、middleware matcher 追加
- **完了条件**: CI が緑で main にマージされ、本番に何の変化も起きないこと

### Phase 1 — 個人アカウントと権限（2 週間）
- `facility` / `department` / `app_user` / `user_role` のスキーマとマイグレーション
- マジックリンク認証（または Google Workspace SSO）、`Session` の後方互換拡張、`session_ver` による即時失効
- 権限判定 `can()` と権限マトリクステスト（T6・T7・T11）
- `audit_log` の追記専用実装（DB 権限剥奪・ハッシュチェーン）
- ユーザー CSV 投入画面（既存 AdminClient の UI を流用）
- レート制限（R7）
- **完了条件**: 実ユーザーがログインでき、役割別の到達可否がテストで固定されている

### Phase 2 — Work Item のコア（3 週間）
- `work_item` / `work_item_detail` / `work_item_event` / `work_item_watcher` / `work_item_link`
- 必須設計の `CHECK` 制約と更新トリガ（T1〜T5）
- 型 10 種の zod スキーマと動的フォーム
- 一覧・詳細・作成・更新 API、楽観ロック、履歴タイムライン UI
- **完了条件**: Task / Decision / Incident の 3 型で一連の運用が回る

### Phase 3 — モバイル 30 秒更新と PWA（1.5 週間）
- `PATCH /items/:id/progress`、冪等キー、オフラインキュー（T12）
- PWA 化（manifest・Service Worker・アイコン・viewport メタ）← **現状ゼロからの構築**
- Web Push（購読登録・期限切れ通知）。通知本文は識別子のみ（R10）
- モバイル E2E（T14）
- **完了条件**: 実機で 30 秒以内の更新が計測できる

### Phase 4 — 承認と経営判断 Inbox（1.5 週間）
- `approval_request`、`/ops/inbox`、承認・却下・保留（理由必須）
- 承認期限の通知、`waiting_decision` との連動
- **完了条件**: 社長室の判断待ち案件が Inbox に漏れなく集まる

### Phase 5 — レポート自動生成（1.5 週間）
- イベント列からの決定論的集計、`report_snapshot`、Vercel Cron による定期生成
- 日報・週報・月報の画面、スコープ（個人・部署・全社）切替
- 決定論性テスト・AI 非使用テスト（T10）
- **完了条件**: 手作業ゼロで日報が出る

### Phase 6 — 残る型と機微情報の分離（2.5 週間）
- Routine Checklist（テンプレート・実施記録）、Handover（受領確認まで）、System/Account（`secret_ref` のみ・秘密検出）、Recruitment（`recruitment_private` 隔離）、Procurement、Project Milestone、Review
- 添付ファイル（署名付き URL・監査記録・機微別バケット）
- 機微区分の RLS 二重防壁、エクスポート制限（R4・R5・R9）
- **完了条件**: 全 10 型が使え、T7〜T9 が緑

### Phase 7 — パイロットと展開（4 週間）
- 1 部署でのパイロット、運用手順の docs 化（docs/12・13）、フィードバック反映
- 部署ごとの段階展開、役割付与、チェックリスト定義
- **完了条件**: 全 7 部署が Hub 上で運用されている

**合計目安: 約 17 週間（4 ヶ月）／専任 1 名。** 2 名体制なら Phase 2 以降を並列化して約 11 週間。

### 先に決めておくべき事項（実装着手前）

1. **認証方式** — Google Workspace SSO か、メールのマジックリンクか。既存のメール環境に依存するため要確認
2. **DB の選定** — Neon / Supabase / Vercel Postgres のいずれか。医療情報を扱うため**東京リージョン**と暗号化・バックアップ要件の確認が必要
3. **インフラ費用** — 現在は全て無料枠（Vercel Hobby / LiveKit Free / Upstash Free）。Operations 追加により **Vercel Pro（商用利用・Cron・保護機能）と Postgres の有料化が必要**になる見込み。月額の承認が要ります
4. **部署と役割の実体** — §4-1 の 8 役割を、実際の職位（誰が executive か、hr_officer は誰か）に割り当てる必要があります
5. **保存期間と削除方針** — 案件・履歴・監査ログそれぞれの保存年数と削除手順（法務確認事項）
