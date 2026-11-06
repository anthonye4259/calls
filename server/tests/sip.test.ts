import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  buildXaiSipTwiML,
  getSipHeader,
  verifyStandardWebhook,
} from "../src/sip.js";

test("standard webhook verification uses the exact body and rejects tampering", () => {
  const key = Buffer.from("test-signing-key");
  const secret = `whsec_${key.toString("base64")}`;
  const body = Buffer.from('{"type":"realtime.call.incoming"}');
  const webhookId = "msg_test";
  const timestamp = "1,800,000,000".replaceAll(",", "");
  const signature = createHmac("sha256", key)
    .update(Buffer.concat([Buffer.from(`${webhookId}.${timestamp}.`), body]))
    .digest("base64");

  assert.equal(
    verifyStandardWebhook({
      body,
      secret,
      webhookId,
      timestamp,
      signature: `v1,${signature}`,
      nowSeconds: 1_800_000_010,
    }),
    true,
  );
  assert.equal(
    verifyStandardWebhook({
      body: Buffer.from('{"type":"tampered"}'),
      secret,
      webhookId,
      timestamp,
      signature: `v1,${signature}`,
      nowSeconds: 1_800_000_010,
    }),
    false,
  );
  assert.equal(
    verifyStandardWebhook({
      body,
      secret,
      webhookId,
      timestamp,
      signature: `v1,${signature}`,
      nowSeconds: 1_800_001_000,
    }),
    false,
  );
});

test("SIP helpers preserve the Relay call identifier", () => {
  const xml = buildXaiSipTwiML({
    callId: "relay-call-123",
    sipNumber: "+14045550123",
  });
  assert.match(xml, /sip:\+14045550123@sip\.voice\.x\.ai;transport=tls/);
  assert.match(xml, /x-relay-call-id=relay-call-123/);
  assert.equal(
    getSipHeader(
      [{ name: "X-Relay-Call-Id", value: "relay-call-123" }],
      "x-relay-call-id",
    ),
    "relay-call-123",
  );
});

