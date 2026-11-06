import "dotenv-flow/config";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import express, { type NextFunction, type Request, type Response } from "express";
import twilio from "twilio";
import { WebSocketServer } from "ws";
import { loadConfig, normalizeE164, readiness } from "./config.js";
import { transitionFromTwilioStatus } from "./call-state.js";
import {
  parseOutcomeDetails,
  type CallRecord,
} from "./domain.js";
import { JsonCallRepository } from "./store.js";
import { XaiVoiceProvider } from "./providers/xai-realtime.js";
import {
  XaiSipSession,
  XaiSipVoiceProvider,
} from "./providers/xai-sip.js";
import {
  parseTelephonyMessage,
  type VoiceSession,
} from "./providers/voice-provider.js";
import {
  buildXaiSipTwiML,
  getSipHeader,
  verifyStandardWebhook,
  type XaiIncomingCallEvent,
} from "./sip.js";

const config = loadConfig();
const repository = new JsonCallRepository(config.callStorePath);
const twilioClient = twilio(config.twilioAccountSid, config.twilioAuthToken);
const voiceProvider = new XaiVoiceProvider({
  apiKey: config.xaiApiKey,
  realtimeUrl: config.xaiRealtimeUrl,
  voice: config.xaiVoice,
  idleTimeoutMs: config.xaiIdleTimeoutMs,
  repository,
});
const sipVoiceProvider = new XaiSipVoiceProvider({
  apiKey: config.xaiApiKey,
  realtimeUrl: config.xaiRealtimeUrl,
  voice: config.xaiVoice,
  idleTimeoutMs: config.xaiIdleTimeoutMs,
  repository,
});
const activeSipSessions = new Map<string, XaiSipSession>();
const processedXaiWebhooks = new Set<string>();

const app = express();
type RawBodyRequest = Request & { rawBody?: Buffer };
app.use(
  express.json({
    limit: "100kb",
    verify: (req, _res, body) => {
      (req as RawBodyRequest).rawBody = Buffer.from(body);
    },
  }),
);
app.use(express.urlencoded({ extended: false }));
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", config.dashboardOrigin);
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).send();
  next();
});

const verifyTwilioWebhook = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (!config.validateTwilioSignatures) return next();
  const signature = req.header("x-twilio-signature");
  const url = `${config.publicBaseUrl}${req.originalUrl}`;
  if (
    !signature ||
    !config.twilioAuthToken ||
    !twilio.validateRequest(config.twilioAuthToken, signature, url, req.body)
  ) {
    return res.status(403).send("Invalid Twilio signature");
  }
  next();
};

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/api/config", (_req, res) => {
  res.json({
    ...readiness(config),
    mode: config.allowUnrestrictedDialing ? "unrestricted" : "allowlist_only",
    allowlistedNumbers: config.testNumberAllowlist.size,
    voiceProvider:
      config.telephonyMode === "xai_sip"
        ? "xAI Grok Voice 3.0 · native SIP"
        : "xAI Grok Voice · Twilio media fallback",
  });
});

app.get("/api/calls", async (_req, res, next) => {
  try {
    res.json({ calls: await repository.list() });
  } catch (error) {
    next(error);
  }
});

app.get("/api/calls/:id", async (req, res, next) => {
  try {
    const call = await repository.get(req.params.id);
    if (!call) return res.status(404).json({ error: "Call not found" });
    res.json({ call });
  } catch (error) {
    next(error);
  }
});

app.post("/api/calls", async (req, res, next) => {
  try {
    const phoneNumber = normalizeE164(String(req.body.phoneNumber ?? ""));
    if (!phoneNumber) {
      return res.status(400).json({ error: "Enter a valid E.164 phone number" });
    }
    if (req.body.authorized !== true) {
      return res.status(400).json({
        error: "Confirm that the recipient authorized this test call",
      });
    }
    if (
      !config.allowUnrestrictedDialing &&
      !config.testNumberAllowlist.has(phoneNumber)
    ) {
      return res.status(403).json({
        error: "That number is not on TEST_NUMBER_ALLOWLIST",
      });
    }
    const ready = readiness(config);
    if (!ready.ready) {
      return res.status(503).json({
        error: "Calling is locked until all configuration checks pass",
        checks: ready.checks,
      });
    }

    const now = new Date().toISOString();
    const record: CallRecord = {
      id: randomUUID(),
      phoneNumber,
      provider: "xai",
      transport: config.telephonyMode,
      state: "initiating",
      createdAt: now,
      updatedAt: now,
      authorizedAt: now,
      interruptionCount: 0,
      transcript: [],
    };
    await repository.create(record);

    try {
      const call = await twilioClient.calls.create({
        to: phoneNumber,
        from: config.twilioPhoneNumber,
        url: `${config.publicBaseUrl}/twilio/voice?callId=${record.id}`,
        method: "POST",
        statusCallback: `${config.publicBaseUrl}/twilio/status?callId=${record.id}`,
        statusCallbackMethod: "POST",
        statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      });
      const updated = await repository.update(record.id, {
        twilioCallSid: call.sid,
        state: transitionFromTwilioStatus(record.state, call.status ?? "queued"),
        rawTwilioStatus: call.status ?? "queued",
      });
      return res.status(201).json({ call: updated });
    } catch (error) {
      const message = (error as Error).message;
      const outcome = parseOutcomeDetails(
        {
          outcome: "call_failed",
          summary: message,
          visitPermission: "unknown",
          doNotCall: false,
          confidence: 1,
        },
        "system",
      );
      const failed = await repository.update(record.id, {
        state: "failed",
        error: message,
        outcome,
        completedAt: new Date().toISOString(),
      });
      return res.status(502).json({ error: message, call: failed });
    }
  } catch (error) {
    next(error);
  }
});

app.patch("/api/calls/:id/outcome", async (req, res, next) => {
  try {
    const existing = await repository.get(req.params.id);
    if (!existing) return res.status(404).json({ error: "Call not found" });
    const outcome = parseOutcomeDetails(req.body, "human");
    const call = await repository.update(existing.id, { outcome });
    res.json({ call });
  } catch (error) {
    if (error instanceof Error) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

app.post("/xai/sip-webhook", async (req, res, next) => {
  try {
    if (config.telephonyMode !== "xai_sip") {
      return res.status(404).send("Native SIP is disabled");
    }

    const rawBody = (req as RawBodyRequest).rawBody;
    const webhookId = req.header("webhook-id") ?? undefined;
    if (
      !rawBody ||
      !verifyStandardWebhook({
        body: rawBody,
        secret: config.xaiSipWebhookSecret,
        webhookId,
        timestamp: req.header("webhook-timestamp") ?? undefined,
        signature: req.header("webhook-signature") ?? undefined,
      })
    ) {
      return res.status(403).send("Invalid xAI webhook signature");
    }

    if (webhookId && processedXaiWebhooks.has(webhookId)) {
      return res.status(204).send();
    }

    const event = req.body as Partial<XaiIncomingCallEvent>;
    if (event.type !== "realtime.call.incoming") {
      return res.status(204).send();
    }
    const xaiCallId = event.data?.call_id;
    const callId = getSipHeader(
      event.data?.sip_headers,
      "x-relay-call-id",
    );
    if (!xaiCallId || !callId) {
      return res.status(400).send("Missing xAI call or Relay call identifier");
    }

    const record = await repository.get(callId);
    if (!record || record.transport !== "xai_sip") {
      return res.status(404).send("Unknown SIP call");
    }

    if (webhookId) {
      if (processedXaiWebhooks.size >= 1_000) processedXaiWebhooks.clear();
      processedXaiWebhooks.add(webhookId);
    }
    if (activeSipSessions.has(callId)) return res.status(202).send();

    await repository.update(callId, {
      xaiCallId,
      state: "in_progress",
      connectedAt: record.connectedAt ?? new Date().toISOString(),
    });

    const session = sipVoiceProvider.connect({
      callId,
      xaiCallId,
      endCall: async () => {
        let hangupError: Error | undefined;
        try {
          const hangupResponse = await fetch(
            `${config.xaiApiBaseUrl}/v1/realtime/calls/${encodeURIComponent(xaiCallId)}/hangup`,
            {
              method: "POST",
              headers: { Authorization: `Bearer ${config.xaiApiKey}` },
            },
          );
          if (!hangupResponse.ok && hangupResponse.status !== 409) {
            hangupError = new Error(
              `xAI hangup failed (${hangupResponse.status})`,
            );
          }
        } catch (error) {
          hangupError = error as Error;
        }

        const current = await repository.get(callId);
        if (current?.twilioCallSid) {
          await twilioClient.calls(current.twilioCallSid).update({
            status: "completed",
          });
        }
        if (hangupError) throw hangupError;
      },
      onClose: () => {
        if (activeSipSessions.get(callId) === session) {
          activeSipSessions.delete(callId);
        }
      },
    });
    activeSipSessions.set(callId, session);
    return res.status(202).send();
  } catch (error) {
    next(error);
  }
});

app.post("/twilio/voice", verifyTwilioWebhook, async (req, res, next) => {
  try {
    const callId = String(req.query.callId ?? "");
    const record = await repository.get(callId);
    if (!record) return res.status(404).send("Unknown call");

    if (record.transport === "xai_sip") {
      const response = buildXaiSipTwiML({
        callId,
        sipNumber: config.xaiSipNumber,
        username: config.xaiSipUsername,
        password: config.xaiSipPassword,
      });
      return res.type("text/xml").send(response);
    }

    const response = new twilio.twiml.VoiceResponse();
    const connect = response.connect();
    const publicUrl = new URL(config.publicBaseUrl);
    publicUrl.protocol = "wss:";
    publicUrl.pathname = "/media-stream";
    publicUrl.search = "";
    const stream = connect.stream({ url: publicUrl.toString() });
    stream.parameter({ name: "callId", value: callId });
    res.type("text/xml").send(response.toString());
  } catch (error) {
    next(error);
  }
});

app.post("/twilio/status", verifyTwilioWebhook, async (req, res, next) => {
  try {
    const callId = String(req.query.callId ?? "");
    const record = await repository.get(callId);
    if (!record) return res.status(204).send();

    const rawStatus = String(req.body.CallStatus ?? "");
    const state = transitionFromTwilioStatus(record.state, rawStatus);
    const patch: Partial<CallRecord> = {
      state,
      rawTwilioStatus: rawStatus,
      twilioCallSid: String(req.body.CallSid ?? record.twilioCallSid ?? ""),
    };
    if (state === "in_progress" && !record.connectedAt) {
      patch.connectedAt = new Date().toISOString();
    }
    if (["completed", "busy", "no_answer", "canceled", "failed"].includes(state)) {
      patch.completedAt = new Date().toISOString();
      activeSipSessions.get(record.id)?.close();
      activeSipSessions.delete(record.id);
      if (!record.outcome) {
        const isNoAnswer = state === "no_answer" || state === "busy";
        patch.outcome = parseOutcomeDetails(
          {
            outcome: isNoAnswer ? "no_answer_voicemail" : "needs_review",
            summary: isNoAnswer
              ? `Twilio ended the call with status ${rawStatus}.`
              : "The call ended without a final AI outcome and needs review.",
            visitPermission: "unknown",
            doNotCall: false,
            confidence: isNoAnswer ? 1 : 0,
          },
          "system",
        );
      }
    }
    await repository.update(record.id, patch);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

app.use(
  (
    error: Error,
    _req: Request,
    res: Response,
    _next: NextFunction,
  ) => {
    void _next;
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  },
);

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  if (pathname !== "/media-stream") {
    socket.destroy();
    return;
  }

  if (config.validateTwilioSignatures) {
    const signature = request.headers["x-twilio-signature"];
    const publicWsUrl = new URL(config.publicBaseUrl);
    publicWsUrl.protocol = "wss:";
    publicWsUrl.pathname = "/media-stream";
    publicWsUrl.search = "";
    if (
      typeof signature !== "string" ||
      !twilio.validateRequest(
        config.twilioAuthToken,
        signature,
        publicWsUrl.toString(),
        {},
      )
    ) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
  }

  wss.handleUpgrade(request, socket, head, (webSocket) => {
    wss.emit("connection", webSocket, request);
  });
});

wss.on("connection", (telephonySocket) => {
  let voiceSession: VoiceSession | undefined;
  let activeCallId: string | undefined;

  telephonySocket.on("message", async (data) => {
    const message = parseTelephonyMessage(data);
    if (!message) return;

    if (message.event === "start") {
      activeCallId = message.start.customParameters?.callId;
      const record = activeCallId
        ? await repository.get(activeCallId)
        : undefined;
      if (!record || !activeCallId) {
        telephonySocket.close(1008, "Unknown call");
        return;
      }
      await repository.update(activeCallId, {
        state: "in_progress",
        connectedAt: record.connectedAt ?? new Date().toISOString(),
        twilioCallSid: message.start.callSid,
      });
      voiceSession = voiceProvider.connect({
        callId: activeCallId,
        callSid: message.start.callSid,
        streamSid: message.start.streamSid,
        telephonySocket,
        endCall: async () => {
          await twilioClient.calls(message.start.callSid).update({
            status: "completed",
          });
        },
      });
    }

    await voiceSession?.handleTelephonyMessage(message);
  });

  telephonySocket.on("close", () => voiceSession?.close());
  telephonySocket.on("error", async (error) => {
    if (activeCallId) {
      await repository.update(activeCallId, { error: error.message });
    }
    voiceSession?.close();
  });
});

server.listen(config.port, () => {
  const status = readiness(config);
  console.log(
    `Haladir voice server listening on http://localhost:${config.port} (${status.ready ? "ready" : "configuration locked"})`,
  );
});

export { app, server };
