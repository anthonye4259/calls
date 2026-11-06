import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";
import type { CallRecord } from "../src/domain.js";
import { XaiSipSession } from "../src/providers/xai-sip.js";
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
    id: "call-sip-test",
    phoneNumber: "+14045550123",
    provider: "xai",
    transport: "xai_sip",
    xaiCallId: "xai-call-test",
    state: "in_progress",
    createdAt: now,
    updatedAt: now,
    authorizedAt: now,
    interruptionCount: 0,
    transcript: [],
  };
  await repository.create(record);
  const providerSocket = new FakeSocket();
  let ended = false;
  const session = new XaiSipSession({
    callId: record.id,
    xaiCallId: record.xaiCallId!,
    providerSocket,
    repository,
    voice: "eve",
    idleTimeoutMs: 12_000,
    endCall: async () => {
      ended = true;
    },
  });
  return {
    session,
    repository,
    providerSocket,
    wasEnded: () => ended,
  };
}

test("native SIP config delegates telephony and starts with a fixed AI disclosure", async () => {
  const { session, providerSocket } = await fixture();
  session.providerOpened();
  await session.handleProviderMessage({ type: "session.updated" });
  const [configuration, opening] = providerSocket.sent.map((item) =>
    JSON.parse(item),
  );
  assert.equal(configuration.session.turn_detection.type, "server_vad");
  assert.equal(configuration.session.resumption.enabled, true);
  assert.equal(configuration.session.audio.input.transcription.language_hint, "en");
  assert.equal(configuration.session.tools[1].name, "send_dtmf");
  assert.equal(opening.item.type, "force_message");
  assert.match(opening.item.content[0].text, /AI assistant/);
});

test("native SIP counts actual barge-ins, latency, and DTMF events", async () => {
  const { session, repository } = await fixture();
  await session.handleProviderMessage({ type: "input_audio_buffer.speech_started" });
  await session.handleProviderMessage({ type: "output_audio_buffer.started" });
  await session.handleProviderMessage({ type: "input_audio_buffer.speech_started" });
  await session.handleProviderMessage({ type: "input_audio_buffer.dtmf_event_received" });
  const record = await repository.get("call-sip-test");
  assert.equal(record?.interruptionCount, 1);
  assert.equal(record?.dtmfEventCount, 1);
  assert.equal(typeof record?.firstAudioLatencyMs, "number");
});

test("cumulative recipient transcripts replace corrections instead of duplicating", async () => {
  const { session, repository } = await fixture();
  await session.handleProviderMessage({
    type: "conversation.item.input_audio_transcription.updated",
    item_id: "recipient-1",
    transcript: "The manager is in on Thursday",
  });
  await session.handleProviderMessage({
    type: "conversation.item.input_audio_transcription.updated",
    item_id: "recipient-1",
    transcript: "The manager isn't in on Thursday",
  });
  const transcript = (await repository.get("call-sip-test"))?.transcript;
  assert.equal(transcript?.length, 1);
  assert.equal(transcript?.[0].text, "The manager isn't in on Thursday");
});

test("a reconnected SIP session resumes without replaying the introduction", async () => {
  const { session, repository } = await fixture();
  session.providerOpened();
  await session.handleProviderMessage({ type: "session.updated" });
  await session.handleProviderMessage({
    type: "conversation.created",
    conversation: { id: "conversation-123" },
  });

  const replacementSocket = new FakeSocket();
  session.replaceProviderSocket(replacementSocket);
  session.providerOpened(true);
  await session.handleProviderMessage({ type: "session.updated" });

  const events = replacementSocket.sent.map((item) => JSON.parse(item));
  assert.equal(events[0].type, "session.update");
  assert.equal(events[1].type, "response.create");
  assert.match(events[1].response.instructions, /connection pause/);
  assert.equal(session.conversationId, "conversation-123");
  assert.equal(
    (await repository.get("call-sip-test"))?.xaiConversationId,
    "conversation-123",
  );
});

test("native SIP saves current tool events and ends an opt-out", async () => {
  const { session, repository, providerSocket, wasEnded } = await fixture();
  await session.handleProviderMessage({
    type: "response.function_call_arguments.done",
    name: "record_call_outcome",
    call_id: "tool-dnc",
    arguments: JSON.stringify({
      outcome: "declined_do_not_call",
      summary: "Recipient asked not to receive another call.",
      visitPermission: "unknown",
      doNotCall: true,
      confidence: 1,
    }),
  });
  assert.equal((await repository.get("call-sip-test"))?.outcome?.doNotCall, true);
  assert.equal(wasEnded(), true);
  assert.equal(providerSocket.closed, true);
});
