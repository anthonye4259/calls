import assert from "node:assert/strict";
import test from "node:test";
import {
  isTerminalState,
  transitionFromTwilioStatus,
} from "../src/call-state.js";

test("call state follows the expected Twilio lifecycle", () => {
  let state = transitionFromTwilioStatus("queued", "initiated");
  assert.equal(state, "initiating");
  state = transitionFromTwilioStatus(state, "ringing");
  assert.equal(state, "ringing");
  state = transitionFromTwilioStatus(state, "in-progress");
  assert.equal(state, "in_progress");
  state = transitionFromTwilioStatus(state, "completed");
  assert.equal(state, "completed");
  assert.equal(isTerminalState(state), true);
});

test("late callbacks cannot regress or replace a terminal state", () => {
  assert.equal(transitionFromTwilioStatus("in_progress", "ringing"), "in_progress");
  assert.equal(transitionFromTwilioStatus("completed", "failed"), "completed");
  assert.equal(transitionFromTwilioStatus("no_answer", "ringing"), "no_answer");
});

test("unknown Twilio statuses leave the current state unchanged", () => {
  assert.equal(transitionFromTwilioStatus("ringing", "mystery"), "ringing");
});
