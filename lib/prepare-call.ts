import { randomUUID } from "node:crypto";
import {
  buildCallRequest,
  callbackToken,
  isWeekdayInTimeZone,
  isWithinCallingWindow,
  normalizeAuthorizationHeader,
  normalizeE164,
  rollingWindowStart,
} from "./grok-bot";
import {
  callsSince,
  callsToNumberSince,
  latestCallCreatedAt,
  listCalls,
  saveCall,
  type HostedCall,
} from "./hosted-calls";
import { getRelayProfile, listDistributors, type Distributor } from "./relay-data";

type Runtime = {
  DB: D1Database;
  GROK_BOT_WEBHOOK_URL?: string;
  GROK_BOT_AUTHORIZATION_HEADER?: string;
  GROK_BOT_DAILY_CALL_LIMIT?: string;
  GROK_BOT_PER_NUMBER_LIMIT?: string;
  OWNER_TEST_PHONE_NUMBER?: string;
};

export class PrepareCallError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export async function prepareCall(runtime: Runtime, origin: string, requested?: Distributor, options: { ownerTest?: boolean } = {}) {
  const distributor = requested ?? (await listDistributors(runtime.DB)).find((item) => item.status === "ready");
  if (!distributor) throw new PrepareCallError("No authorized distributors are ready", 409);
  if (distributor.status !== "ready") throw new PrepareCallError("Distributor needs documented permission before calling", 403);
  const phoneNumber = normalizeE164(distributor.phoneNumber);
  if (!phoneNumber) throw new PrepareCallError("Distributor has an invalid phone number", 400);
  if (!runtime.GROK_BOT_WEBHOOK_URL || !runtime.GROK_BOT_AUTHORIZATION_HEADER) {
    throw new PrepareCallError("Grok Bot is not connected yet", 503);
  }

  const nowDate = new Date();
  if (!options.ownerTest && !isWeekdayInTimeZone(nowDate, "America/New_York")) throw new PrepareCallError("Haladir calls run Monday through Friday only", 403);
  if (!options.ownerTest && !isWithinCallingWindow(nowDate, "America/New_York")) throw new PrepareCallError("Haladir calls run from 10:00 to 11:30 AM Eastern", 403);

  const calls = await listCalls(runtime.DB);
  if (calls.some((call) => call.state === "queued")) {
    throw new PrepareCallError("A Call card is already waiting or its result has not returned", 409);
  }
  const windowStart = rollingWindowStart();
  const dailyLimit = Number(runtime.GROK_BOT_DAILY_CALL_LIMIT ?? 10);
  if (await callsSince(runtime.DB, windowStart) >= dailyLimit) throw new PrepareCallError(`Rolling 24-hour Grok Bot limit reached (${dailyLimit})`, 429);
  const latestCall = await latestCallCreatedAt(runtime.DB);
  if (latestCall) {
    const nextSlot = new Date(latestCall).getTime() + 10 * 60 * 1_000;
    if (Date.now() < nextSlot) throw new PrepareCallError(`Next call slot opens at ${new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(new Date(nextSlot))} Eastern`, 429);
  }
  const perNumberLimit = Number(runtime.GROK_BOT_PER_NUMBER_LIMIT ?? 4);
  if (await callsToNumberSince(runtime.DB, phoneNumber, windowStart) >= perNumberLimit) {
    throw new PrepareCallError(`This number has reached its rolling 24-hour limit (${perNumberLimit})`, 429);
  }

  const now = nowDate.toISOString();
  const call: HostedCall = {
    id: randomUUID(), phoneNumber, provider: "grok_bot", transport: "grok_bot_call_card",
    state: "queued", createdAt: now, updatedAt: now, authorizedAt: now,
    interruptionCount: 0, transcript: [], distributorId: options.ownerTest ? undefined : distributor.id,
  };
  await saveCall(runtime.DB, call);
  const profile = await getRelayProfile(runtime.DB);
  const payload = buildCallRequest({
    requestId: call.id,
    phoneNumber,
    consentTimestamp: now,
    callbackUrl: new URL("/api/grok-bot/call-result", origin).toString(),
    callbackToken: callbackToken(runtime.GROK_BOT_AUTHORIZATION_HEADER, call.id),
    contactName: distributor.contactName,
    company: distributor.company,
    contactRole: distributor.contactTitle,
    callPurpose: options.ownerTest ? "Owner-authorized Relay and Grok Bot connection test" : "Authorized follow-up from Haladir",
    objective: options.ownerTest ? "Confirm audio quality, conversational behavior, transcript capture, and Relay callback delivery." : profile.defaultObjective,
    openingStatement: profile.openingStatement,
    talkingPoints: [profile.companySummary, profile.valueProposition],
    questionsToAsk: profile.questionsToAsk,
    knownFacts: [`Business: ${distributor.company}`, `Location: ${distributor.city}, ${distributor.state}`, distributor.website ? `Website: ${distributor.website}` : ""].filter(Boolean),
    prohibitedClaims: profile.prohibitedClaims,
    internalNotes: distributor.internalNotes,
    agentStyle: profile.agentStyle,
  });
  const webhookResponse = await fetch(runtime.GROK_BOT_WEBHOOK_URL, {
    method: "POST",
    headers: { Authorization: normalizeAuthorizationHeader(runtime.GROK_BOT_AUTHORIZATION_HEADER), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!webhookResponse.ok) {
    call.state = "failed";
    call.updatedAt = new Date().toISOString();
    call.error = `Grok Bot rejected the request (${webhookResponse.status})`;
    await saveCall(runtime.DB, call);
    throw new PrepareCallError(call.error, 502);
  }
  return { call, distributor };
}

export async function prepareOwnerTestCall(runtime: Runtime, origin: string) {
  const phoneNumber = normalizeE164(runtime.OWNER_TEST_PHONE_NUMBER ?? "");
  if (!phoneNumber) throw new PrepareCallError("Owner test number is not configured", 503);
  const now = new Date().toISOString();
  const owner: Distributor = {
    id: "owner-test",
    company: "Haladir owner test",
    phoneNumber,
    city: "",
    state: "GA",
    contactName: "Anthony",
    contactTitle: "Owner",
    consentSource: "Owner configured private test number",
    consentTimestamp: now,
    internalNotes: "This is a connection test. Be friendly and brief. Confirm that the owner can hear the agent, then end politely.",
    status: "ready",
    createdAt: now,
    updatedAt: now,
  };
  return prepareCall(runtime, origin, owner, { ownerTest: true });
}
