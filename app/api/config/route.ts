import { bindings } from "../../../lib/hosted-calls";

export async function GET() {
  const runtime = await bindings();
  const webhook = Boolean(runtime.GROK_BOT_WEBHOOK_URL);
  const authorization = Boolean(runtime.GROK_BOT_AUTHORIZATION_HEADER);
  return Response.json({
    ready: webhook && authorization,
    checks: { webhook, authorization },
    mode: "one_tap_call_cards",
    allowlistedNumbers: 0,
    dailyLimit: Number(runtime.GROK_BOT_DAILY_CALL_LIMIT ?? 10),
    perNumberLimit: Number(runtime.GROK_BOT_PER_NUMBER_LIMIT ?? 4),
    callingWindow: "Monday–Friday, 10:00–11:30 AM Eastern",
    minimumSpacingMinutes: 10,
    voiceProvider: "Grok Bot · native Call cards",
  });
}
