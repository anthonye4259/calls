import { listCalls } from "../../lib/hosted-calls";
import {
  createDistributor,
  getDistributor,
  getRelayProfile,
  listDistributors,
  saveDistributor,
  saveRelayProfile,
} from "../../lib/relay-data";
import { bindings } from "../../lib/hosted-calls";

const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, mcp-session-id, authorization",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

const tools = [
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

export async function OPTIONS() {
  return new Response(null, { status: 204, headers });
}

export async function GET() {
  return new Response(JSON.stringify({ name: "Haladir Relay MCP", status: "ready" }), { headers });
}

export async function DELETE() {
  return new Response(null, { status: 204, headers });
}

export async function POST(request: Request) {
  const body = (await request.json()) as { id?: unknown; method?: string; params?: Record<string, unknown> };
  if (body.method === "notifications/initialized") return new Response(null, { status: 202, headers });
  if (body.method === "initialize") {
    return response(body.id, {
      protocolVersion: String(body.params?.protocolVersion ?? "2025-06-18"),
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "haladir-relay", title: "Haladir Relay", version: "1.0.0" },
    });
  }
  if (body.method === "tools/list") return response(body.id, { tools });
  if (body.method !== "tools/call") return error(body.id, -32601, "Method not found");

  const name = String(body.params?.name ?? "");
  const args = (body.params?.arguments ?? {}) as Record<string, unknown>;
  const runtime = await bindings();
  try {
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
      if (!distributor) return error(body.id, -32602, "Distributor not found");
      distributor.internalNotes = String(args.internalNotes ?? "").trim().slice(0, 5_000);
      distributor.updatedAt = new Date().toISOString();
      await saveDistributor(runtime.DB, distributor);
      return response(body.id, toolResult({ distributor }, `${distributor.company} notes updated.`));
    }
    return error(body.id, -32601, "Unknown tool");
  } catch (cause) {
    return error(body.id, -32000, cause instanceof Error ? cause.message : "Relay tool failed");
  }
}
