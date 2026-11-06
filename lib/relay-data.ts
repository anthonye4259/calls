import { randomUUID } from "node:crypto";
import { normalizeE164 } from "./grok-bot";

export type RelayProfile = {
  companyName: string;
  companySummary: string;
  valueProposition: string;
  defaultObjective: string;
  openingStatement: string;
  questionsToAsk: string[];
  approvedClaims: string[];
  prohibitedClaims: string[];
  agentStyle: string;
  updatedAt: string;
};

export type Distributor = {
  id: string;
  company: string;
  phoneNumber: string;
  city: string;
  state: string;
  contactName?: string;
  contactTitle?: string;
  website?: string;
  consentSource: string;
  consentTimestamp: string;
  internalNotes: string;
  status: "ready" | "research" | "completed" | "blocked";
  createdAt: string;
  updatedAt: string;
  lastCallId?: string;
  lastOutcome?: string;
  callNotes?: string;
};

const DEFAULT_PROFILE: RelayProfile = {
  companyName: "Haladir",
  companySummary:
    "Haladir is an AI logistics software company serving warehouses, independent distributors, and smaller 3PLs.",
  valueProposition:
    "Haladir integrates with warehouse management systems, transportation management systems, and ERPs to automate logistics workflows.",
  defaultObjective:
    "Identify the person responsible for warehouse operations, learn when they are available, and determine whether a brief Haladir introduction would be welcome.",
  openingStatement:
    "Hi, I'm an AI assistant calling on behalf of Haladir. Is this the warehouse or distribution office?",
  questionsToAsk: [
    "Does this location operate a warehouse or distribution facility?",
    "Who is responsible for warehouse operations?",
    "Is that person present today or later this week?",
    "Would a brief introduction from Haladir be welcome?",
    "What time is best, and is an appointment required?",
  ],
  approvedClaims: [
    "Haladir provides AI logistics software.",
    "Haladir integrates with WMS, TMS, and ERP systems.",
  ],
  prohibitedClaims: [
    "Do not promise pricing, savings, integrations, or implementation timelines that Relay did not supply.",
    "Do not claim a visit or appointment is confirmed unless the recipient explicitly confirms it.",
  ],
  agentStyle:
    "Think like a capable SDR, but keep the call familiar, friendly, and low-pressure. Be curious and concise. Listen more than you speak, respond naturally instead of reading a rigid script, and politely guide the conversation toward a useful next step.",
  updatedAt: new Date(0).toISOString(),
};

export async function ensureRelayTables(db: D1Database) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS distributors (
      id TEXT PRIMARY KEY,
      company TEXT NOT NULL,
      phone_number TEXT NOT NULL,
      state TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      data TEXT NOT NULL
    )`),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS idx_distributors_status_state ON distributors(status, state)",
    ),
    db.prepare(`CREATE TABLE IF NOT EXISTS relay_config (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
  ]);
}

export async function getRelayProfile(db: D1Database): Promise<RelayProfile> {
  await ensureRelayTables(db);
  const row = await db
    .prepare("SELECT data FROM relay_config WHERE id = 'profile'")
    .first<{ data: string }>();
  return row
    ? { ...DEFAULT_PROFILE, ...(JSON.parse(row.data) as Partial<RelayProfile>) }
    : DEFAULT_PROFILE;
}

export async function saveRelayProfile(db: D1Database, value: unknown) {
  const input = value as Partial<RelayProfile>;
  const current = await getRelayProfile(db);
  const text = (value: unknown, fallback: string) =>
    typeof value === "string" && value.trim()
      ? value.trim().slice(0, 5_000)
      : fallback;
  const lines = (value: unknown, fallback: string[]) =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string").slice(0, 30)
      : fallback;
  const profile: RelayProfile = {
    companyName: text(input.companyName, current.companyName),
    companySummary: text(input.companySummary, current.companySummary),
    valueProposition: text(input.valueProposition, current.valueProposition),
    defaultObjective: text(input.defaultObjective, current.defaultObjective),
    openingStatement: text(input.openingStatement, current.openingStatement),
    questionsToAsk: lines(input.questionsToAsk, current.questionsToAsk),
    approvedClaims: lines(input.approvedClaims, current.approvedClaims),
    prohibitedClaims: lines(input.prohibitedClaims, current.prohibitedClaims),
    agentStyle: text(input.agentStyle, current.agentStyle),
    updatedAt: new Date().toISOString(),
  };
  await db
    .prepare(`INSERT INTO relay_config (id, data, updated_at) VALUES ('profile', ?, ?)
      ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`)
    .bind(JSON.stringify(profile), profile.updatedAt)
    .run();
  return profile;
}

export async function listDistributors(db: D1Database) {
  await ensureRelayTables(db);
  const result = await db
    .prepare(
      "SELECT data FROM distributors ORDER BY CASE status WHEN 'ready' THEN 0 WHEN 'research' THEN 1 ELSE 2 END, created_at ASC LIMIT 500",
    )
    .all<{ data: string }>();
  return result.results.map((row) => JSON.parse(row.data) as Distributor);
}

export async function getDistributor(db: D1Database, id: string) {
  await ensureRelayTables(db);
  const row = await db
    .prepare("SELECT data FROM distributors WHERE id = ?")
    .bind(id)
    .first<{ data: string }>();
  return row ? (JSON.parse(row.data) as Distributor) : null;
}

export async function saveDistributor(db: D1Database, distributor: Distributor) {
  await ensureRelayTables(db);
  await db
    .prepare(`INSERT INTO distributors (id, company, phone_number, state, status, created_at, updated_at, data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET company=excluded.company, phone_number=excluded.phone_number,
      state=excluded.state, status=excluded.status, updated_at=excluded.updated_at, data=excluded.data`)
    .bind(
      distributor.id,
      distributor.company,
      distributor.phoneNumber,
      distributor.state,
      distributor.status,
      distributor.createdAt,
      distributor.updatedAt,
      JSON.stringify(distributor),
    )
    .run();
  return distributor;
}

export async function createDistributor(db: D1Database, value: unknown) {
  const input = value as Record<string, unknown>;
  const phoneNumber = normalizeE164(String(input.phoneNumber ?? ""));
  const company = String(input.company ?? "").trim();
  if (!company || !phoneNumber) throw new Error("Company and valid phone number are required");
  const now = new Date().toISOString();
  const consentSource = String(input.consentSource ?? "").trim();
  const consentTimestamp = String(input.consentTimestamp ?? "").trim();
  const distributor: Distributor = {
    id: randomUUID(),
    company: company.slice(0, 300),
    phoneNumber,
    city: String(input.city ?? "").trim().slice(0, 200),
    state: String(input.state ?? "GA").trim().toUpperCase().slice(0, 2),
    contactName: String(input.contactName ?? "").trim().slice(0, 200) || undefined,
    contactTitle: String(input.contactTitle ?? "").trim().slice(0, 200) || undefined,
    website: String(input.website ?? "").trim().slice(0, 500) || undefined,
    consentSource,
    consentTimestamp,
    internalNotes: String(input.internalNotes ?? "").trim().slice(0, 5_000),
    status: consentSource && consentTimestamp ? "ready" : "research",
    createdAt: now,
    updatedAt: now,
  };
  return saveDistributor(db, distributor);
}
