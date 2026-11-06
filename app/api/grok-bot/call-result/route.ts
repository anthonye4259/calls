import { callbackToken, mapGrokBotOutcome } from "../../../../lib/grok-bot";
import { bindings, getCall, saveCall } from "../../../../lib/hosted-calls";
import { getDistributor, saveDistributor } from "../../../../lib/relay-data";

export async function POST(request: Request) {
  const runtime = await bindings();
  const body = (await request.json()) as Record<string, unknown>;
  const requestId = String(body.requestId ?? "");
  const suppliedToken = String(
    request.headers.get("authorization") ?? body.callbackToken ?? "",
  ).replace(/^Bearer\s+/i, "");
  if (
    !requestId ||
    !runtime.GROK_BOT_AUTHORIZATION_HEADER ||
    suppliedToken !== callbackToken(runtime.GROK_BOT_AUTHORIZATION_HEADER, requestId)
  ) {
    return Response.json({ error: "Invalid callback authorization" }, { status: 403 });
  }

  const call = await getCall(runtime.DB, requestId);
  if (!call) return Response.json({ error: "Unknown call" }, { status: 404 });

  const now = new Date().toISOString();
  const transcript = Array.isArray(body.transcript)
    ? body.transcript
        .filter((entry) => entry && typeof entry === "object")
        .map((entry) => {
          const item = entry as Record<string, unknown>;
          return {
            role: item.role === "recipient" ? ("recipient" as const) : ("agent" as const),
            text: String(item.text ?? "").slice(0, 4_000),
            at: String(item.at ?? now),
          };
        })
    : typeof body.transcript === "string" && body.transcript.trim()
      ? [{ role: "agent" as const, text: body.transcript.slice(0, 20_000), at: now }]
      : [];
  call.state = String(body.status ?? "") === "failed" ? "failed" : "completed";
  call.updatedAt = now;
  call.transcript = transcript;
  call.outcome = mapGrokBotOutcome(body);
  if (call.state === "failed") call.error = String(body.failureReason ?? "Call failed");
  await saveCall(runtime.DB, call);
  if (call.distributorId) {
    const distributor = await getDistributor(runtime.DB, call.distributorId);
    if (distributor) {
      distributor.status = call.outcome.doNotCall ? "blocked" : "completed";
      distributor.lastCallId = call.id;
      distributor.lastOutcome = String(call.outcome.outcome ?? "needs_review");
      distributor.callNotes = String(call.outcome.summary ?? "");
      distributor.updatedAt = now;
      await saveDistributor(runtime.DB, distributor);
    }
  }
  return Response.json({ accepted: true });
}
