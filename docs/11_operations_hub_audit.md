# 11 MIRISE Hub Operations 技術監査（実装前調査）

**監査対象**: MIRISE Hub 本体（`dental-clinic-app` / 本番 https://dentalhub.tokyo）
**目的**: 総務・社長室・IT・施設運営・採用・広報・イベントの指示／進捗／成果物／承認／引継ぎを一元管理する **Operations 機能**を、最小侵襲で追加する
**本書の段階ではコード変更を行っていません。** 記載のスキーマ・API・画面はすべて提案です。

> **注記**: 本書は当初、別リポジトリ（`tomyorts/mirise` = MIRISE Intercom / 院内音声インカム）を対象に作成しましたが、実際の MIRISE Hub コードベースの提供を受けたため、全面的に書き直しています。Intercom は Hub とは独立した別アプリです。

---

## ⚠️ 0. 監査中に発見した緊急対応事項

Operations の設計より先に対応が必要な事項です。**S-1 は即日対応を推奨します。**

### S-1【最優先】本番の認証情報が平文で配布物に含まれている

提供された zip の `.project-config.json` に、以下が**平文で**含まれていました。

| 種別 | 内容 |
|---|---|
| 本番 DB 接続文字列 | TiDB Cloud（ユーザー名・パスワード・ホスト・DB 名すべて） |
| `JWT_SECRET` | **全ユーザーのセッション Cookie の署名鍵** |
| `VAPID_PRIVATE_KEY` | Web Push の秘密鍵 |
| クラウドストレージの認証情報 | アクセスキー・シークレット・セッショントークン |
| 外部 API キー | LLM / ストレージ用（サーバー用・フロントエンド用の 2 種） |

**リスク**: `JWT_SECRET` が漏れると、**任意のユーザーになりすましたセッション Cookie を第三者が自作できます**。ロール（`appRole`）は DB から引かれるため、なりすまし対象が TenantAdmin であれば全テナントデータにアクセスされます。DB 接続文字列は TiDB Cloud への直接接続を許します。

**対応（推奨順）**:
1. `JWT_SECRET` を再生成（全ユーザーが再ログインになりますが、これは必要なコストです）
2. DB パスワードのローテーション
3. VAPID 鍵ペアの再生成（既存の Push 購読は再登録が必要）
4. ストレージ・LLM の API キーをローテーション
5. DB のアクセスログを確認し、想定外の接続元がないか点検

`.gitignore` には `.project-config.json` が含まれているためリポジトリには入っていませんが、**zip 配布・チャット添付・スクリーンショット経由での流出**が現実の経路です。今後この種のファイルを共有しない運用ルールが必要です。

### S-2 マイナンバー・年金番号・銀行口座が平文保存されている

`onboardingForms` テーブル（入職時フォーム）に以下が保存されています。

- `myNumber`（本人のマイナンバー）／`dependents[].myNumber`（扶養家族のマイナンバー、最大 10 名分）
- `pensionNumber`（基礎年金番号）、`employmentInsuranceNumber`（雇用保険番号）
- `bankName` / `branchName` / `accountNumber` / `accountHolderName`（給与振込口座）
- `resumeFiles`（履歴書）、`licenseFiles`（資格証明書）の保存先 URL

スキーマには `// マイナンバー (encrypted at app level)` というコメントがありますが、**コードベース全体を検索した結果、暗号化処理は実装されていません**（`crypto` の使用箇所は LINE の HMAC 署名検証とトークン生成のみ）。UI 側も `<Input type="password">` による画面表示のマスクのみで、保存値は平文です。

マイナンバーは番号法上の**特定個人情報**であり、通常の個人情報より厳格な安全管理措置（利用範囲の限定、アクセス制御、暗号化、廃棄手順）が求められます。Operations で採用（Recruitment）を扱う前に、この既存の穴を塞ぐ必要があります。

### S-3 退職・無効化したユーザーがアクセスし続けられる

- セッションは JWT（HS256）で **有効期限 1 年**（`ONE_YEAR_MS`）
- `sdk.authenticateRequest()` は openId から DB のユーザーを引きますが、**`isActive` も `employmentStatus` も検証していません**
- `isActive` を見ているのは `localAuth.login`（ログイン時）だけ

つまり、管理画面でユーザーを無効化しても、**すでに発行済みのセッションは最大 1 年間有効なまま**です。退職者が私物端末からログインしたままなら、アクセスは継続します。引継ぎ（Handover）を扱う Operations では致命的です。

### S-4 患者の医療情報が全ロールから閲覧できる

`tenantProcedure` は「テナントに所属しているか」だけを検査し、`appRole` を一切見ません。以下の患者データがこの `tenantProcedure` で公開されています。

| ルーター | 内容 | 使用中の権限 |
|---|---|---|
| `orthodonticPatients` | 矯正患者情報 | `tenantProcedure` 4 / `managerProcedure` 1 |
| `invisalign` | インビザライン症例 | `tenantProcedure` 6 / `managerProcedure` 2 |
| `lingual` | 裏側矯正症例 | `tenantProcedure` 5 / `managerProcedure` 2 |
| `patientVideos` | 患者動画 | `tenantProcedure` 3 / `managerProcedure` 3 |
| `phoneCallRecords` | 電話対応記録 | `tenantProcedure` 3 / `managerProcedure` 1 |

`Viewer` ロール（最下位）でもこれらを読めます。要配慮個人情報を最小権限で扱えていません。

---

## 1. 現状アーキテクチャ

### 1-1. 全体像

```
ブラウザ / PWA（iOS Safari・Android Chrome・PC）
  │  HTTPS
  ▼
Express 4（単一プロセス、Cloud Run 上）
  ├─ /api/trpc/*          tRPC v11（appRouter：約 90 ルーター）
  ├─ /api/oauth/callback  OAuth コールバック（Manus OAuth）
  ├─ /api/upload/*        multer によるファイル/チャンクアップロード
  ├─ /api/line/webhook    LINE Messaging API
  ├─ /api/stripe/webhook  Stripe（課金）
  ├─ /api/scheduled/*     Heartbeat（プラットフォームからの HTTP cron）
  └─ 静的配信 or Vite（開発時）
  │
  ├─▶ MySQL（TiDB Cloud, us-east-1）… Drizzle ORM / 100 テーブル / 68 マイグレーション
  ├─▶ ストレージプロキシ（Forge）… 画像・動画・書類
  ├─▶ LLM API（Forge）… AI コンシェルジュ・音声/動画文字起こし
  ├─▶ Web Push（VAPID）／LINE Messaging／メール（Resend・nodemailer）
  └─▶ Stripe（サブスクリプション課金）
```

規模: TypeScript/TSX **約 87,700 行**（`server` / `shared` / `client/src`）。`server/routers.ts` 単体で 5,058 行。

### 1-2. 調査項目 1: フレームワーク・言語・主要ライブラリ

| 領域 | 内容 |
|---|---|
| 言語 | TypeScript 5.9.3（`strict` 有効）、ESM |
| フロント | React 19.2、**Vite 7**、**wouter**（ルーター、パッチ適用あり）、TanStack Query 5 |
| UI | **Tailwind CSS 4** + **shadcn/ui**（Radix UI 25 コンポーネント）、framer-motion、recharts、dnd-kit |
| API | **tRPC v11**（`superjson` トランスフォーマ）+ Express 4 |
| DB | **Drizzle ORM 0.44** + `mysql2`。マイグレーションは `drizzle-kit` |
| 検証 | **zod 4** |
| 認証 | `jose`（JWT）+ `bcryptjs`（パスワード） |
| 国際化 | **i18next / react-i18next**（`ja.json` / `en.json`） |
| 通知 | `web-push`（VAPID）、LINE Messaging API、`resend` / `nodemailer` |
| 課金 | `stripe` / `@stripe/stripe-js` |
| ファイル | `multer`、`@aws-sdk/client-s3` + `s3-request-presigner`、`browser-image-compression` |
| テスト | **vitest**（`server/**/*.test.ts`） |
| パッケージ管理 | **pnpm 10** |

### 1-3. 調査項目 2: 認証方式

**2 系統のログインが併存**します。

**(A) ローカル認証（メール + パスワード）** — 実運用の主経路
- `localAuth.login`: メールで `users` を引き、`bcrypt.compare` で照合
- 成功時に JWT（HS256、`{ openId, appId, name }`、**有効期限 1 年**）を発行し、Cookie `app_session_id` に格納
- `mustChangePassword` による初回強制変更、招待トークン（`nanoid(48)`、1 時間有効）によるパスワードリセット
- リセット要求はメール存在を秘匿する応答（enumeration 対策済み）

**(B) OAuth（Manus OAuth）**
- `/api/oauth/callback` で code を交換 → ユーザー情報取得
- **ホワイトリスト方式**: OAuth で得たメールが `users` に未登録なら `/login?error=not_registered` へ弾く（良い設計）

**認可のミドルウェア階層**（`server/routers.ts` 冒頭）:

```
publicProcedure      … 認証不要（12 箇所）
protectedProcedure   … ログイン必須（31 箇所）
tenantProcedure      … + テナント所属必須（157 箇所）※ appRole は見ない
staffProcedure       … + Staff 以上（127 箇所）
managerProcedure     … + Manager 以上（87 箇所）
adminProcedure       … + TenantAdmin 以上（75 箇所）
```

**構造的な問題**:

| # | 事実 | 影響 |
|---|---|---|
| A1 | セッション JWT に `isActive` / `employmentStatus` の検証がなく、失効機構もない（§S-3） | 退職者が最大 1 年アクセス可能 |
| A2 | セッション TTL が 1 年 | 端末紛失時の露出期間が長い |
| A3 | `localAuth.login` に**レート制限・ロックアウトがない** | ブルートフォース耐性なし |
| A4 | `requireRole()` ヘルパーが定義されているが未使用（デッドコード） | 実装意図と実態の乖離 |
| A5 | `_core/trpc.ts` の `adminProcedure`（`users.role === 'admin'` を見る旧系）と `routers.ts` の `adminProcedure`（`appRole` を見る新系）が**同名で併存** | 取り違えると認可が緩む |

### 1-4. 調査項目 3: ユーザー・部署・役割・権限構造

- **ユーザー**: `users` テーブル。`openId`（ユニーク）、`email`、`tenantId`、`appRole`、`jobCategoryId`、`isActive`、`employmentStatus`（active/retired）、`passwordHash`、プライバシー同意（日時・バージョン・IP）
- **テナント（医院）**: `tenants`。プラン、ブランディング（ロゴ・テーマ色・ログイン背景）、診療時間、メニュー構成、Stripe 契約情報
- **部署**: `departments`（テナント配下）+ `userDepartments`（多対多）。既定は「矯正 / 口腔外科 / 衛生士 / 受付」
- **職種**: `jobCategories`（別軸）
- **役割**: `appRole` の 5 値

```ts
ROLE_HIERARCHY = { SuperAdmin: 0, TenantAdmin: 1, Manager: 2, Staff: 3, Viewer: 4 }
hasMinRole(userRole, requiredRole) => ROLE_HIERARCHY[userRole] <= ROLE_HIERARCHY[requiredRole]
```

**これは完全な一直線の階層です。** 上位ロールは下位ロールが見られるものをすべて見られます。結果として:

- **職務分離（separation of duties）が表現できません。** 「IT 管理者はシステムを運用できるが人事情報は読めない」「人事担当は人事情報を読めるが医療情報は読めない」という Operations の必須要件は、この 1 次元モデルでは**表現不可能**です
- 部署（`departments`）は所属の記録には使われていますが、**認可には使われていません**（`userDepartments` を見て絞り込む処理が認可経路にない）

例外的に**唯一のリソース単位権限**が存在します:

```
calendarCategoryPermissions (categoryId × userId × canView / canEdit / grantedById)
```

カレンダーのカテゴリだけは、ユーザー単位の閲覧・編集権限を持てます。**これが Operations の権限モデルの雛形として最も近い既存実装**です。

### 1-5. 調査項目 4: データベースと ORM

- **MySQL（TiDB Cloud）+ Drizzle ORM**。`drizzle/schema.ts` に **100 テーブル**、`drizzle/` に **68 個のマイグレーション**（`0000` 〜 `0067`）
- マイグレーション運用は `pnpm db:push`（`drizzle-kit generate && drizzle-kit migrate`）
- 主要テーブル群:

| 分類 | テーブル |
|---|---|
| 組織 | `users` `tenants` `departments` `userDepartments` `jobCategories` |
| 情報共有 | `posts` `comments` `reactions` `hashtags` `postReads` `postConfirmations` `categories` |
| マニュアル | `manuals` `manualArticles` `articleVersions` `articleMedia` `articleReads` `quizzes` |
| **タスク** | `tasks` |
| 勤怠・シフト | `shifts` `shiftTypes` `shiftRequests` `attendanceRecords` `breakRecords` `timecardCorrections` `overtimeRequests` `paidLeave*`（3） |
| 申請・承認 | `leaveRequests` `transportExpenses` `commuterPasses` `fieldWorkRecords` `purchaseOrders` |
| カレンダー | `calendarEvents` `calendarCategories` `calendarCategoryPermissions` `calendarAuditLogs` `googleCalendarSyncs` `dutyCategories` `dutyAssignments` |
| 書類・物品 | `documents` `documentFolders` `attachmentTemplates` `mailItems` `receivedGifts` `invoices` `inventoryItems` `inventoryTransactions` |
| 患者（医療） | `orthodonticPatients` `invisalignCases` `lingualCases` `whitespotPatients` `patientVideos` `phoneCallRecords` `dhNotes` `operationWaitlist` `labWorks` `repairs` |
| 人事 | `onboardingForms` `staffEvaluations` `userProfiles` |
| 基盤 | `auditLogs` `notifications` `notificationSettings` `pushSubscriptions` `lineUsers` `storageUsage` `uploadSessions` `masterData` |

**`tasks` テーブルの現状**（Operations の出発点）:

```ts
tasks {
  id, tenantId, title, description,
  creatorId,  assigneeId,          // ← nullable（担当者なしを許す）
  status: "Todo" | "InProgress" | "Done" | "Reverted",
  priority: "Low" | "Medium" | "High",
  dueDate,                          // ← nullable
  relatedPostId, relatedArticleId,
  createdAt, updatedAt
}
```

Operations の必須設計に対する不足は明確です:

| 必須設計 | 現状 |
|---|---|
| 主担当者 1 名 | `assigneeId` は nullable。未割当タスクが作れる |
| 期限の必須化 | `dueDate` は nullable |
| 完了条件の必須化 | **列が存在しない** |
| 対応中は次の行動・次回更新日 | **列が存在しない** |
| 全変更履歴 | `auditLogs` に CREATE/UPDATE/DELETE の 3 件のみ記録。`details` は差分の一部（変更後の値のみ） |
| 種別（Decision / Incident 等） | **列が存在しない**。Task 一種のみ |
| 機微区分 | **列が存在しない** |

### 1-6. 調査項目 5: カレンダー・ファイル・通知の既存機能

**いずれも実装済みで、そのまま再利用できます。**

**カレンダー**（`calendarEvents` ほか 6 テーブル）
- 終日／時刻指定、複数日、色分け、カテゴリ、係（duty）割当
- **繰り返し**（日／週／月／年、N 間隔、第 N 週の曜日、除外日リスト、無期限可）。`client/src/lib/recurrence.ts` に展開ロジック
- **開始前通知**（`notifyMinutesBefore`）
- **カテゴリ単位のユーザー権限**（`calendarCategoryPermissions`）
- **変更履歴**（`calendarAuditLogs`：old/new の差分 JSON、削除後も参照できるようタイトル・日付を非正規化保持）
- Google カレンダー双方向同期（`googleCalendarSyncs`、sync token による増分同期）
- 日本の祝日（`client/src/lib/japaneseHolidays.ts`）

**ファイル**
- `documents` / `documentFolders`（階層フォルダ、並び順、**フォルダ単位のパスワードロック**＝bcrypt ハッシュ）
- アップロードは `/api/upload/*`（multer）。大容量はチャンク分割 → `uploadSessions` で進捗管理 → サーバー側で結合
- 保存先はストレージプロキシ。`storagePut()` が返す URL を DB に**永続保存**（`documents.fileUrl`、`onboardingForms.resumeFiles[].url` など）
- 画像はクライアント側で圧縮（`browser-image-compression`）、動画も圧縮（`lib/videoCompressor.ts`）
- 容量管理（`storageUsage` / `storageAlertSettings` / StorageDashboard 画面）

**通知**（4 チャネル）
1. アプリ内（`notifications` テーブル、未読カウント、リンク付き）
2. **Web Push**（VAPID、`pushSubscriptions`、`server/pushService.ts`）
3. **LINE Messaging API**（`lineUsers` で連携、`server/lineMessaging.ts`、Webhook 受信あり）
4. メール（Resend / nodemailer）

`notificationSettings` でユーザーごと・種別ごとに ON/OFF。`approvalNotifier.ts` が**承認・却下の通知を 3 チャネルへ同時配信**する既存パターンを持っています（Operations の承認通知はこれをそのまま使えます）。

### 1-7. 調査項目 6: モバイル / PWA 対応

**PWA 対応済み**です。

- `client/public/manifest.json` と `client/public/sw.js` が存在
- `PwaInstallPrompt.tsx`（ホーム画面追加の誘導）、`SafariBanner.tsx`（iOS Safari 固有の案内）
- `hooks/useMobile.tsx` でレスポンシブ分岐、`MobileBackButton.tsx`
- Tailwind によるレスポンシブ、`vaul`（モバイル用ドロワー）
- iOS Safari が Cookie を送らない経路への対策として、**`Authorization: Bearer` ヘッダーでの認証**と 15 分間有効なアップロードトークン（`auth.getUploadToken`）を実装済み
- 導入マニュアルにも「ホーム画面に追加してネイティブアプリのように使う」手順あり

→ 「スマホで 30 秒以内に進捗更新」の土台は**すでに整っています**。必要なのは専用の軽量 UI と API だけです。

### 1-8. 調査項目 7: 監査ログ

**2 系統存在します。**

**(A) 汎用 `auditLogs`**
```ts
auditLogs { id, tenantId, userId, userName, action, targetEntity, targetId, details(JSON), createdAt }
action: "CREATE" | "READ" | "UPDATE" | "DELETE" | "LOGIN" | "LOGOUT"
```
`server/routers.ts` の `audit()` ヘルパー経由で **82 箇所**から記録。閲覧画面は `/admin/audit-logs`（`AdminAuditLogs.tsx`）。

**(B) `calendarAuditLogs`** — カレンダー専用。old/new の差分を保持する、より精密な設計。

**不足点**:

| # | 内容 |
|---|---|
| B1 | **`READ` が実質使われていません。** 患者情報・人事情報の**閲覧**は記録されていません（要配慮個人情報の取扱記録として不十分） |
| B2 | 記録対象に大きな欠落: `Attendance` `LeaveRequest` `Document` `StaffEvaluation` `Patient*` `PatientVideo` `PhoneCall` `Shift` に対する `audit()` 呼び出しがありません |
| B3 | `details` は**変更後の値のみ**。変更前が残らないため「何がどう変わったか」を復元できません（カレンダーだけは old/new を持つ） |
| B4 | `auditLogs` は通常テーブルで、**アプリの DB ユーザーが UPDATE / DELETE できます**。改ざん耐性がありません |
| B5 | ログイン成功・失敗の記録がありません（`LOGIN` enum は定義済みだが未使用） |

### 1-9. 調査項目 8: 現在のデプロイ方法

- **ホスティング**: Manus プラットフォーム（**Cloud Run** 上）。本番 https://dentalhub.tokyo（代替 www）
- **ソース管理**: GitHub ではなく **Manus の webdev git**（`s3://vida-prod-gitrepo/...`）
- **ビルド**: `vite build && esbuild server/_core/index.ts --bundle --format=esm --outdir=dist` → `node dist/index.js`
- **DB マイグレーション**: `pnpm db:push` を手動実行（デプロイパイプラインには組み込まれていない）
- **定期実行**: プラットフォームの **Heartbeat**（HTTP cron が `/api/scheduled/*` を叩く）。`references/periodic-updates.md` に規約あり。**`setInterval` / `node-cron` は禁止**（Cloud Run がアイドルインスタンスを終了するため）
  - ⚠️ ただし `server/_core/index.ts` は `startLabWorkReminderScheduler()` を**プロセス内で起動**しており、この規約に反しています（技工物リマインダーが不定期に止まる可能性）
- **CI**: **なし**。lint / 型チェック / テストの自動実行なし。`pnpm check`（`tsc --noEmit`）と `pnpm test` は手動
- **課金**: Stripe（`starter` / `standard` / `premium` + アドオン、トライアル期間あり）

### 1-10. 調査項目 9: テスト環境

**整備済みです。**

- **vitest**（`environment: node`、対象は `server/**/*.test.ts`）
- **テストファイル 56 個、テストケース約 880 件**
- カバー範囲は広く、以下が含まれます:
  - `tenant-isolation.test.ts`（**テナント分離**）
  - `calendar-permissions-audit.test.ts`（カレンダー権限・監査）
  - `local-auth.test.ts` / `localAuth.test.ts` / `password-reset.test.ts` / `auth.logout.test.ts` / `oauth.test.ts`
  - `superadmin.test.ts` / `superadmin-users.test.ts` / `admin-features.test.ts`
  - `shifts.test.ts` / `attendance-*.test.ts`（3）/ `staffEval.test.ts` / `surveys.test.ts` / `push.test.ts` ほか

**不足**: E2E（Playwright 等）なし、クライアント側テストなし、CI での自動実行なし。

### 1-11. 調査項目 10: Operations を最小侵襲で追加する方法（結論）

**結論: 既存の `tasks` を拡張するのではなく、`workItems` という新しいドメインを並置し、既存機能を「呼び出して使う」構成にします。**

理由:
- `tasks` は既存画面（Tasks / TaskDetail / CreateTask / AI コンシェルジュの文脈 / Home ウィジェット）から使われており、必須列（期限・完了条件）を後から `NOT NULL` にすると**既存データが移行できず、既存画面が壊れます**
- Operations は 10 種の Work Item を扱い、機微区分・承認・引継ぎを持つため、`tasks` の粒度とは要求が異なります

**追加する範囲**:

```
drizzle/schema.ts        末尾に workItems 関連 10 テーブルを追記（既存テーブルは変更しない）
drizzle/0068_*.sql       新規マイグレーション（追加のみ、破壊的変更なし）
server/ops/              新規ディレクトリ
  ├─ permissions.ts      権限判定の単一関数（新モデル）
  ├─ router.ts           tRPC ルーター（appRouter に 1 行追加）
  ├─ events.ts           変更履歴の記録
  └─ reports.ts          日報・週報・月報の集計
server/ops/*.test.ts     vitest（既存の書式を踏襲）
client/src/pages/ops/    新規画面
shared/opsTypes.ts       共有型
```

**既存ファイルへの変更は 4 箇所のみ**:
1. `server/routers.ts` … `appRouter` に `ops: opsRouter,` を 1 行追加
2. `client/src/App.tsx` … `/ops/*` のルート追加
3. `shared/menuConfig.ts` … `DEFAULT_MENU_ORDER` に Operations のメニューキーを追加
4. `drizzle/schema.ts` … 末尾にテーブル定義を追記

さらに `tenants.settings`（既存の JSON 列）に `opsEnabled` フラグを置けば、**テナント単位で段階的に有効化**できます。既存テナントには何も見えません。

---

## 2. 再利用できる既存機能

**Operations に必要な基盤の約 8 割が既存です。**

| 必要なもの | 既存資産 | 再利用方法 | 追加実装 |
|---|---|---|---|
| ユーザー・組織 | `users` `tenants` `departments` `userDepartments` `jobCategories` | そのまま | なし |
| 認証 | ローカル認証 + OAuth ホワイトリスト、JWT、bcrypt | そのまま（§S-3 の修正は必要） | 失効機構 |
| API 基盤 | tRPC v11 + zod + superjson、6 段のミドルウェア | そのまま踏襲 | 機微区分用の新ミドルウェア |
| **監査ログ** | `auditLogs` + `audit()` ヘルパー + 閲覧画面 | そのまま + 追記専用化 | READ 監査、old/new 差分 |
| **通知 4 チャネル** | アプリ内 / Web Push / LINE / メール、`notificationSettings` | そのまま | なし |
| **承認通知** | `approvalNotifier.notifyApprovalResult()` | **そのまま呼ぶだけ** | なし |
| **承認フロー** | `leaveRequests` `overtimeRequests` `transportExpenses` `timecardCorrections` `purchaseOrders` の pending/approved/rejected パターン、`Applications.tsx` のタブ集約 UI | パターンを踏襲 | 汎用化 |
| **カレンダー** | `calendarEvents` + 繰り返し + 事前通知 | Work Item の期限をカレンダーに載せる | 連携 1 箇所 |
| **繰り返し** | `lib/recurrence.ts`、`shiftRecurrenceRules` | Routine Checklist の生成に流用 | なし |
| **リソース単位権限** | `calendarCategoryPermissions`（categoryId × userId × canView/canEdit） | **権限モデルの雛形として最重要** | Operations 版を新規作成 |
| **ファイル** | `documents` / チャンクアップロード / 圧縮 / 容量管理 | 成果物の添付にそのまま | 署名付き URL 化 |
| **フォルダロック** | `documentFolders.passwordHash` | 機微書類の隔離に流用可 | なし |
| UI | shadcn/ui 25 種、Tailwind 4、dnd-kit、recharts、sonner | そのまま | なし |
| PWA | `manifest.json` / `sw.js` / インストール誘導 / iOS 対策 | そのまま | なし |
| 国際化 | i18next（ja/en） | 新規文言を追加 | 文言のみ |
| **テナント別メニュー** | `menuConfig` v2（ロール × メニューキーの表示制御） | Operations メニューを登録 | キー追加のみ |
| **CSV 取込** | `CsvBulkImport.tsx` / `bulkImport` ルーター / `papaparse` | 既存業務の一括移行に流用 | なし |
| **CSV 出力** | `lib/csvExport.ts` | レポート出力に流用 | なし |
| テスト | vitest 56 ファイル / 880 ケース、`tenant-isolation.test.ts` の書式 | 同じ書式で追加 | Operations 用テスト |
| マイグレーション | drizzle-kit（68 本の実績） | そのまま | 追加分のみ |

**再利用しないもの**: `tasks` テーブル（§1-11 の理由）、`ROLE_HIERARCHY` の 1 次元階層（§4 で拡張）。

---

## 3. 追加 DB スキーマ

既存 `drizzle/schema.ts` の記法（`mysqlTable` / `mysqlEnum` / `index` / `uniqueIndex`）に合わせます。**既存テーブルは一切変更しません。**

> MySQL 8 は `CHECK` 制約を実際に強制します（MySQL 5.7 は無視）。TiDB も 6.5 以降で対応。**必須設計を DB 側で担保できるかは TiDB のバージョン確認が前提条件**です（§10 の事前確認事項）。強制できない場合は、後述のアプリ層 2 重ガード＋整合性チェックのバッチで代替します。

```ts
// ─── Operations: Work Items ───
export const workItems = mysqlTable("workItems", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull(),
  seq: int("seq").notNull(),                    // テナント内通番（OPS-000123 表示用）

  type: mysqlEnum("workItemType", [
    "task", "decision", "review", "incident", "routine_checklist",
    "project_milestone", "handover", "system_account",
    "recruitment", "procurement",
  ]).notNull(),

  title: varchar("title", { length: 500 }).notNull(),
  body: text("body"),

  // 必須設計①: 主担当者は必ず 1 名（nullable にしない）
  assigneeId: int("assigneeId").notNull(),
  requesterId: int("requesterId").notNull(),
  departmentId: int("departmentId").notNull(),

  // 必須設計②: 期限と完了条件を必須化
  dueAt: timestamp("dueAt").notNull(),
  doneCriteria: text("doneCriteria").notNull(),

  status: mysqlEnum("workItemStatus", [
    "open", "in_progress", "waiting_decision", "waiting_other", "done", "cancelled",
  ]).default("open").notNull(),
  priority: mysqlEnum("workItemPriority", ["urgent", "high", "normal", "low"])
    .default("normal").notNull(),

  // 必須設計③: 対応中なら次の行動と次回更新日が必須
  nextAction: text("nextAction"),
  nextUpdateAt: timestamp("nextUpdateAt"),

  // 必須設計⑦: 医療情報・人事情報の分離
  sensitivity: mysqlEnum("workItemSensitivity", ["general", "medical", "hr"])
    .default("general").notNull(),

  completedAt: timestamp("completedAt"),
  version: int("version").default(1).notNull(),  // 楽観ロック
  createdById: int("createdById").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => [
  uniqueIndex("wi_tenant_seq_idx").on(t.tenantId, t.seq),
  index("wi_assignee_idx").on(t.tenantId, t.assigneeId, t.status, t.dueAt),
  index("wi_dept_idx").on(t.tenantId, t.departmentId, t.status),
  index("wi_stale_idx").on(t.tenantId, t.nextUpdateAt),
  index("wi_inbox_idx").on(t.tenantId, t.status, t.createdAt),
  index("wi_sensitivity_idx").on(t.tenantId, t.sensitivity),
]);
```

対応する SQL 側の制約（マイグレーションに手書きで追加）:

```sql
ALTER TABLE workItems
  ADD CONSTRAINT wi_progress_requires_next CHECK (
    status NOT IN ('in_progress','waiting_other')
    OR (nextAction IS NOT NULL AND TRIM(nextAction) <> '' AND nextUpdateAt IS NOT NULL)
  ),
  ADD CONSTRAINT wi_done_requires_completed CHECK (
    (status = 'done') = (completedAt IS NOT NULL)
  ),
  ADD CONSTRAINT wi_done_criteria_not_blank CHECK (TRIM(doneCriteria) <> '');
```

```ts
// 型固有の属性（型ごとに zod スキーマで検証してから格納）
export const workItemDetails = mysqlTable("workItemDetails", {
  workItemId: int("workItemId").primaryKey(),
  data: json("data").$type<Record<string, any>>().notNull(),
});

// 共同作業者・ウォッチャー（主担当は workItems.assigneeId のみ。ここには入れない）
export const workItemWatchers = mysqlTable("workItemWatchers", {
  id: int("id").autoincrement().primaryKey(),
  workItemId: int("workItemId").notNull(),
  userId: int("userId").notNull(),
  kind: mysqlEnum("watcherKind", ["collaborator", "watcher"]).notNull(),
}, (t) => [uniqueIndex("wi_watcher_idx").on(t.workItemId, t.userId)]);

// 関連（Milestone ⊃ Task など）
export const workItemLinks = mysqlTable("workItemLinks", {
  id: int("id").autoincrement().primaryKey(),
  fromId: int("fromId").notNull(),
  toId: int("toId").notNull(),
  kind: mysqlEnum("linkKind", ["parent", "blocks", "relates", "duplicates"]).notNull(),
}, (t) => [uniqueIndex("wi_link_idx").on(t.fromId, t.toId, t.kind)]);

// ─── 必須設計⑤: 全変更履歴（追記専用）───
// calendarAuditLogs と同じく old/new を保持する。日報・週報・月報はここから生成する。
export const workItemEvents = mysqlTable("workItemEvents", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull(),
  workItemId: int("workItemId").notNull(),
  actorId: int("actorId").notNull(),
  actorName: varchar("actorName", { length: 255 }).notNull(),  // 非正規化（退職後も参照可）
  kind: mysqlEnum("eventKind", [
    "created", "progress_update", "status_changed", "assignee_changed",
    "due_changed", "comment", "attachment_added", "attachment_removed",
    "approval_requested", "approved", "rejected", "deferred",
    "handed_over", "handover_accepted", "checklist_run", "reopened", "cancelled",
  ]).notNull(),
  changes: text("changes"),          // JSON: { field: { old, new } }
  comment: text("comment"),
  occurredAt: timestamp("occurredAt").defaultNow().notNull(),
}, (t) => [
  index("wie_item_idx").on(t.workItemId, t.occurredAt),
  index("wie_report_idx").on(t.tenantId, t.occurredAt, t.actorId),
]);

// ─── 必須設計④: 経営判断待ち Inbox ───
export const workItemApprovals = mysqlTable("workItemApprovals", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull(),
  workItemId: int("workItemId").notNull(),
  requestedById: int("requestedById").notNull(),
  approverId: int("approverId").notNull(),        // 承認者も 1 名に固定
  question: text("question").notNull(),           // 何を判断してほしいか
  options: json("options").$type<{ label: string; impact: string }[]>(),
  recommended: text("recommended"),               // 起案者の推奨案
  deadlineAt: timestamp("deadlineAt").notNull(),
  decision: mysqlEnum("approvalDecision", ["approved", "rejected", "deferred"]),
  decisionNote: text("decisionNote"),
  decidedById: int("decidedById"),
  decidedAt: timestamp("decidedAt"),
}, (t) => [
  index("wia_pending_idx").on(t.tenantId, t.approverId, t.deadlineAt),
]);

// ─── 定型チェックリスト ───
export const checklistTemplates = mysqlTable("checklistTemplates", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  departmentId: int("departmentId").notNull(),
  cadence: mysqlEnum("cadence", ["daily", "weekly", "monthly", "quarterly", "yearly"]).notNull(),
  items: json("items").$type<{ key: string; label: string; requiresNote: boolean; requiresPhoto: boolean }[]>().notNull(),
  defaultAssigneeId: int("defaultAssigneeId"),
  isActive: boolean("isActive").default(true).notNull(),
});

export const checklistRuns = mysqlTable("checklistRuns", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull(),
  templateId: int("templateId").notNull(),
  workItemId: int("workItemId").notNull(),
  periodKey: varchar("periodKey", { length: 16 }).notNull(),  // 2026-07-28 / 2026-W30 / 2026-07
  results: json("results").$type<Record<string, { checked: boolean; note?: string }>>(),
}, (t) => [uniqueIndex("clr_period_idx").on(t.templateId, t.periodKey)]);  // 二重生成防止

// ─── 引継ぎ ───
export const workItemHandovers = mysqlTable("workItemHandovers", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull(),
  workItemId: int("workItemId").notNull(),
  fromUserId: int("fromUserId").notNull(),
  toUserId: int("toUserId").notNull(),
  effectiveAt: timestamp("effectiveAt").notNull(),
  scopeNote: text("scopeNote").notNull(),
  acceptedAt: timestamp("acceptedAt"),        // 受け手の受領確認まで完了扱いにしない
  acceptedNote: text("acceptedNote"),
});

// ─── 必須設計⑧: System/Account 台帳（パスワード列を作らない）───
export const opsSystemAccounts = mysqlTable("opsSystemAccounts", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull(),
  workItemId: int("workItemId").notNull(),
  systemName: varchar("systemName", { length: 255 }).notNull(),
  vendor: varchar("vendor", { length: 255 }),
  accountLabel: varchar("accountLabel", { length: 255 }).notNull(),
  secretRef: varchar("secretRef", { length: 500 }),   // パスワードマネージャの項目 URL/ID のみ
  ownerUserId: int("ownerUserId").notNull(),
  mfaStatus: mysqlEnum("mfaStatus", ["enabled", "disabled", "not_supported"]),
  renewalAt: varchar("renewalAt", { length: 10 }),
  monthlyCostJpy: int("monthlyCostJpy"),
});
// ※ secretRef にはパスワード・API キーの値を入れない。保存前に検出して拒否する（§9 R6）。

// ─── 添付（既存 documents とは別。Work Item 直付け）───
export const workItemAttachments = mysqlTable("workItemAttachments", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull(),
  workItemId: int("workItemId").notNull(),
  fileKey: text("fileKey").notNull(),          // 永続 URL ではなくキーを保存 → 都度署名付き URL を発行
  fileName: varchar("fileName", { length: 255 }).notNull(),
  mimeType: varchar("mimeType", { length: 100 }),
  fileSize: int("fileSize"),
  sensitivity: mysqlEnum("attachmentSensitivity", ["general", "medical", "hr"])
    .default("general").notNull(),
  uploadedById: int("uploadedById").notNull(),
  uploadedAt: timestamp("uploadedAt").defaultNow().notNull(),
});

// ─── レポート確定版（イベント列から決定論的に生成）───
export const opsReportSnapshots = mysqlTable("opsReportSnapshots", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull(),
  kind: mysqlEnum("reportKind", ["daily", "weekly", "monthly"]).notNull(),
  periodKey: varchar("periodKey", { length: 16 }).notNull(),
  scopeKind: mysqlEnum("scopeKind", ["user", "department", "tenant"]).notNull(),
  scopeId: int("scopeId"),
  payload: json("payload").notNull(),
  generatedAt: timestamp("generatedAt").defaultNow().notNull(),
}, (t) => [uniqueIndex("ors_idx").on(t.tenantId, t.kind, t.periodKey, t.scopeKind, t.scopeId)]);

// ─── 権限付与（calendarCategoryPermissions と同型）───
export const opsPermissions = mysqlTable("opsPermissions", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull(),
  userId: int("userId").notNull(),
  capability: mysqlEnum("opsCapability", [
    "ops_admin",        // Operations の設定管理
    "ops_executive",    // 経営判断 Inbox の名宛人
    "ops_dept_manager", // 部署スコープの管理
    "ops_hr",           // sensitivity='hr' の閲覧・編集
    "ops_medical",      // sensitivity='medical' の閲覧・編集
    "ops_auditor",      // 全件読み取り + 監査ログ
  ]).notNull(),
  scopeDepartmentId: int("scopeDepartmentId"),   // null = テナント全体
  grantedById: int("grantedById").notNull(),
  grantedAt: timestamp("grantedAt").defaultNow().notNull(),
}, (t) => [
  uniqueIndex("opsperm_idx").on(t.tenantId, t.userId, t.capability, t.scopeDepartmentId),
]);
```

### 必須設計との対応表

| 必須設計 | 実現手段 |
|---|---|
| 主担当者 1 名 | `assigneeId` を `notNull` の単一列に。共同担当は `workItemWatchers` へ分離 |
| 期限と完了条件を必須化 | `dueAt` / `doneCriteria` を `notNull` + 空白禁止の `CHECK` |
| 対応中は次の行動と次回更新日を必須 | `CHECK wi_progress_requires_next` + アプリ層の zod による 2 重ガード |
| 日報・週報・月報を更新履歴から自動生成 | `workItemEvents` を期間・スコープで SQL 集計 → `opsReportSnapshots`。**LLM は使わない** |
| 経営判断待ちを専用 Inbox に表示 | `status='waiting_decision'` + `workItemApprovals`（未決）。`wia_pending_idx` で高速化 |
| 全変更履歴を保存 | `workItemEvents`（old/new 差分、追記専用、actorName を非正規化） |
| 医療情報と人事情報の権限分離 | `sensitivity` 列 + `opsPermissions` の capability + 閲覧の監査記録（§4） |
| パスワード・秘密情報を本文に保存しない | `opsSystemAccounts` にパスワード列を設けず `secretRef` のみ + 保存時の検出（§9 R6） |
| スマホで 30 秒以内に進捗更新 | 更新対象を 4 項目に限定した専用 API 1 発（§6）+ 既存 PWA |
| AI による人格評価・自動人事評価を行わない | レポート生成は SQL 集計のみ。評価スコア列を作らない。既存 AI コンシェルジュに Operations データを渡さない（§9 R11） |

---

## 4. 権限マトリクス

### 4-1. 設計方針: 既存 `appRole` に「能力（capability）」を直交させる

既存の `ROLE_HIERARCHY` は一直線で職務分離を表現できません（§1-4）。既存ロールを壊さずに要件を満たすため、**既存の `appRole` を「基本権限」として残したまま、`opsPermissions` による capability を直交軸として追加**します。

```
実効権限 = f( appRole（既存・階層）, opsPermissions（新規・直交）, sensitivity, 担当関係 )
```

これにより既存の全画面・全テスト（880 ケース）は無変更で動き続けます。

### 4-2. 操作 × 主体（一般案件 `sensitivity='general'`）

| 操作 | TenantAdmin | ops_executive | ops_dept_manager | Manager | Staff | ops_auditor | Viewer |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| 案件作成 | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ |
| 自分の担当案件を閲覧 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 他人の案件を閲覧 | ✓ | ✓ | 自部署 | 自部署 | ウォッチ分のみ | ✓ | ✗ |
| 進捗更新（次アクション等） | ✓ | ✓ | 自部署 | 自部署 | 自担当のみ | ✗ | ✗ |
| 担当者の変更 | ✓ | ✓ | 自部署 | 自部署 | ✗ | ✗ | ✗ |
| 期限・完了条件の変更 | ✓ | ✓ | 自部署 | 自部署 | 自担当（履歴必須） | ✗ | ✗ |
| 承認依頼の起票 | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ |
| **承認・却下** | ✗ ※1 | ✓ | 自部署案件 | ✗ | ✗ | ✗ | ✗ |
| 経営判断 Inbox の閲覧 | ✗ | ✓ | 自部署の起票分 | 自分の起票分 | 自分の起票分 | ✓ | ✗ |
| 案件のクローズ | ✓ | ✓ | 自部署 | 自部署 | 自担当 | ✗ | ✗ |
| **案件の削除** | ✗ ※2 | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| CSV エクスポート | ✓ | ✓ | 自部署 | ✗ | ✗ | ✓ | ✗ |
| Operations の設定管理 | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| 監査ログ閲覧 | ✗ ※3 | ✓ | ✗ | ✗ | ✗ | ✓ | ✗ |

※1 権限を付与できる者が承認もできると相互牽制が働かないため、承認は `ops_executive` に限定します。両方必要な人には両方を明示付与します。
※2 **削除は全主体で不可**。取り消しは `status='cancelled'`（履歴が残る論理取消）。
※3 システムを運用できることと、記録を読めることを分離します。

### 4-3. 機微区分 × 主体（閲覧可否）

| 区分 | TenantAdmin | ops_executive | ops_dept_manager | ops_hr | ops_medical | ops_auditor | Staff |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `general` | ✓ | ✓ | 自部署 | ✓ | ✓ | ✓ | 自担当/ウォッチ |
| `hr`（人事・採用） | **✗** | ✓ | **✗** | ✓ | **✗** | ✓（記録あり） | 自担当のみ |
| `medical`（医療情報） | **✗** | **✗** | **✗** | **✗** | ✓ | ✓（記録あり） | 自担当のみ |

要点:

- **`TenantAdmin` は機微情報を読めません。** これは既存の一直線階層からの明確な変更点であり、Operations の必須要件（医療情報と人事情報の権限分離）を満たすための中核です
- **`ops_executive` も医療情報は既定で読めません。** 必要なら `ops_medical` を明示付与します
- 機微案件の閲覧は `auditLogs` に `READ` として記録します（既存の `action` enum に `READ` は定義済みで、ようやく本来の用途で使われます）
- 機微区分は作成後に**下げられません**（`medical` → `general` を禁止）。上げる方向のみ許可し、変更は履歴に残します

### 4-4. 実装方式

権限判定は `server/ops/permissions.ts` の**単一の純粋関数**に集約します。

```ts
export function canOps(
  actor: { userId: number; tenantId: number; appRole: AppRole;
           capabilities: OpsCapability[]; departmentIds: number[] },
  action: OpsAction,
  resource: { departmentId: number; assigneeId: number; requesterId: number;
              sensitivity: Sensitivity; watcherIds: number[] }
): { allowed: boolean; reason?: string }
```

- tRPC のミドルウェア・画面・エクスポートのすべてがこの 1 関数を経由する
- §4-2 / §4-3 の表を**そのままテーブル駆動テストの入力**にする（§8 T6）
- 既存の `staffProcedure` / `managerProcedure` / `adminProcedure` は変更せず、Operations 専用に `opsProcedure` を追加する

---

## 5. 画面構成

既存の `DashboardLayout` + shadcn/ui + i18next をそのまま使い、`client/src/pages/ops/` 配下に追加します。メニューは `shared/menuConfig.ts` の `DEFAULT_MENU_ORDER` に `nav.ops*` キーを追加し、**テナント単位・ロール単位で表示制御**できるようにします（既存の menuConfig v2 の仕組みをそのまま利用）。

| パス | 画面 | 対象 | 内容 |
|---|---|---|---|
| `/ops` | マイダッシュボード | 全員 | 「今日やること」「期限超過」「更新期限切れ（`nextUpdateAt` 経過）」「自分待ちの承認」の 4 ブロック |
| `/ops/inbox` | **経営判断 Inbox** | `ops_executive` | 未決の承認依頼を期限順に。1 件 = 論点・選択肢と各案の影響・推奨案・期限。その場で承認/却下/保留（理由必須） |
| `/ops/items` | 案件一覧 | 全員 | 部署 / 型 / 状態 / 担当 / 期限 / 機微区分でフィルタ。保存ビュー。権限で自動絞り込み |
| `/ops/items/new` | 新規作成 | 全員 | 型を選ぶと必須項目（期限・完了条件）が出る。型別項目は動的フォーム（`react-hook-form` + zod） |
| `/ops/items/:id` | 案件詳細 | 権限に応じ | ヘッダ（担当1名・期限・完了条件・状態）／進捗更新／**全履歴タイムライン**／添付／承認／引継ぎ |
| `/ops/checklists` | 定型チェックリスト | 担当部署 | 本日・今週の実施分。1 タップでチェック |
| `/ops/reports` | 日報・週報・月報 | 本人・上長・executive | 期間とスコープを選ぶと履歴から自動生成。人手の記入欄は「所感」1 つだけ |
| `/ops/admin/permissions` | Operations 権限管理 | TenantAdmin / executive | capability の付与・剥奪。`calendarCategoryPermissions` の管理 UI を踏襲 |
| `/ops/admin/templates` | チェックリスト定義 | TenantAdmin / dept_manager | |
| `/ops/admin/audit` | Operations 監査ログ | auditor / executive | 既存 `AdminAuditLogs.tsx` を Operations 用にフィルタ |

### スマホ 30 秒更新の設計（必須要件）

既存 PWA にそのまま乗るため、**新しいインストール手順は不要**です。

```
① 通知（Web Push / LINE）から該当案件を開く   … 1 タップ
② 状態を選ぶ（対応中 / 判断待ち / 完了）        … 1 タップ
③ 次の行動を入れる                             … 定型候補から選択 or 音声入力
④ 次回更新日を選ぶ（今日 / 明日 / 今週末 / 日付）… 1 タップ
   →「更新」                                    … 1 タップ
```

- 入力欄は 4 つに限定（`status` / `nextAction` / `nextUpdateAt` / 一言コメント）。それ以外は詳細画面へ退避
- **音声入力は既存の `VoiceRecorder.tsx` + `voiceTranscription.ts` を流用可能**（ただし機微案件では外部送信の可否を要判断。§9 R7）
- タップ領域 44px 以上、操作系は画面下部（既存 `vaul` ドロワーを使用）
- オフライン時はローカルキューに積み、復帰時に**冪等キー付き**で再送

---

## 6. API 構成

既存の tRPC 規約（zod 検証 / `TRPCError` / 日本語メッセージ / `audit()` 呼び出し）を踏襲し、`appRouter` に `ops` を 1 つ追加します。

```ts
// server/routers.ts — 追加は 1 行
export const appRouter = router({
  system: systemRouter,
  auth: router({ ... }),
  // ... 既存 90 ルーター（無変更）
  ops: opsRouter,        // ← これだけ
});
```

`server/ops/router.ts` の構成:

| プロシージャ | 用途 | 権限 |
|---|---|---|
| `ops.items.list` | 一覧（フィルタ・カーソルページング）。権限で自動絞り込み | `opsProcedure` |
| `ops.items.create` | 作成。型別 zod スキーマで検証。必須 4 項目を強制 | `opsProcedure` |
| `ops.items.getById` | 詳細（履歴・添付・承認を含む）。機微なら `READ` 監査 | `canOps(read)` |
| `ops.items.update` | 一般編集（`version` 必須、不一致は 409 相当） | `canOps(update)` |
| **`ops.items.updateProgress`** | **30 秒更新専用**。`{ id, version, status, nextAction, nextUpdateAt, comment?, idempotencyKey }` のみ | `canOps(update)` |
| `ops.items.cancel` | 論理取消（削除は提供しない） | `canOps(update)` |
| `ops.items.events` | 変更履歴 | `canOps(read)` |
| `ops.handover.request` / `.accept` | 引継ぎ起票 / 受領確認 | 担当者 / 受け手本人 |
| `ops.attachments.getUploadUrl` / `.getDownloadUrl` | 署名付き URL 発行（短命）。発行を監査記録 | `canOps(read/update)` |
| `ops.approvals.request` | 承認依頼（案件を `waiting_decision` へ） | `opsProcedure` |
| `ops.approvals.decide` | 承認・却下・保留（理由必須）→ `approvalNotifier` で 3 チャネル通知 | 承認者本人 |
| `ops.inbox.list` | 経営判断待ち一覧 | `ops_executive` / 起票者 |
| `ops.checklists.today` / `.complete` | 本日実施分 / 結果記録 | 担当者 |
| `ops.reports.get` | 日報/週報/月報（未生成なら即時生成） | 本人・上長・executive |
| `ops.permissions.list` / `.grant` / `.revoke` | capability 管理 | TenantAdmin / executive |
| `ops.export.csv` | CSV 出力（件数上限・機微除外・監査記録） | §4-2 準拠 |

`/api/scheduled/opsDaily`（Heartbeat）で日次バッチを実行:
- 更新期限切れ（`nextUpdateAt < now`）の担当者へ通知
- 期限接近の通知
- 定型チェックリストの当日分を生成
- 日報スナップショットの確定

> ⚠️ **`setInterval` / `node-cron` は使わないこと。** `references/periodic-updates.md` の規約どおり Heartbeat を使います（既存の `startLabWorkReminderScheduler()` はこの規約に反しているため、Operations では繰り返さない）。

**共通規約**:
- **冪等性** — 進捗更新は `idempotencyKey` を受け取り、モバイルの再送で履歴が重複しないようにする
- **楽観ロック** — 更新系は `version` 必須。不一致は競合として画面で差分提示
- **エラー本文に機微情報を含めない** — 権限エラーは理由を統一（存在推測の防止）
- **全ミューテーションで `workItemEvents` に記録**し、機微閲覧は `auditLogs` に `READ` で記録

---

## 7. 移行方法

既存機能を**一度も止めずに**段階移行します。

### Step 0. 緊急対応（Operations 着手前）

§0 の S-1（認証情報のローテーション）を完了させます。これは Operations とは独立して**今すぐ**必要です。

### Step 1. 認証の穴を塞ぐ（1 週間・Operations の前提条件）

1. `sdk.authenticateRequest()` に `isActive` / `employmentStatus === 'active'` の検査を追加
2. JWT に `sessionVer` を載せ、`users` に `sessionVer` 列を追加。無効化・退職処理で +1 して**即時失効**
3. セッション TTL を 1 年 → 妥当な期間（例: 30 日 + スライディング更新）に短縮
4. `localAuth.login` にレート制限を追加（IP + メール単位、既存 DB か軽量なメモリ実装）
5. ログイン成功・失敗を `auditLogs` に記録（`LOGIN` enum を本来の用途で使う）

**この Step だけで、既存アプリのセキュリティが実質的に改善します。** Operations の有無に関わらず価値があります。

### Step 2. 機微データの保護（1.5 週間）

1. `onboardingForms` のマイナンバー・年金番号・口座番号を**アプリ層で暗号化**（鍵は環境変数、KMS があればそちら）。既存レコードは移行スクリプトで暗号化
2. マイナンバーの閲覧を専用 capability に限定し、**閲覧を監査記録**
3. 患者データのルーターを `tenantProcedure` → `staffProcedure` 以上へ引き上げ、将来的に `ops_medical` 相当へ
4. 添付ファイルの永続 URL を段階的に**キー保存 + 都度署名付き URL**へ移行

### Step 3. Operations の骨格投入（フラグ OFF）

- `drizzle/schema.ts` にテーブル追記 → `0068_*` マイグレーション生成・適用（追加のみ、破壊的変更なし）
- `server/ops/` と `client/src/pages/ops/` を追加。`tenants.settings.opsEnabled !== true` なら 404
- この時点で本番デプロイしても、利用者からは何も見えません

### Step 4. パイロット運用（1 テナント・1 部署）

- 総務または社長室で `opsEnabled = true`。2 週間、既存運用（口頭・LINE・スプレッドシート）と**並行**
- 移行するのは**進行中の案件のみ**。過去案件は移行しない（履歴の正確性を担保できないため）
- 既存スプレッドシートからの取り込みは既存の `CsvBulkImport` を流用。取り込み時は全件 `created` イベントを記録し、出典を残す

### Step 5. 全部署・全テナント展開

- 部署ごとに 1〜2 週間ずつ。チェックリスト定義と capability 付与を部署単位で実施
- 「今日から Hub 以外で指示を出さない」という運用ルールの明文化が成否を分けます

### Step 6. 既存 `tasks` との関係整理

- 当面は**併存**（既存タスクは既存画面のまま）
- 定着後、`tasks` を読み取り専用にして `workItems` へ一本化するか、`tasks` を「Operations 以前の軽量タスク」として残すかを判断
- `tasks` → `workItems` の移行時は、期限・完了条件が欠けているレコードに既定値を補完する必要があるため、**移行は任意（オプトイン）**とします

**ロールバック**: 各 Step は `opsEnabled = false` で即座に無効化できます。マイグレーションは前方互換（列・テーブルの追加のみ）を守ります。

---

## 8. テスト計画

既存の vitest 基盤（56 ファイル / 880 ケース）にそのまま追加します。**新規のテスト基盤構築は不要**です。

### 8-1. 追加するもの

| 層 | 対象 |
|---|---|
| 単体 | `canOps()`、必須制約バリデータ、レポート集計、秘密情報検出、冪等キー処理 |
| DB 統合 | `CHECK` 制約の実挙動（TiDB で強制されるかの確認を含む）、追記専用性、UNIQUE による二重生成防止 |
| API 統合 | 認可・楽観ロック・監査記録・通知配信（既存 `tenant-isolation.test.ts` の書式を踏襲） |
| **CI（新規）** | `pnpm check`（型）+ `pnpm test` の自動実行。現在 CI がないため、これは新規構築 |

E2E（Playwright）は Phase 3 のモバイル要件検証に限って導入を検討します。

### 8-2. 必ず自動テストで守る項目

| # | テスト内容 | 種別 |
|---|---|---|
| T1 | 主担当を空 or 2 名にする作成が失敗する | API |
| T2 | 期限なし / 完了条件なしの作成が失敗する（API 層と DB 層の両方） | API + DB |
| T3 | `status='in_progress'` で `nextAction` / `nextUpdateAt` が空だと拒否される | DB + API |
| T4 | `workItemEvents` に対する UPDATE / DELETE の経路が存在しない | 静的 + DB |
| T5 | 案件を更新すると必ず対応するイベントが 1 件増え、old/new が両方入る | API |
| T6 | §4-2 / §4-3 の表を**そのまま展開した全組み合わせ**で `canOps()` を検証 | 単体 |
| T7 | `TenantAdmin` が `hr` / `medical` 案件を**一覧・詳細・検索・エクスポートのいずれの経路でも**取得できない | API |
| T8 | 機微案件の閲覧が `auditLogs` に `READ` として記録される | API |
| T9 | パスワードらしき文字列を本文・`secretRef` に入れると拒否される | 単体 + API |
| T10 | 日報が同じイベント列から**常に同じ結果**を返し、**LLM を呼ばない**（モックで検証） | 単体 |
| T11 | **無効化・退職したユーザーの既存セッションが即座に弾かれる**（Step 1 の検証） | API |
| T12 | 同一 `idempotencyKey` の進捗更新を 2 回送っても履歴が 1 件 | API |
| T13 | `version` 不一致の更新が拒否され、データが壊れない | API |
| T14 | Operations の全プロシージャがテナント境界を越えない（既存 `tenant-isolation.test.ts` の Operations 版） | API |
| T15 | 添付のダウンロード URL が短命で、権限のない利用者が発行できない | API |
| T16 | `sensitivity` を `medical` → `general` に下げられない | API |

### 8-3. 既存機能への回帰確認

Operations 追加後、既存の 880 ケースが**全件パスすること**をマージ条件にします。`appRouter` への 1 行追加と schema への追記が既存に影響しないことの担保です。

---

## 9. セキュリティ上のリスク

深刻度 — **緊急 = 即日 / 高 = Operations 着手前 / 中 = Phase 内 / 低 = 継続管理**

| # | リスク | 深刻度 | 根拠（実コード） | 対策 |
|---|---|:-:|---|---|
| R1 | **本番の `JWT_SECRET`・DB 接続文字列・VAPID 秘密鍵・API キーが平文で配布物に含まれていた** | **緊急** | `.project-config.json` | §0 S-1 のローテーション手順。今後この種のファイルを共有しない運用ルール |
| R2 | **マイナンバー・年金番号・銀行口座が平文保存**（コメントは "encrypted at app level" だが実装なし） | **高** | `onboardingForms`、`crypto` 使用箇所は HMAC とトークン生成のみ | アプリ層暗号化 + 閲覧を専用 capability に限定 + 閲覧の監査記録（Step 2） |
| R3 | **無効化・退職ユーザーがアクセスし続けられる**（JWT 1 年・失効機構なし・`isActive` 未検査） | **高** | `sdk.authenticateRequest()`、`ONE_YEAR_MS` | `sessionVer` 方式で即時失効 + TTL 短縮 + 認証時の状態検査（Step 1、T11） |
| R4 | **患者の医療情報を全ロール（Viewer 含む）が閲覧できる** | **高** | `orthodonticPatients` / `invisalign` / `lingual` / `patientVideos` / `phoneCallRecords` が `tenantProcedure` | 権限引き上げ + `ops_medical` capability + 閲覧監査（Step 2） |
| R5 | **職務分離が構造的に不可能**（`ROLE_HIERARCHY` が一直線） | **高** | `shared/types.ts` | `opsPermissions` による直交 capability（§4-1）。既存ロールは変更しない |
| R6 | **秘密情報の本文混入** — System/Account 運用で担当者が本文にパスワードを貼る事故は高頻度 | **高** | 新規リスク | パスワード列を作らない + 保存時に既知パターン（`password:` `api[_-]?key` `-----BEGIN` `sk-` 等）と高エントロピー文字列を検出して拒否（T9） |
| R7 | **AI コンシェルジュが投稿・記事・タスクの本文を外部 LLM へ送信している** | 中 | `ai.chat` が `getAiContext()` の内容を system prompt に埋め込み `invokeLLM` へ | Operations データを AI の文脈に**入れない**。既存の投稿についても、患者情報を含む可能性を踏まえ送信範囲の見直しを推奨 |
| R8 | **監査ログの欠落と改ざん可能性** — READ 未記録、勤怠・書類・患者・人事が対象外、`details` に変更前がない、アプリから UPDATE/DELETE 可能 | 中 | `audit()` 82 箇所の分布 | Operations では old/new 記録 + 追記専用 + 機微 READ 記録。既存分は段階的に補完 |
| R9 | **ログインのブルートフォース耐性なし** | 中 | `localAuth.login` にレート制限なし | IP + アカウント単位のレート制限 + 失敗の監査記録（Step 1） |
| R10 | **添付ファイルの永続 URL** — `storagePut()` の戻り URL を DB に保存し配布。履歴書・資格証明書・患者動画を含む | 中 | `documents.fileUrl`、`onboardingForms.resumeFiles[].url` | **要検証**: 当該 URL が未認証で取得可能かを実測。可能なら短命署名付き URL へ移行（Step 2） |
| R11 | **AI による人格評価・自動人事評価の混入** | 中 | 現状 `staffEvaluations` は人手入力（rating 1-5 + コメント）で AI 不使用＝要件充足。ただし `getStaffContributionSummary()` の活動集計が評価入力に使われる余地あり | ①レポート生成は SQL 集計のみで LLM を呼ばない（T10）②評価スコア列を Operations に作らない ③活動集計は「事実の提示」に留め、スコア化・順位付けを行わない ④コードレビューのチェック項目として明文化 |
| R12 | **通知経由の情報漏えい** — ロック画面のプッシュ通知や LINE に患者情報・人事情報が出る | 中 | `pushService` / `lineMessaging` が `title` + `body` をそのまま送信 | Operations の通知本文は識別子のみ（例: 「案件 OPS-000123 の更新期限です」）。内容はアプリを開いて認証後に表示 |
| R13 | **同名 `adminProcedure` の併存** — `_core/trpc.ts`（`users.role==='admin'`）と `routers.ts`（`appRole`）で意味が異なる | 中 | 両ファイル | Operations では独自の `opsProcedure` を使い混同を避ける。既存分は改名を推奨 |
| R14 | **CI がなく品質ゲートが手動のみ** | 中 | `.github/` なし | 型チェック + 880 ケース + Operations テストの自動実行。T6・T7 の失敗をマージブロック条件に |
| R15 | **`startLabWorkReminderScheduler()` がプロセス内タイマー** — Cloud Run のアイドル終了で停止しうる | 低 | `_core/index.ts`、`references/periodic-updates.md` の禁止事項に該当 | Operations は Heartbeat（`/api/scheduled/*`）で実装。既存分も移行を推奨 |
| R16 | **依存関係の脆弱性管理がない** | 低 | Dependabot 等なし | `pnpm audit` の定期実行 |
| R17 | **一括エクスポートによる大量持ち出し** | 低 | 新規リスク | 件数上限・機微区分の既定除外・実行の監査記録 |

**個人情報保護法・番号法上の留意**: 採用・人事情報は個人情報、患者の診療情報は**要配慮個人情報**、マイナンバーは**特定個人情報**であり、それぞれ求められる安全管理措置の水準が異なります。本設計は「区分ごとにアクセスを分離し、閲覧を記録する」方針ですが、保存項目・保存期間・削除手順・開示請求対応の 4 点は実運用前に法務確認をお願いします。

---

## 10. 実装を分割した作業計画

工数は 1 名専任換算の目安です。

### Phase 0 — 緊急対応（0.5 週間 / Operations と独立）
- §0 S-1 の認証情報ローテーション（JWT_SECRET・DB パスワード・VAPID・API キー）
- DB アクセスログの点検
- 機密ファイルの共有方法に関する運用ルールの明文化
- **完了条件**: 漏えいした鍵がすべて無効化されている

### Phase 1 — 認証の是正（1 週間 / Operations の前提条件）
- `isActive` / `employmentStatus` の認証時検査、`sessionVer` による即時失効、TTL 短縮
- ログインのレート制限、ログイン成功・失敗の監査記録
- T11 を含む回帰テスト
- **完了条件**: 無効化したユーザーが即座にアクセスできなくなる

### Phase 2 — 機微データの保護（1.5 週間）
- マイナンバー・年金番号・口座番号のアプリ層暗号化と既存データ移行
- 患者データルーターの権限引き上げ
- 添付 URL の署名付き化（R10 の実測を先行）
- **完了条件**: 特定個人情報が平文で DB に存在しない

### Phase 3 — Operations 基盤（2 週間）
- `workItems` ほか 10 テーブル + マイグレーション `0068`
- `canOps()` と `opsPermissions`、権限マトリクステスト（T6・T7）
- `opsEnabled` フラグ、`/ops` スケルトン、CI 新設
- **完了条件**: 本番デプロイしても利用者に何も見えず、既存 880 ケースが全件パス

### Phase 4 — Work Item のコア（2.5 週間）
- 必須制約（T1〜T3）、変更履歴（T5）、10 型の zod スキーマと動的フォーム
- 一覧・詳細・作成・更新、楽観ロック、履歴タイムライン UI
- **完了条件**: Task / Decision / Incident の 3 型で一連の運用が回る

### Phase 5 — モバイル 30 秒更新（1 週間）
- `updateProgress` API、冪等キー、オフラインキュー（T12）
- 既存 PWA 上の専用 UI、Web Push / LINE 通知（本文は識別子のみ）
- 実機での 30 秒計測
- **完了条件**: 実機で 30 秒以内の更新が計測できる

### Phase 6 — 承認と経営判断 Inbox（1 週間）
- `workItemApprovals`、`/ops/inbox`、承認・却下・保留（理由必須）
- `approvalNotifier` による 3 チャネル通知（**既存関数をそのまま利用**）
- **完了条件**: 社長室の判断待ち案件が漏れなく Inbox に集まる

### Phase 7 — レポート自動生成（1 週間）
- イベント列からの決定論的集計、`opsReportSnapshots`、Heartbeat による定期生成
- 日報・週報・月報の画面、スコープ切替
- 決定論性・AI 非使用テスト（T10）
- **完了条件**: 手作業ゼロで日報が出る

### Phase 8 — 残る型と機微分離（2 週間）
- Routine Checklist（既存 `recurrence.ts` を流用）、Handover（受領確認まで）、System/Account（`secretRef` + 秘密検出）、Recruitment（`hr` 区分）、Procurement、Project Milestone、Review
- 添付、機微区分の閲覧監査、エクスポート制限（T8・T9・T15・T16）
- **完了条件**: 全 10 型が使え、機微分離のテストが緑

### Phase 9 — パイロットと展開（4 週間）
- 1 部署でのパイロット → 運用手順の文書化 → 部署ごとの段階展開
- **完了条件**: 全 7 部署が Hub 上で運用されている

**合計目安: 約 16.5 週間（4 ヶ月）／専任 1 名。**
うち Phase 0〜2（3 週間）は**Operations とは独立に価値がある既存アプリのセキュリティ改善**です。Operations 本体は Phase 3〜9 の約 13.5 週間。2 名体制なら Phase 4 以降を並列化して約 9 週間。

### 先に決めておくべき事項

1. **TiDB の `CHECK` 制約サポート状況** — 必須設計を DB 側で強制できるかが設計の分岐点。強制できない場合はアプリ層 2 重ガード + 整合性チェックのバッチで代替する
2. **暗号鍵の管理方法** — マイナンバー暗号化の鍵をどこに置くか（環境変数 / KMS）。Manus プラットフォームで使える選択肢の確認が必要
3. **8 つの主体を実職位へ割り当て** — 誰が `ops_executive` か、`ops_hr` は誰か、`ops_medical` は誰か
4. **Operations を全テナントに提供するか、MIRISE 自社テナント限定か** — SaaS として売るなら Stripe のプラン/アドオン設計（既存 `subscriptionAddons`）に組み込む必要がある
5. **保存期間と削除方針** — 案件・履歴・監査ログそれぞれの保存年数と削除手順（法務確認事項）
6. **既存 `tasks` の扱い** — 併存を続けるか、いずれ `workItems` へ一本化するか
