import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";
import type { CallRecord } from "../src/domain.js";
import { XaiRealtimeSession } from "../src/providers/xai-realtime.js";
import { MemoryCallRepository } from "../src/store.js";

class FakeSocket {
  sent: string[] = [];
  closed = false;
  readyState: 0 | 1 | 2 | 3 = WebSocket.OPEN;
  send(data: string | Buffer) {
    this.sent.push(data.toString());
  }
  close() {
    this.closed = true;
    this.readyState = WebSocket.CLOSED;
  }
}

async function fixture() {
  const repository = new MemoryCallRepository();
  const now = new Date().toISOString();
  const record: CallRecord = {
    id: "call-test",
    phoneNumber: "+14045550123",
    provider: "xai",
    transport: "twilio_media_stream",
    state: "in_progress",
    createdAt: now,
    updatedAt: now,
    authorizedAt: now,
    interruptionCount: 0,
    transcript: [],
  };
  await repository.create(record);
  const providerSocket = new FakeSocket();
  const telephonySocket = new FakeSocket();
  let ended = false;
  const session = new XaiRealtimeSession({
    context: {
      callId: record.id,
      callSid: "CA123",
      streamSid: "MZ123",
      telephonySocket: telephonySocket as unknown as WebSocket,
      endCall: async () => {
        ended = true;
      },
    },
    providerSocket,
    repository,
    voice: "ara",
    idleTimeoutMs: 12_000,
  });
  return {
    session,
    repository,
    providerSocket,
    telephonySocket,
    wasEnded: () => ended,
  };
}

test("session config uses native PCMU and server VAD", async () => {
  const { session, providerSocket } = await fixture();
  session.providerOpened();
  const event = JSON.parse(providerSocket.sent[0]);
  assert.equal(event.type, "session.update");
  assert.equal(event.session.audio.input.format.type, "audio/pcmu");
  assert.equal(event.session.audio.output.format.type, "audio/pcmu");
  assert.equal(event.session.turn_detection.type, "server_vad");
  assert.equal(event.session.turn_detection.idle_timeout_ms, 12_000);
  assert.deepEqual(event.session.audio.input.transcription.keyterms.slice(0, 1), [
    "Haladir",
  ]);
  assert.equal(event.session.tools[0].name, "record_call_outcome");
});

test("speech interruption clears Twilio playback and is counted", async () => {
  const { session, repository, telephonySocket } = await fixture();
  await session.handleProviderMessage({
    type: "response.output_audio.delta",
    delta: "audio",
  });
  await session.handleProviderMessage({
    type: "input_audio_buffer.speech_started",
  });
  assert.deepEqual(JSON.parse(telephonySocket.sent.at(-1)!), {
    event: "clear",
    streamSid: "MZ123",
  });
  assert.equal((await repository.get("call-test"))?.interruptionCount, 1);
});

test("valid tool results are persisted and returned to xAI", async () => {
  const { session, repository, providerSocket } = await fixture();
  await session.handleProviderMessage({
    type: "response.output_item.done",
    item: {
      type: "function_call",
      name: "record_call_outcome",
      call_id: "tool-1",
      arguments: JSON.stringify({
        outcome: "manager_available_not_confirmed",
        summary: "Manager is generally present in the morning; visit not welcomed.",
        visitPermission: "present_not_confirmed",
        doNotCall: false,
        confidence: 0.9,
      }),
    },
  });

  const call = await repository.get("call-test");
  assert.equal(call?.outcome?.outcome, "manager_available_not_confirmed");
  assert.equal(call?.outcome?.visitPermission, "present_not_confirmed");
  const events = providerSocket.sent.map((item) => JSON.parse(item));
  assert.equal(events[0].item.type, "function_call_output");
  assert.equal(events[1].type, "response.create");
});

test("current xAI function-call event is persisted", async () => {
  const { session, repository } = await fixture();
  await session.handleProviderMessage({
    type: "response.function_call_arguments.done",
    name: "record_call_outcome",
    call_id: "tool-current",
    arguments: JSON.stringify({
      outcome: "manager_unavailable",
      summary: "The warehouse manager is not on site today.",
      visitPermission: "unknown",
      doNotCall: false,
      confidence: 0.95,
    }),
  });
  assert.equal((await repository.get("call-test"))?.outcome?.outcome, "manager_unavailable");
});

test("opt-out tool result ends the call immediately", async () => {
  const { session, repository, providerSocket, wasEnded } = await fixture();
  await session.handleProviderMessage({
    type: "response.output_item.done",
    item: {
      type: "function_call",
      name: "record_call_outcome",
      call_id: "tool-2",
      arguments: JSON.stringify({
        outcome: "declined_do_not_call",
        summary: "Recipient asked not to be called again.",
        visitPermission: "not_welcomed",
        doNotCall: true,
        confidence: 1,
      }),
    },
  });
  assert.equal((await repository.get("call-test"))?.outcome?.doNotCall, true);
  assert.equal(wasEnded(), true);
  assert.equal(providerSocket.closed, true);
});

test("recoverable provider events are recorded without dropping the call", async () => {
  const { session, repository, providerSocket } = await fixture();
  await session.handleProviderMessage({
    type: "error",
    error: { message: "realtime connection failed" },
  });
  const call = await repository.get("call-test");
  assert.match(call?.error ?? "", /realtime connection failed/);
  assert.equal(call?.outcome, undefined);
  assert.equal(providerSocket.closed, false);
});
