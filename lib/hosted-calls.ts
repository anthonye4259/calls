export type HostedCall = {
  id: string;
  phoneNumber: string;
  provider: "grok_bot";
  transport: "grok_bot_call_card";
  state: "queued" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
  authorizedAt: string;
  interruptionCount: number;
  transcript: Array<{ role: "agent" | "recipient"; text: string; at: string }>;
  outcome?: Record<string, unknown>;
  error?: string;
  distributorId?: string;
};

type Bindings = {
  DB: D1Database;
  GROK_BOT_WEBHOOK_URL?: string;
  GROK_BOT_AUTHORIZATION_HEADER?: string;
  GROK_BOT_DAILY_CALL_LIMIT?: string;
  GROK_BOT_PER_NUMBER_LIMIT?: string;
};

export async function bindings(): Promise<Bindings> {
  const runtime = await import("cloudflare:workers");
  return runtime.env as unknown as Bindings;
}

export async function ensureCallsTable(db: D1Database) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS calls (
      id TEXT PRIMARY KEY,
      phone_number TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      data TEXT NOT NULL
    )`),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS idx_calls_created_at ON calls(created_at)",
    ),
  ]);
}

export async function listCalls(db: D1Database): Promise<HostedCall[]> {
  await ensureCallsTable(db);
  const result = await db
    .prepare("SELECT data FROM calls ORDER BY created_at DESC LIMIT 500")
    .all<{ data: string }>();
  return result.results.map((row) => JSON.parse(row.data) as HostedCall);
}

export async function getCall(db: D1Database, id: string) {
  await ensureCallsTable(db);
  const row = await db
    .prepare("SELECT data FROM calls WHERE id = ? LIMIT 1")
    .bind(id)
    .first<{ data: string }>();
  return row ? (JSON.parse(row.data) as HostedCall) : null;
}

export async function saveCall(db: D1Database, call: HostedCall) {
  await ensureCallsTable(db);
  await db
    .prepare(`INSERT INTO calls (id, phone_number, state, created_at, updated_at, data)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        phone_number = excluded.phone_number,
        state = excluded.state,
        updated_at = excluded.updated_at,
        data = excluded.data`)
    .bind(
      call.id,
      call.phoneNumber,
      call.state,
      call.createdAt,
      call.updatedAt,
      JSON.stringify(call),
    )
    .run();
  return call;
}

export async function callsSince(db: D1Database, since: string) {
  await ensureCallsTable(db);
  const row = await db
    .prepare("SELECT COUNT(*) AS count FROM calls WHERE created_at >= ?")
    .bind(since)
    .first<{ count: number }>();
  return Number(row?.count ?? 0);
}

export async function latestCallCreatedAt(db: D1Database) {
  await ensureCallsTable(db);
  const row = await db
    .prepare("SELECT created_at FROM calls ORDER BY created_at DESC LIMIT 1")
    .first<{ created_at: string }>();
  return row?.created_at ?? null;
}

export async function callsToNumberSince(
  db: D1Database,
  phoneNumber: string,
  since: string,
) {
  await ensureCallsTable(db);
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS count FROM calls WHERE phone_number = ? AND created_at >= ?",
    )
    .bind(phoneNumber, since)
    .first<{ count: number }>();
  return Number(row?.count ?? 0);
}
