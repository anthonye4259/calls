import assert from "node:assert/strict";
import test from "node:test";
import { parseOutcomeDetails } from "../src/domain.js";

test("outcome parser preserves explicit visit permission", () => {
  const outcome = parseOutcomeDetails({
    outcome: "visit_welcomed",
    summary: "Receptionist explicitly welcomed a 10 AM visit.",
    visitPermission: "explicitly_welcomed",
    visitDate: "2026-11-06",
    visitTime: "10:00",
    doNotCall: false,
    confidence: 0.94,
  });
  assert.equal(outcome.outcome, "visit_welcomed");
  assert.equal(outcome.visitPermission, "explicitly_welcomed");
  assert.equal(outcome.confidence, 0.94);
});

test("declined outcome always activates do-not-call", () => {
  const outcome = parseOutcomeDetails({
    outcome: "declined_do_not_call",
    summary: "Recipient asked for no further calls.",
    visitPermission: "not_welcomed",
    doNotCall: false,
    confidence: 1,
  });
  assert.equal(outcome.doNotCall, true);
});

test("unsupported outcome payloads fail closed", () => {
  assert.throws(
    () =>
      parseOutcomeDetails({
        outcome: "probably_interested",
        summary: "Maybe",
        visitPermission: "unknown",
        confidence: 2,
      }),
    /Unknown call outcome/,
  );
});

test("ambiguous availability cannot be promoted to a welcomed visit", () => {
  assert.throws(
    () =>
      parseOutcomeDetails({
        outcome: "visit_welcomed",
        summary: "The manager is usually present in the morning.",
        visitPermission: "present_not_confirmed",
        doNotCall: false,
        confidence: 0.8,
      }),
    /explicit permission/,
  );
});

test("do-not-call always normalizes to the safest outcome", () => {
  const outcome = parseOutcomeDetails({
    outcome: "manager_unavailable",
    summary: "The recipient asked not to receive another call.",
    visitPermission: "unknown",
    doNotCall: true,
    confidence: 1,
  });
  assert.equal(outcome.outcome, "declined_do_not_call");
  assert.equal(outcome.visitPermission, "not_welcomed");
});
