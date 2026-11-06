import { listCalls } from "./hosted-calls";
import {
  createDistributor,
  getDistributor,
  getRelayProfile,
  listDistributors,
  saveDistributor,
  saveRelayProfile,
} from "./relay-data";
import { bindings } from "./hosted-calls";
import { prepareCall, prepareOwnerTestCall } from "./prepare-call";

const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, mcp-session-id, authorization",
  "Cache-Control": "no-store",
};

const tools = [
  {
    name: "prepare_owner_test_call",
    title: "Prepare owner test call",
    description: "Prepares one Grok native Call card only for the owner's fixed private test number. It never selects or modifies a distributor record.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "prepare_next_call",
    title: "Prepare next authorized call",
    description: "Selects the next ready distributor, applies Relay's schedule, spacing, DNC, pending-card, and rolling-limit controls, then asks Grok Bot to prepare exactly one native Call card.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "get_relay_status",
    title: "Get Relay status",
    description: "Shows the Haladir calling schedule, limits, queue counts, and latest call state.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "list_call_queue",
    title: "List call queue",
    description: "Lists Relay distributors and their ready, completed, research, or blocked status.",
    inputSchema: {
      type: "object",
      properties: { status: { type: "string", enum: ["ready", "completed", "research", "blocked", "all"] }, limit: { type: "integer", minimum: 1, maximum: 100 } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "get_recent_calls",
    title: "Get recent calls and transcripts",
    description: "Returns recent Grok call states, outcomes, notes, and full speaker-labeled transcripts.",
    inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 25 } }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "get_haladir_call_brief",
    title: "Get Haladir call brief",
    description: "Reads the current Haladir company information, SDR style, objectives, script, questions, and claim controls.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "update_haladir_call_brief",
    title: "Update Haladir call brief",
    description: "Updates selected Relay-owned Haladir script and agent-behavior fields. Omitted fields remain unchanged.",
    inputSchema: {
      type: "object",
      properties: {
        companySummary: { type: "string" }, valueProposition: { type: "string" }, defaultObjective: { type: "string" },
        openingStatement: { type: "string" }, agentStyle: { type: "string" }, questionsToAsk: { type: "array", items: { type: "string" } },
        approvedClaims: { type: "array", items: { type: "string" } }, prohibitedClaims: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "add_distributor",
    title: "Add distributor",
    description: "Adds a distributor to Relay. Include authorization source and timestamp to make it ready to call.",
    inputSchema: {
      type: "object",
      required: ["company", "phoneNumber"],
      properties: {
        company: { type: "string" }, phoneNumber: { type: "string" }, city: { type: "string" }, state: { type: "string" },
        contactName: { type: "string" }, contactTitle: { type: "string" }, website: { type: "string" }, internalNotes: { type: "string" },
        consentSource: { type: "string" }, consentTimestamp: { type: "string" },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "update_distributor_notes",
    title: "Update distributor notes",
    description: "Replaces the internal Relay notes for one distributor without changing call status or authorization.",
    inputSchema: {
      type: "object",
      required: ["id", "internalNotes"],
      properties: { id: { type: "string" }, internalNotes: { type: "string" } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
];

function response(id: unknown, result: unknown) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { headers });
}

function error(id: unknown, code: number, message: string) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), { headers });
}

function toolResult(value: unknown, message?: string) {
  return {
    content: [{ type: "text", text: message ?? JSON.stringify(value) }],
    structuredContent: value,
  };
}

const dependencies = { bindings, listCalls, createDistributor, getDistributor, getRelayProfile,
  listDistributors, saveDistributor, saveRelayProfile, prepareCall, prepareOwnerTestCall };

function authorized(request: Request) {
  // Only Sites dispatch may supply these verified identity headers. Keep the Site owner-private.
  return Boolean(request.headers.get("oai-authenticated-user-id")?.trim() &&
    request.headers.get("oai-authenticated-user-email")?.trim());
}

function unauthorized() {
  return new Response(JSON.stringify({ error: "Authentication required" }), { status: 401, headers });
}

export function metadata(request: Request) {
  if (!authorized(request)) return unauthorized();
  return new Response(JSON.stringify({ name: "Haladir Relay MCP", status: "ready" }), { headers });
}

function validate(schema: Record<string, unknown>, args: unknown): string | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "Arguments must be an object";
  const input = args as Record<string, unknown>;
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  for (const required of (schema.required ?? []) as string[]) {
    if (!(required in input)) return `Missing required field: ${required}`;
  }
  for (const [key, value] of Object.entries(input)) {
    const rule = properties[key];
    if (!rule) return `Unknown field: ${key}`;
    if (rule.type === "string" && (typeof value !== "string" || value.length > 5000)) return `Invalid text: ${key}`;
    if (rule.type === "integer" && (typeof value !== "number" || !Number.isInteger(value) || value < Number(rule.minimum) || value > Number(rule.maximum))) return `Invalid integer: ${key}`;
    if (rule.enum && !(rule.enum as unknown[]).includes(value)) return `Invalid value: ${key}`;
    if (rule.type === "array" && (!Array.isArray(value) || value.length > 30 || value.some(item => typeof item !== "string" || item.length > 5000))) return `Invalid list: ${key}`;
  }
  return null;
}

export function createMcpHandler(overrides: Partial<typeof dependencies> = {}) {
  const { bindings, listCalls, createDistributor, getDistributor, getRelayProfile,
    listDistributors, saveDistributor, saveRelayProfile, prepareCall, prepareOwnerTestCall } = { ...dependencies, ...overrides };
  return async function POST(request: Request) {
  if (!authorized(request)) return unauthorized();
  let body: { jsonrpc?: unknown; id?: unknown; method?: string; params?: Record<string, unknown> };
  try { body = await request.json(); }
  catch { return error(null, -32700, "Invalid JSON"); }
  if (!body || Array.isArray(body) || body.jsonrpc !== "2.0" || typeof body.method !== "string" ||
    (body.id !== undefined && body.id !== null && typeof body.id !== "string" && typeof body.id !== "number") ||
    (body.params !== undefined && (!body.params || typeof body.params !== "object" || Array.isArray(body.params)))) {
    return error(null, -32600, "Invalid request");
  }
  if (body.method === "server/discover") return response(body.id ?? null, {
    supportedVersions: ["2026-07-28"], capabilities: { tools: {} },
    serverInfo: { name: "haladir-relay", version: "1.1.0" },
  });
  if (body.method === "notifications/initialized") return new Response(null, { status: 202, headers });
  if (body.method === "initialize") {
    return response(body.id, {
      protocolVersion: ["2026-07-28", "2025-06-18"].includes(String(body.params?.protocolVersion)) ? String(body.params?.protocolVersion) : "2026-07-28",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "haladir-relay", title: "Haladir Relay", version: "1.0.0" },
    });
  }
  if (body.method === "tools/list") return response(body.id, { tools });
  if (body.method !== "tools/call") return error(body.id, -32601, "Method not found");

  const name = String(body.params?.name ?? "");
  const definition = tools.find(tool => tool.name === name);
  if (!definition) return error(body.id ?? null, -32602, "Unknown tool");
  const args = (body.params?.arguments ?? {}) as Record<string, unknown>;
  const invalid = validate(definition.inputSchema, args);
  if (invalid) return error(body.id ?? null, -32602, invalid);
  if (name === "add_distributor" && args.consentTimestamp && !Number.isFinite(Date.parse(String(args.consentTimestamp)))) {
    return error(body.id ?? null, -32602, "Invalid authorization timestamp");
  }
  try {
    const runtime = await bindings();
    if (name === "prepare_owner_test_call") {
      const result = await prepareOwnerTestCall(runtime, request.url);
      return response(body.id, toolResult({ call: result.call }, "Owner test Call card prepared. Tap Call in Grok Bot to dial."));
    }
    if (name === "prepare_next_call") {
      const result = await prepareCall(runtime, request.url);
      return response(body.id, toolResult(result, `Call card prepared for ${result.distributor.company}. Tap Call in Grok Bot to dial.`));
    }
    if (name === "get_relay_status") {
      const [queue, calls] = await Promise.all([listDistributors(runtime.DB), listCalls(runtime.DB)]);
      const value = {
        schedule: "Monday–Friday, 10:00–11:30 AM Eastern",
        spacingMinutes: 10,
        rolling24HourLimit: Number(runtime.GROK_BOT_DAILY_CALL_LIMIT ?? 10),
        ready: queue.filter((item) => item.status === "ready").length,
        blocked: queue.filter((item) => item.status === "blocked").length,
        latestCall: calls[0] ?? null,
      };
      return response(body.id, toolResult(value));
    }
    if (name === "list_call_queue") {
      const status = String(args.status ?? "all");
      const limit = Math.min(100, Math.max(1, Number(args.limit ?? 25)));
      const queue = (await listDistributors(runtime.DB)).filter((item) => status === "all" || item.status === status).slice(0, limit);
      return response(body.id, toolResult({ distributors: queue }));
    }
    if (name === "get_recent_calls") {
      const limit = Math.min(25, Math.max(1, Number(args.limit ?? 10)));
      return response(body.id, toolResult({ calls: (await listCalls(runtime.DB)).slice(0, limit) }));
    }
    if (name === "get_haladir_call_brief") return response(body.id, toolResult({ profile: await getRelayProfile(runtime.DB) }));
    if (name === "update_haladir_call_brief") {
      const profile = await saveRelayProfile(runtime.DB, args);
      return response(body.id, toolResult({ profile }, "Haladir call brief updated."));
    }
    if (name === "add_distributor") {
      const distributor = await createDistributor(runtime.DB, args);
      return response(body.id, toolResult({ distributor }, `${distributor.company} added to Relay.`));
    }
    if (name === "update_distributor_notes") {
      const distributor = await getDistributor(runtime.DB, String(args.id ?? ""));
      if (!distributor) return response(body.id, { content: [{ type: "text", text: "Distributor not found" }], isError: true });
      distributor.internalNotes = String(args.internalNotes ?? "").trim().slice(0, 5_000);
      distributor.updatedAt = new Date().toISOString();
      await saveDistributor(runtime.DB, distributor);
      return response(body.id, toolResult({ distributor }, `${distributor.company} notes updated.`));
    }
    return error(body.id, -32601, "Unknown tool");
  } catch (cause) {
    // Do not expose runtime errors, bindings, or provider credentials to tool callers.
    return response(body.id, { content: [{ type: "text", text: "Relay tool failed" }], isError: true });
  }
}

}
