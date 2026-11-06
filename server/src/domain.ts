export const CALL_STATES = [
  "queued",
  "initiating",
  "ringing",
  "in_progress",
  "completed",
  "busy",
  "no_answer",
  "canceled",
  "failed",
] as const;

export type CallState = (typeof CALL_STATES)[number];

export const CALL_OUTCOMES = [
  "visit_welcomed",
  "manager_available_not_confirmed",
  "appointment_scheduled",
  "manager_unavailable",
  "callback_requested",
  "wrong_business_or_number",
  "not_qualified",
  "declined_do_not_call",
  "no_answer_voicemail",
  "call_failed",
  "needs_review",
] as const;

export type CallOutcome = (typeof CALL_OUTCOMES)[number];

export const VISIT_PERMISSIONS = [
  "explicitly_welcomed",
  "present_not_confirmed",
  "appointment_required",
  "not_welcomed",
  "unknown",
] as const;

export type VisitPermission = (typeof VISIT_PERMISSIONS)[number];

export type TranscriptEntry = {
  role: "agent" | "recipient";
  text: string;
  at: string;
  sourceId?: string;
};

export type OutcomeDetails = {
  outcome: CallOutcome;
  summary: string;
  contactName?: string;
  contactTitle?: string;
  managerAvailability?: string;
  visitPermission: VisitPermission;
  visitDate?: string;
  visitTime?: string;
  callbackAt?: string;
  accessInstructions?: string;
  notes?: string;
  doNotCall: boolean;
  confidence: number;
  capturedBy: "ai" | "human" | "system";
  capturedAt: string;
};

export type CallRecord = {
  id: string;
  phoneNumber: string;
  provider: "xai";
  transport: "xai_sip" | "twilio_media_stream";
  state: CallState;
  twilioCallSid?: string;
  xaiCallId?: string;
  xaiConversationId?: string;
  rawTwilioStatus?: string;
  createdAt: string;
  updatedAt: string;
  authorizedAt: string;
  connectedAt?: string;
  completedAt?: string;
  interruptionCount: number;
  dtmfEventCount?: number;
  firstAudioLatencyMs?: number;
  providerReconnectCount?: number;
  transcript: TranscriptEntry[];
  outcome?: OutcomeDetails;
  error?: string;
};

export type CallPatch = Partial<Omit<CallRecord, "id" | "createdAt">>;

export function isCallOutcome(value: unknown): value is CallOutcome {
  return typeof value === "string" && CALL_OUTCOMES.includes(value as CallOutcome);
}

export function isVisitPermission(value: unknown): value is VisitPermission {
  return (
    typeof value === "string" &&
    VISIT_PERMISSIONS.includes(value as VisitPermission)
  );
}

export function parseOutcomeDetails(
  value: unknown,
  capturedBy: OutcomeDetails["capturedBy"] = "ai",
): OutcomeDetails {
  if (!value || typeof value !== "object") {
    throw new Error("Outcome payload must be an object");
  }

  const input = value as Record<string, unknown>;
  if (!isCallOutcome(input.outcome)) {
    throw new Error("Unknown call outcome");
  }
  if (typeof input.summary !== "string" || input.summary.trim().length < 3) {
    throw new Error("A concise outcome summary is required");
  }

  const permission = input.visitPermission ?? "unknown";
  if (!isVisitPermission(permission)) {
    throw new Error("Unknown visit permission");
  }

  const confidence =
    typeof input.confidence === "number" ? input.confidence : 0.5;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error("Confidence must be between 0 and 1");
  }

  const optionalText = (key: string): string | undefined => {
    const field = input[key];
    return typeof field === "string" && field.trim()
      ? field.trim().slice(0, 1_000)
      : undefined;
  };

  let outcome = input.outcome;
  let normalizedPermission = permission;
  if (input.doNotCall === true || outcome === "declined_do_not_call") {
    outcome = "declined_do_not_call";
    normalizedPermission = "not_welcomed";
  }

  if (
    outcome === "visit_welcomed" &&
    normalizedPermission !== "explicitly_welcomed"
  ) {
    throw new Error(
      "A welcomed visit requires explicit permission from the recipient",
    );
  }
  if (
    outcome === "manager_available_not_confirmed" &&
    !["present_not_confirmed", "unknown"].includes(normalizedPermission)
  ) {
    throw new Error(
      "Manager availability without confirmation cannot be saved as visit permission",
    );
  }
  if (
    outcome === "appointment_scheduled" &&
    !["appointment_required", "explicitly_welcomed"].includes(
      normalizedPermission,
    )
  ) {
    throw new Error("A scheduled appointment requires appointment permission");
  }

  const visitDate = optionalText("visitDate");
  const visitTime = optionalText("visitTime");
  if (outcome === "appointment_scheduled" && (!visitDate || !visitTime)) {
    throw new Error("A scheduled appointment requires both a date and a time");
  }

  return {
    outcome,
    summary: input.summary.trim().slice(0, 2_000),
    contactName: optionalText("contactName"),
    contactTitle: optionalText("contactTitle"),
    managerAvailability: optionalText("managerAvailability"),
    visitPermission: normalizedPermission,
    visitDate,
    visitTime,
    callbackAt: optionalText("callbackAt"),
    accessInstructions: optionalText("accessInstructions"),
    notes: optionalText("notes"),
    doNotCall:
      outcome === "declined_do_not_call",
    confidence,
    capturedBy,
    capturedAt: new Date().toISOString(),
  };
}
