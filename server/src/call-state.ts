import type { CallState } from "./domain.js";

const TERMINAL_STATES = new Set<CallState>([
  "completed",
  "busy",
  "no_answer",
  "canceled",
  "failed",
]);

const TWILIO_STATUS_TO_STATE: Record<string, CallState> = {
  queued: "queued",
  initiated: "initiating",
  ringing: "ringing",
  answered: "in_progress",
  "in-progress": "in_progress",
  completed: "completed",
  busy: "busy",
  "no-answer": "no_answer",
  canceled: "canceled",
  failed: "failed",
};

export function isTerminalState(state: CallState): boolean {
  return TERMINAL_STATES.has(state);
}

export function transitionFromTwilioStatus(
  current: CallState,
  twilioStatus: string,
): CallState {
  const next = TWILIO_STATUS_TO_STATE[twilioStatus.toLowerCase()];
  if (!next) return current;
  if (isTerminalState(current)) return current;

  const rank: Record<CallState, number> = {
    queued: 0,
    initiating: 1,
    ringing: 2,
    in_progress: 3,
    completed: 4,
    busy: 4,
    no_answer: 4,
    canceled: 4,
    failed: 4,
  };

  return rank[next] >= rank[current] ? next : current;
}
