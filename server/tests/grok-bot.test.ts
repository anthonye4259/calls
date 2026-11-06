import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCallRequest,
  callbackToken,
  isWeekdayInTimeZone,
  isWithinCallingWindow,
  mapGrokBotOutcome,
  normalizeAuthorizationHeader,
  normalizeE164,
  rollingWindowStart,
} from "../../lib/grok-bot.js";

test("normalizes a copied Grok Bot authorization header", () => {
  assert.equal(
    normalizeAuthorizationHeader("Authorization: Bearer private-token"),
    "Bearer private-token",
  );
  assert.throws(() => normalizeAuthorizationHeader("private-token"), /Bearer/);
});

test("builds one bounded authorized call-card request", () => {
  const payload = buildCallRequest({
    requestId: "call-1",
    phoneNumber: "+12125550123",
    consentTimestamp: "2026-11-05T20:00:00.000Z",
    callbackUrl: "https://example.com/api/grok-bot/call-result",
    callbackToken: "callback-token",
  });
  assert.equal(payload.requestId, "call-1");
  assert.equal(payload.maxMinutes, 5);
  assert.match(payload.consentSource, /confirmed permission/i);
  assert.equal(payload.resultRequirements.fullTranscript, true);
  assert.match(payload.agentStyle, /friendly/i);
});

test("callback token is request-specific and deterministic", () => {
  const first = callbackToken("Bearer private-token", "call-1");
  assert.equal(first, callbackToken("Bearer private-token", "call-1"));
  assert.notEqual(first, callbackToken("Bearer private-token", "call-2"));
});

test("Grok Bot opt-outs normalize to do-not-call", () => {
  const outcome = mapGrokBotOutcome({
    disposition: "do_not_call",
    summary: "Recipient opted out.",
  });
  assert.equal(outcome.outcome, "declined_do_not_call");
  assert.equal(outcome.doNotCall, true);
});

test("phone numbers must use E.164", () => {
  assert.equal(normalizeE164("(212) 555-0123"), null);
  assert.equal(normalizeE164("+1 (212) 555-0123"), "+12125550123");
});

test("call capacity uses a rolling 24-hour window", () => {
  assert.equal(
    rollingWindowStart(new Date("2026-11-05T21:00:00.000Z")),
    "2026-11-04T21:00:00.000Z",
  );
});

test("weekday calling follows Eastern time", () => {
  assert.equal(
    isWeekdayInTimeZone(new Date("2026-11-06T17:00:00.000Z")),
    true,
  );
  assert.equal(
    isWeekdayInTimeZone(new Date("2026-11-07T17:00:00.000Z")),
    false,
  );
});

test("calling window is 10:00 through 11:30 Eastern", () => {
  assert.equal(isWithinCallingWindow(new Date("2026-11-06T14:59:00.000Z")), false);
  assert.equal(isWithinCallingWindow(new Date("2026-11-06T15:00:00.000Z")), true);
  assert.equal(isWithinCallingWindow(new Date("2026-11-06T16:30:00.000Z")), true);
  assert.equal(isWithinCallingWindow(new Date("2026-11-06T16:31:00.000Z")), false);
});
