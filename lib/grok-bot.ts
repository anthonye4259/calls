import { createHash } from "node:crypto";

export type GrokBotEnvironment = {
  webhookUrl: string;
  authorization: string;
  dailyLimit: number;
};

export function rollingWindowStart(now = new Date()) {
  return new Date(now.getTime() - 24 * 60 * 60 * 1_000).toISOString();
}

export function isWeekdayInTimeZone(
  now = new Date(),
  timeZone = "America/New_York",
) {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
  }).format(now);
  return weekday !== "Sat" && weekday !== "Sun";
}

export function isWithinCallingWindow(
  now = new Date(),
  timeZone = "America/New_York",
) {
  if (!isWeekdayInTimeZone(now, timeZone)) return false;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = (type: "hour" | "minute") =>
    Number(parts.find((part) => part.type === type)?.value ?? -1);
  const minutes = value("hour") * 60 + value("minute");
  return minutes >= 10 * 60 && minutes <= 11 * 60 + 30;
}

export function normalizeAuthorizationHeader(value: string): string {
  const normalized = value.trim().replace(/^Authorization\s*:\s*/i, "");
  if (!/^Bearer\s+\S+$/i.test(normalized)) {
    throw new Error("Grok Bot authorization must be a Bearer header");
  }
  return normalized;
}

export function normalizeE164(value: string): string | null {
  const normalized = value.trim().replace(/[\s().-]/g, "");
  return /^\+[1-9]\d{7,14}$/.test(normalized) ? normalized : null;
}

export function callbackToken(authorization: string, requestId: string) {
  return createHash("sha256")
    .update(`haladir:grok-bot:${normalizeAuthorizationHeader(authorization)}:${requestId}`)
    .digest("hex");
}

export function buildCallRequest(input: {
  requestId: string;
  phoneNumber: string;
  consentTimestamp: string;
  callbackUrl: string;
  callbackToken: string;
  contactName?: string;
  company?: string;
  contactRole?: string;
  callPurpose?: string;
  objective?: string;
  openingStatement?: string;
  talkingPoints?: string[];
  questionsToAsk?: string[];
  knownFacts?: string[];
  prohibitedClaims?: string[];
  internalNotes?: string;
  agentStyle?: string;
}) {
  return {
    requestId: input.requestId,
    phoneNumber: input.phoneNumber,
    contactName: input.contactName ?? "Authorized test recipient",
    company: input.company ?? "Unknown business",
    contactRole: input.contactRole,
    consentSource: "Operator confirmed permission in the Haladir dashboard",
    consentTimestamp: input.consentTimestamp,
    callPurpose: input.callPurpose ?? "Requested Haladir follow-up",
    objective:
      input.objective ??
      "Confirm the correct business contact and capture the requested next step",
    openingStatement: input.openingStatement,
    talkingPoints: input.talkingPoints ?? [
      "Identify the call as an AI assistant calling on behalf of Haladir",
      "Confirm the recipient is willing to continue",
      "Capture the appropriate next step without making unsupported commitments",
    ],
    questionsToAsk: input.questionsToAsk ?? [],
    knownFacts: input.knownFacts ?? [],
    prohibitedClaims: input.prohibitedClaims ?? [],
    internalNotes: input.internalNotes ?? "",
    agentStyle:
      input.agentStyle ??
      "Think like a capable SDR: familiar, friendly, curious, concise, and respectful. Sound conversational rather than scripted. Listen carefully, use the recipient's answers naturally, and never pressure or argue.",
    conversationGoals: [
      "Build quick rapport and confirm you reached the right business or person",
      "Understand the current warehouse or distribution operation and any workflow pain points",
      "Explain only the Haladir information supplied in this brief",
      "Capture the decision-maker, interest level, best follow-up time, and agreed next step",
      "Respect a no, an opt-out, or a request to end the call immediately",
    ],
    resultRequirements: {
      fullTranscript: true,
      speakerLabels: true,
      summary: true,
      disposition: true,
      doNotCall: true,
      callbackDetails: true,
      notes: "POST the complete speaker-labeled transcript and structured result to callbackUrl after every completed or failed call.",
    },
    maxMinutes: 5,
    callbackUrl: input.callbackUrl,
    callbackToken: input.callbackToken,
  };
}

export function mapGrokBotOutcome(value: Record<string, unknown>) {
  const disposition = String(value.disposition ?? "unknown");
  const outcomeMap: Record<string, string> = {
    interested: "visit_welcomed",
    callback_requested: "callback_requested",
    appointment_requested: "appointment_scheduled",
    not_interested: "not_qualified",
    do_not_call: "declined_do_not_call",
    unanswered: "no_answer_voicemail",
    voicemail: "no_answer_voicemail",
    failed: "call_failed",
  };
  const doNotCall = value.doNotCall === true || disposition === "do_not_call";
  return {
    outcome: doNotCall
      ? "declined_do_not_call"
      : outcomeMap[disposition] ?? "needs_review",
    summary:
      typeof value.summary === "string" && value.summary.trim()
        ? value.summary.trim().slice(0, 2_000)
        : "Grok Bot returned a call result for review.",
    visitPermission:
      disposition === "interested" ? "explicitly_welcomed" : "unknown",
    doNotCall,
    confidence: 0.8,
    capturedBy: "ai" as const,
    capturedAt: new Date().toISOString(),
  };
}
