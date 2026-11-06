import { randomUUID } from "node:crypto";
import {
  buildCallRequest,
  callbackToken,
  normalizeAuthorizationHeader,
  normalizeE164,
  isWeekdayInTimeZone,
  isWithinCallingWindow,
  rollingWindowStart,
} from "../../../lib/grok-bot";
import {
  bindings,
  callsSince,
  callsToNumberSince,
  listCalls,
  latestCallCreatedAt,
  saveCall,
  type HostedCall,
} from "../../../lib/hosted-calls";
import { getDistributor, getRelayProfile } from "../../../lib/relay-data";

export async function GET() {
  const runtime = await bindings();
  return Response.json({ calls: await listCalls(runtime.DB) });
}

export async function POST(request: Request) {
  const runtime = await bindings();
  const body = (await request.json()) as Record<string, unknown>;
  const distributorId = String(body.distributorId ?? "").trim();
  const distributor = distributorId
    ? await getDistributor(runtime.DB, distributorId)
    : null;
  if (distributorId && !distributor) {
    return Response.json({ error: "Distributor not found" }, { status: 404 });
  }
  if (distributor && distributor.status !== "ready") {
    return Response.json(
      { error: "Distributor needs documented permission before calling" },
      { status: 403 },
    );
  }
  const phoneNumber = normalizeE164(
    String(distributor?.phoneNumber ?? body.phoneNumber ?? ""),
  );
  if (!phoneNumber) {
    return Response.json({ error: "Enter a valid phone number" }, { status: 400 });
  }
  if (body.authorized !== true) {
    return Response.json(
      { error: "Confirm that the recipient authorized this call" },
      { status: 400 },
    );
  }
  if (!runtime.GROK_BOT_WEBHOOK_URL || !runtime.GROK_BOT_AUTHORIZATION_HEADER) {
    return Response.json(
      { error: "Grok Bot is not connected yet" },
      { status: 503 },
    );
  }

  if (!isWeekdayInTimeZone(new Date(), "America/New_York")) {
    return Response.json(
      { error: "Haladir calls run Monday through Friday only" },
      { status: 403 },
    );
  }
  if (!isWithinCallingWindow(new Date(), "America/New_York")) {
    return Response.json(
      { error: "Haladir calls run from 10:00 to 11:30 AM Eastern" },
      { status: 403 },
    );
  }

  const dailyLimit = Number(runtime.GROK_BOT_DAILY_CALL_LIMIT ?? 10);
  const perNumberLimit = Number(runtime.GROK_BOT_PER_NUMBER_LIMIT ?? 4);
  const windowStart = rollingWindowStart();
  const usedToday = await callsSince(runtime.DB, windowStart);
  if (usedToday >= dailyLimit) {
    return Response.json(
      { error: `Rolling 24-hour Grok Bot limit reached (${dailyLimit})` },
      { status: 429 },
    );
  }
  const latestCall = await latestCallCreatedAt(runtime.DB);
  if (latestCall) {
    const nextSlot = new Date(latestCall).getTime() + 10 * 60 * 1_000;
    if (Date.now() < nextSlot) {
      return Response.json(
        {
          error: `Next call slot opens at ${new Intl.DateTimeFormat("en-US", {
            timeZone: "America/New_York",
            hour: "numeric",
            minute: "2-digit",
          }).format(new Date(nextSlot))} Eastern`,
        },
        { status: 429 },
      );
    }
  }
  const usedForNumber = await callsToNumberSince(
    runtime.DB,
    phoneNumber,
    windowStart,
  );
  if (usedForNumber >= perNumberLimit) {
    return Response.json(
      { error: `This number has reached its rolling 24-hour limit (${perNumberLimit})` },
      { status: 429 },
    );
  }

  const now = new Date().toISOString();
  const call: HostedCall = {
    id: randomUUID(),
    phoneNumber,
    provider: "grok_bot",
    transport: "grok_bot_call_card",
    state: "queued",
    createdAt: now,
    updatedAt: now,
    authorizedAt: now,
    interruptionCount: 0,
    transcript: [],
    distributorId: distributor?.id,
  };
  await saveCall(runtime.DB, call);

  const callbackUrl = new URL("/api/grok-bot/call-result", request.url).toString();
  const profile = await getRelayProfile(runtime.DB);
  const payload = buildCallRequest({
    requestId: call.id,
    phoneNumber,
    consentTimestamp: now,
    callbackUrl,
    callbackToken: callbackToken(runtime.GROK_BOT_AUTHORIZATION_HEADER, call.id),
    contactName: distributor?.contactName,
    company: distributor?.company,
    contactRole: distributor?.contactTitle,
    callPurpose: "Authorized follow-up from Haladir",
    objective: profile.defaultObjective,
    openingStatement: profile.openingStatement,
    talkingPoints: [
      profile.companySummary,
      profile.valueProposition,
    ],
    questionsToAsk: profile.questionsToAsk,
    knownFacts: distributor
      ? [
          `Business: ${distributor.company}`,
          `Location: ${distributor.city}, ${distributor.state}`,
          distributor.website ? `Website: ${distributor.website}` : "",
        ].filter(Boolean)
      : [],
    prohibitedClaims: profile.prohibitedClaims,
    internalNotes: distributor?.internalNotes,
    agentStyle: profile.agentStyle,
  });

  const webhookResponse = await fetch(runtime.GROK_BOT_WEBHOOK_URL, {
    method: "POST",
    headers: {
      Authorization: normalizeAuthorizationHeader(
        runtime.GROK_BOT_AUTHORIZATION_HEADER,
      ),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!webhookResponse.ok) {
    call.state = "failed";
    call.updatedAt = new Date().toISOString();
    call.error = `Grok Bot rejected the request (${webhookResponse.status})`;
    await saveCall(runtime.DB, call);
    return Response.json({ error: call.error, call }, { status: 502 });
  }

  return Response.json({ call }, { status: 201 });
}
