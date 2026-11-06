import WebSocket, { type RawData } from "ws";
import type { CallRepository } from "../store.js";
import { parseOutcomeDetails } from "../domain.js";
import {
  HALADIR_AGENT_PROMPT,
  HALADIR_OPENING,
  OUTCOME_TOOL,
  TRANSCRIPTION_KEYTERMS,
} from "../prompt.js";
import type {
  TelephonyMessage,
  VoiceProviderAdapter,
  VoiceSession,
  VoiceSessionContext,
} from "./voice-provider.js";

type JsonSocket = Pick<WebSocket, "send" | "close" | "readyState">;

type XaiToolCall = {
  type?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
};

type XaiEvent = XaiToolCall & {
  delta?: string;
  transcript?: string;
  item_id?: string;
  response_id?: string;
  item?: XaiToolCall;
  error?: { message?: string };
};

type XaiSessionOptions = {
  context: VoiceSessionContext;
  providerSocket: JsonSocket;
  repository: CallRepository;
  voice: string;
  idleTimeoutMs: number;
};

export class XaiRealtimeSession implements VoiceSession {
  private sessionReady = false;
  private closed = false;
  private assistantSpeaking = false;

  constructor(private readonly options: XaiSessionOptions) {}

  providerOpened() {
    this.sendProvider({
      type: "session.update",
      session: {
        instructions: HALADIR_AGENT_PROMPT,
        voice: this.options.voice,
        audio: {
          input: {
            format: { type: "audio/pcmu" },
            transcription: {
              model: "grok-transcribe",
              language_hint: "en",
              keyterms: [...TRANSCRIPTION_KEYTERMS],
            },
          },
          output: { format: { type: "audio/pcmu" } },
        },
        turn_detection: {
          type: "server_vad",
          idle_timeout_ms: this.options.idleTimeoutMs,
        },
        resumption: { enabled: true },
        tools: [OUTCOME_TOOL],
      },
    });
  }

  async handleTelephonyMessage(message: TelephonyMessage) {
    if (
      message.event === "media" &&
      message.media.track === "inbound" &&
      this.sessionReady &&
      this.options.providerSocket.readyState === WebSocket.OPEN
    ) {
      this.sendProvider({
        type: "input_audio_buffer.append",
        audio: message.media.payload,
      });
    }
    if (message.event === "mark") this.assistantSpeaking = false;
    if (message.event === "stop") this.close();
  }

  async handleProviderRaw(data: RawData | string) {
    try {
      const message = JSON.parse(data.toString()) as XaiEvent;
      await this.handleProviderMessage(message);
    } catch (error) {
      await this.fail(
        `Could not process xAI event: ${(error as Error).message}`,
      );
    }
  }

  async handleProviderMessage(message: XaiEvent) {
    if (message.type === "session.updated") {
      this.sessionReady = true;
      this.sendProvider({
        type: "conversation.item.create",
        item: {
          type: "force_message",
          role: "assistant",
          interruptible: true,
          content: [{ type: "output_text", text: HALADIR_OPENING }],
        },
      });
      return;
    }

    if (message.type === "response.output_audio.delta" && message.delta) {
      this.assistantSpeaking = true;
      this.sendTelephony({
        event: "media",
        streamSid: this.options.context.streamSid,
        media: { payload: message.delta },
      });
      return;
    }

    if (message.type === "input_audio_buffer.speech_started") {
      if (!this.assistantSpeaking) return;
      this.sendTelephony({
        event: "clear",
        streamSid: this.options.context.streamSid,
      });
      this.assistantSpeaking = false;
      const record = await this.options.repository.get(
        this.options.context.callId,
      );
      if (record) {
        await this.options.repository.update(record.id, {
          interruptionCount: record.interruptionCount + 1,
        });
      }
      return;
    }

    if (message.type === "response.done") {
      if (this.assistantSpeaking) {
        this.sendTelephony({
          event: "mark",
          streamSid: this.options.context.streamSid,
          mark: { name: `response-${message.response_id ?? Date.now()}` },
        });
      }
      return;
    }

    if (
      message.type === "response.output_audio_transcript.delta" &&
      message.delta
    ) {
      await this.upsertTranscript(
        "agent",
        message.delta,
        String(message.item_id ?? message.response_id ?? "agent-current"),
        true,
      );
      return;
    }

    if (
      message.type === "conversation.item.input_audio_transcription.updated" &&
      message.transcript
    ) {
      await this.upsertTranscript(
        "recipient",
        message.transcript,
        String(message.item_id ?? "recipient-current"),
        false,
      );
      return;
    }

    if (
      message.type ===
        "conversation.item.input_audio_transcription.completed" &&
      message.transcript
    ) {
      await this.upsertTranscript(
        "recipient",
        message.transcript,
        String(message.item_id ?? "recipient-current"),
        false,
      );
      return;
    }

    if (message.type === "response.function_call_arguments.done") {
      await this.handleToolCall(message);
      return;
    }

    if (
      message.type === "response.output_item.done" &&
      message.item?.type === "function_call"
    ) {
      await this.handleToolCall(message.item);
      return;
    }

    if (message.type === "error") {
      const errorMessage = message.error?.message ?? "Unknown xAI realtime error";
      await this.options.repository.update(this.options.context.callId, {
        error: String(errorMessage).slice(0, 1_000),
      });
    }
  }

  private async upsertTranscript(
    role: "agent" | "recipient",
    text: string,
    sourceId: string,
    append: boolean,
  ) {
    const existing = await this.options.repository.get(
      this.options.context.callId,
    );
    if (!existing) return;
    const index = existing.transcript.findIndex(
      (entry) => entry.role === role && entry.sourceId === sourceId,
    );
    const prior = index >= 0 ? existing.transcript[index].text : "";
    const normalized = (append ? `${prior}${text}` : text)
      .replace(/\s+/g, " ")
      .trim();
    if (!normalized) return;
    const entry = {
      role,
      text: normalized,
      sourceId,
      at: index >= 0 ? existing.transcript[index].at : new Date().toISOString(),
    } as const;
    const transcript = [...existing.transcript];
    if (index >= 0) transcript[index] = entry;
    else transcript.push(entry);
    await this.options.repository.update(existing.id, { transcript });
  }

  private async handleToolCall(item: XaiToolCall) {
    const callId = item.call_id;
    let output: Record<string, unknown>;
    let shouldEnd = false;

    try {
      if (item.name !== "record_call_outcome") {
        throw new Error(`Unknown tool: ${item.name}`);
      }
      const args = JSON.parse(item.arguments ?? "{}");
      const outcome = parseOutcomeDetails(args);
      await this.options.repository.update(this.options.context.callId, {
        outcome,
      });
      shouldEnd = outcome.doNotCall;
      output = { saved: true, outcome: outcome.outcome };
    } catch (error) {
      output = { saved: false, error: (error as Error).message };
    }

    this.sendProvider({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(output),
      },
    });

    if (shouldEnd) {
      await this.endCallSafely("Opt-out hangup failed");
      this.close();
    } else {
      this.sendProvider({ type: "response.create" });
    }
  }

  async fail(message: string) {
    const record = await this.options.repository.get(this.options.context.callId);
    if (record && !record.outcome) {
      await this.options.repository.update(record.id, {
        error: message.slice(0, 1_000),
        outcome: parseOutcomeDetails(
          {
            outcome: "call_failed",
            summary: message,
            visitPermission: "unknown",
            doNotCall: false,
            confidence: 1,
          },
          "system",
        ),
      });
    }
    await this.endCallSafely("Provider-failure hangup failed");
    this.close();
  }

  private async endCallSafely(prefix: string) {
    try {
      await this.options.context.endCall();
    } catch (error) {
      await this.options.repository.update(this.options.context.callId, {
        error: `${prefix}: ${(error as Error).message}`.slice(0, 1_000),
      });
    }
  }

  private sendProvider(payload: unknown) {
    if (this.closed) return;
    this.options.providerSocket.send(JSON.stringify(payload));
  }

  private sendTelephony(payload: unknown) {
    if (this.options.context.telephonySocket.readyState !== WebSocket.OPEN) return;
    this.options.context.telephonySocket.send(JSON.stringify(payload));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.options.providerSocket.close();
  }
}

export class XaiVoiceProvider implements VoiceProviderAdapter {
  constructor(
    private readonly options: {
      apiKey: string;
      realtimeUrl: string;
      voice: string;
      idleTimeoutMs: number;
      repository: CallRepository;
    },
  ) {}

  connect(context: VoiceSessionContext): VoiceSession {
    const providerSocket = new WebSocket(this.options.realtimeUrl, {
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        "Content-Type": "application/json",
      },
    });

    const session = new XaiRealtimeSession({
      context,
      providerSocket,
      repository: this.options.repository,
      voice: this.options.voice,
      idleTimeoutMs: this.options.idleTimeoutMs,
    });

    providerSocket.on("open", () => session.providerOpened());
    providerSocket.on("message", (data) => void session.handleProviderRaw(data));
    providerSocket.on("error", (error) =>
      void session.fail(`xAI WebSocket error: ${error.message}`),
    );
    return session;
  }
}
