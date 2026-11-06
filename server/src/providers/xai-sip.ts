import WebSocket, { type RawData } from "ws";
import type { CallRepository } from "../store.js";
import { parseOutcomeDetails } from "../domain.js";
import {
  HALADIR_AGENT_PROMPT,
  HALADIR_OPENING,
  OUTCOME_TOOL,
  TRANSCRIPTION_KEYTERMS,
} from "../prompt.js";

type JsonSocket = Pick<WebSocket, "send" | "close" | "readyState">;

type XaiToolCall = {
  type?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
};

type XaiSipEvent = XaiToolCall & {
  delta?: string;
  transcript?: string;
  item_id?: string;
  response_id?: string;
  item?: XaiToolCall;
  conversation?: { id?: string };
  error?: { message?: string };
};

type XaiSipSessionOptions = {
  callId: string;
  xaiCallId: string;
  providerSocket: JsonSocket;
  repository: CallRepository;
  voice: string;
  idleTimeoutMs: number;
  endCall: () => Promise<void>;
};

export class XaiSipSession {
  private closed = false;
  private greeted = false;
  private assistantSpeaking = false;
  private pendingResponse = false;
  private pendingHangup = false;
  private failing = false;
  private resumeAfterUpdate = false;
  private activeConversationId?: string;
  private readonly startedAt = Date.now();

  constructor(private readonly options: XaiSipSessionOptions) {}

  get isClosed() {
    return this.closed;
  }

  get conversationId() {
    return this.activeConversationId;
  }

  replaceProviderSocket(providerSocket: JsonSocket) {
    this.options.providerSocket = providerSocket;
  }

  providerOpened(isReconnect = false) {
    this.resumeAfterUpdate = isReconnect;
    this.sendProvider({
      type: "session.update",
      session: {
        instructions: HALADIR_AGENT_PROMPT,
        voice: this.options.voice,
        reasoning: { effort: "high" },
        turn_detection: {
          type: "server_vad",
          idle_timeout_ms: this.options.idleTimeoutMs,
        },
        audio: {
          input: {
            transcription: {
              model: "grok-transcribe",
              language_hint: "en",
              keyterms: [...TRANSCRIPTION_KEYTERMS],
            },
          },
        },
        resumption: { enabled: true },
        tools: [OUTCOME_TOOL, { type: "function", name: "send_dtmf" }],
      },
    });
  }

  async handleProviderRaw(data: RawData | string) {
    try {
      const message = JSON.parse(data.toString()) as XaiSipEvent;
      await this.handleProviderMessage(message);
    } catch (error) {
      await this.fail(
        `Could not process xAI SIP event: ${(error as Error).message}`,
      );
    }
  }

  async handleProviderMessage(message: XaiSipEvent) {
    if (message.type === "session.updated" && !this.greeted) {
      this.greeted = true;
      this.resumeAfterUpdate = false;
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

    if (message.type === "session.updated" && this.resumeAfterUpdate) {
      this.resumeAfterUpdate = false;
      this.sendProvider({
        type: "response.create",
        response: {
          instructions:
            "Briefly apologize for the connection pause, then continue the last unresolved question without repeating the whole introduction.",
        },
      });
      return;
    }

    if (message.type === "conversation.created" && message.conversation?.id) {
      this.activeConversationId = String(message.conversation.id);
      await this.options.repository.update(this.options.callId, {
        xaiConversationId: this.activeConversationId,
      });
      return;
    }

    if (
      message.type === "output_audio_buffer.started" ||
      (message.type === "response.output_audio.delta" && !this.assistantSpeaking)
    ) {
      this.assistantSpeaking = true;
      await this.captureFirstAudioLatency();
      return;
    }

    if (
      message.type === "output_audio_buffer.stopped" ||
      message.type === "output_audio_buffer.cleared"
    ) {
      this.assistantSpeaking = false;
      await this.flushPendingAction();
      return;
    }

    if (message.type === "input_audio_buffer.speech_started") {
      if (this.assistantSpeaking) await this.countInterruption();
      return;
    }

    if (
      message.type === "response.output_audio_transcript.delta" &&
      typeof message.delta === "string"
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
      typeof message.transcript === "string"
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
      typeof message.transcript === "string"
    ) {
      await this.upsertTranscript(
        "recipient",
        message.transcript,
        String(message.item_id ?? "recipient-current"),
        false,
      );
      return;
    }

    if (message.type === "input_audio_buffer.dtmf_event_received") {
      const record = await this.options.repository.get(this.options.callId);
      if (record) {
        await this.options.repository.update(record.id, {
          dtmfEventCount: (record.dtmfEventCount ?? 0) + 1,
        });
      }
      return;
    }

    if (message.type === "response.function_call_arguments.done") {
      if (message.name === "send_dtmf") return;
      await this.handleToolCall(message);
      return;
    }

    if (
      message.type === "response.output_item.done" &&
      message.item?.type === "function_call"
    ) {
      if (message.item.name === "send_dtmf") return;
      await this.handleToolCall(message.item);
      return;
    }

    if (message.type === "error") {
      const errorMessage = message.error?.message ?? "Unknown xAI SIP error";
      await this.options.repository.update(this.options.callId, {
        error: String(errorMessage).slice(0, 1_000),
      });
    }
  }

  private async captureFirstAudioLatency() {
    const record = await this.options.repository.get(this.options.callId);
    if (record && record.firstAudioLatencyMs === undefined) {
      await this.options.repository.update(record.id, {
        firstAudioLatencyMs: Date.now() - this.startedAt,
      });
    }
  }

  private async countInterruption() {
    const record = await this.options.repository.get(this.options.callId);
    if (record) {
      await this.options.repository.update(record.id, {
        interruptionCount: record.interruptionCount + 1,
      });
    }
  }

  private async upsertTranscript(
    role: "agent" | "recipient",
    text: string,
    sourceId: string,
    append: boolean,
  ) {
    const existing = await this.options.repository.get(this.options.callId);
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
    const toolCallId = item.call_id;
    let output: Record<string, unknown>;
    let shouldEnd = false;

    try {
      if (item.name !== "record_call_outcome") {
        throw new Error(`Unknown tool: ${item.name}`);
      }
      const args = JSON.parse(item.arguments ?? "{}");
      const outcome = parseOutcomeDetails(args);
      await this.options.repository.update(this.options.callId, { outcome });
      shouldEnd = outcome.doNotCall;
      output = { saved: true, outcome: outcome.outcome };
    } catch (error) {
      output = { saved: false, error: (error as Error).message };
    }

    this.sendProvider({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: toolCallId,
        output: JSON.stringify(output),
      },
    });

    if (shouldEnd) this.pendingHangup = true;
    else this.pendingResponse = true;
    if (!this.assistantSpeaking) await this.flushPendingAction();
  }

  private async flushPendingAction() {
    if (this.pendingHangup) {
      this.pendingHangup = false;
      await this.endCallSafely("Opt-out hangup failed");
      this.close();
      return;
    }
    if (this.pendingResponse) {
      this.pendingResponse = false;
      this.sendProvider({ type: "response.create" });
    }
  }

  async fail(message: string) {
    if (this.failing || this.closed) return;
    this.failing = true;
    const record = await this.options.repository.get(this.options.callId);
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
    this.failing = false;
  }

  private async endCallSafely(prefix: string) {
    try {
      await this.options.endCall();
    } catch (error) {
      await this.options.repository.update(this.options.callId, {
        error: `${prefix}: ${(error as Error).message}`.slice(0, 1_000),
      });
    }
  }

  private sendProvider(payload: unknown) {
    if (this.closed || this.options.providerSocket.readyState !== WebSocket.OPEN) {
      return;
    }
    this.options.providerSocket.send(JSON.stringify(payload));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.options.providerSocket.close();
  }
}

export class XaiSipVoiceProvider {
  constructor(
    private readonly options: {
      apiKey: string;
      realtimeUrl: string;
      voice: string;
      idleTimeoutMs: number;
      repository: CallRepository;
    },
  ) {}

  connect(context: {
    callId: string;
    xaiCallId: string;
    endCall: () => Promise<void>;
    onClose?: () => void;
  }): XaiSipSession {
    let session: XaiSipSession | undefined;
    let reconnectAttempts = 0;
    let lastSocketError = "";

    const openSocket = (isReconnect: boolean) => {
      if (session?.isClosed) {
        context.onClose?.();
        return;
      }
      lastSocketError = "";
      const url = new URL(this.options.realtimeUrl);
      url.search = "";
      url.searchParams.set("call_id", context.xaiCallId);
      if (isReconnect && session?.conversationId) {
        url.searchParams.set("conversation_id", session.conversationId);
      }

      const providerSocket = new WebSocket(url, {
        headers: { Authorization: `Bearer ${this.options.apiKey}` },
      });
      if (session) session.replaceProviderSocket(providerSocket);
      else {
        session = new XaiSipSession({
          ...context,
          providerSocket,
          repository: this.options.repository,
          voice: this.options.voice,
          idleTimeoutMs: this.options.idleTimeoutMs,
        });
      }
      const activeSession = session;

      providerSocket.on("open", () => {
        if (isReconnect) {
          void this.noteReconnect(context.callId);
        }
        activeSession.providerOpened(isReconnect);
      });
      providerSocket.on("message", (data) =>
        void activeSession.handleProviderRaw(data),
      );
      providerSocket.on("error", (error) => {
        lastSocketError = error.message;
      });
      providerSocket.on("close", (code) => {
        if (activeSession.isClosed) {
          context.onClose?.();
          return;
        }

        if ([1006, 1011].includes(code) && reconnectAttempts < 2) {
          reconnectAttempts += 1;
          setTimeout(
            () => openSocket(true),
            250 * 2 ** (reconnectAttempts - 1),
          );
          return;
        }

        if ([1006, 1011].includes(code)) {
          const detail = lastSocketError ? `: ${lastSocketError}` : "";
          void activeSession
            .fail(`xAI SIP WebSocket closed unexpectedly (${code})${detail}`)
            .finally(() => context.onClose?.());
          return;
        }
        context.onClose?.();
      });
    };

    openSocket(false);
    if (!session) throw new Error("Could not initialize xAI SIP session");
    return session;
  }

  private async noteReconnect(callId: string) {
    const record = await this.options.repository.get(callId);
    if (record) {
      await this.options.repository.update(callId, {
        providerReconnectCount: (record.providerReconnectCount ?? 0) + 1,
      });
    }
  }
}
