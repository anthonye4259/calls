import { createHmac, timingSafeEqual } from "node:crypto";
import twilio from "twilio";

export type SipHeader = { name: string; value: string };

export type XaiIncomingCallEvent = {
  object: "event";
  id: string;
  type: "realtime.call.incoming";
  created_at: number;
  data: {
    call_id: string;
    sip_headers: SipHeader[];
    metadata?: Record<string, unknown>;
  };
};

export function getSipHeader(
  headers: SipHeader[] | undefined,
  name: string,
): string | undefined {
  return headers?.find(
    (header) => header.name.toLowerCase() === name.toLowerCase(),
  )?.value;
}

export function verifyStandardWebhook(input: {
  body: Buffer;
  secret: string;
  webhookId?: string;
  timestamp?: string;
  signature?: string;
  nowSeconds?: number;
  toleranceSeconds?: number;
}): boolean {
  const {
    body,
    secret,
    webhookId,
    timestamp,
    signature,
    nowSeconds = Math.floor(Date.now() / 1_000),
    toleranceSeconds = 300,
  } = input;
  if (!secret || !webhookId || !timestamp || !signature) return false;

  const timestampNumber = Number(timestamp);
  if (
    !Number.isInteger(timestampNumber) ||
    Math.abs(nowSeconds - timestampNumber) > toleranceSeconds
  ) {
    return false;
  }

  try {
    const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
    if (!key.length) return false;
    const signedContent = Buffer.concat([
      Buffer.from(`${webhookId}.${timestamp}.`),
      body,
    ]);
    const expected = createHmac("sha256", key)
      .update(signedContent)
      .digest();

    return signature.split(/\s+/).some((candidate) => {
      const [version, encoded] = candidate.split(",", 2);
      if (version !== "v1" || !encoded) return false;
      const actual = Buffer.from(encoded, "base64");
      return (
        actual.length === expected.length && timingSafeEqual(actual, expected)
      );
    });
  } catch {
    return false;
  }
}

export function buildXaiSipTwiML(input: {
  callId: string;
  sipNumber: string;
  username?: string;
  password?: string;
  statusCallback?: string;
}): string {
  const response = new twilio.twiml.VoiceResponse();
  const dial = response.dial({ timeout: 20 });
  const attributes: {
    username?: string;
    password?: string;
    statusCallback?: string;
    statusCallbackMethod?: string;
    statusCallbackEvent?: Array<
      "initiated" | "ringing" | "answered" | "completed"
    >;
  } = {};
  if (input.username && input.password) {
    attributes.username = input.username;
    attributes.password = input.password;
  }
  if (input.statusCallback) {
    attributes.statusCallback = input.statusCallback;
    attributes.statusCallbackMethod = "POST";
    attributes.statusCallbackEvent = [
      "initiated",
      "ringing",
      "answered",
      "completed",
    ];
  }
  const uri = `sip:${input.sipNumber}@sip.voice.x.ai;transport=tls?x-relay-call-id=${encodeURIComponent(input.callId)}`;
  dial.sip(attributes, uri);
  return response.toString();
}
