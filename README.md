# Relay — Haladir Call & Drop, Phase 1

Relay is a functionality-first prototype for one high-quality AI phone conversation at a time. Twilio originates an authorized, allowlisted test call and connects the answered call to xAI Direct SIP. Grok Voice 3.0 then owns the live audio, server-side turn detection, barge-in, DTMF, call control, transcription, and tool calling.

This repository implements Phase 1 only. It does not discover prospects, import lead lists, run campaigns, or enable unrestricted dialing.

## Why this xAI path

Grok Bot can place and receive calls, but xAI does not currently publish a programmable outbound-call endpoint for the Grok Bot product. The documented developer surface is the [Grok Speech-to-Speech SIP API](https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech/sip) and the [Voice Agent Builder](https://x.ai/news/grok-voice-agent-builder). Relay uses that native xAI stack instead of duplicating its telephony features.

The [Grok Bot call terms](https://x.ai/legal/grok-bot-terms) require callees to have agreed to receive calls and prohibit marketing or mass calls. Relay therefore keeps the explicit authorization checkbox and server-side number allowlist. Do not use this prototype for unsolicited cold calling.

## Call path

```text
Dashboard ──REST──> Relay voice server ──> Twilio outbound PSTN call
                                              │ answered
                                              ▼
                                   Twilio <Dial><Sip>
                                              │
                                              ▼
                               xAI Direct SIP / Grok Voice 3.0
                                              │
                                signed incoming-call webhook
                                              │
                                              ▼
                              Relay joins with call_id WebSocket
```

There is no application-level audio relay in the default path. `XAI_TELEPHONY_MODE=twilio_media_stream` retains the earlier PCMU bridge only as a fallback.

## Reliability and accuracy features

- Fixed, interruptible AI identity disclosure through xAI `force_message`.
- Grok Voice 3.0 with high reasoning effort and server VAD.
- English language hint plus Haladir/logistics keyterms for transcription.
- Native SIP barge-in, DTMF, hangup, and session resumption.
- First-audio latency, real interruption count, and DTMF event count saved with each call.
- Live cumulative recipient transcripts replace earlier partial corrections rather than duplicating them.
- Strict structured outcomes: manager availability cannot be promoted to a welcomed visit, appointments require a date and time, and any do-not-call signal normalizes to the suppression outcome.
- Signed xAI webhook verification using the exact raw request body and Standard Webhooks HMAC format.
- Twilio callback signature validation, explicit recipient authorization, an E.164 allowlist, and company-fact approval before dialing.

## Prerequisites

- Node.js 22.13 or newer.
- An xAI API key with Grok Voice access.
- A Twilio account and voice-capable E.164 number.
- A public HTTPS URL for the voice server.
- At least one recipient who explicitly authorized the test call.

## 1. Local configuration

```bash
npm install
cp .env.example .env.local
```

Set the xAI key, Twilio credentials, `TWILIO_PHONE_NUMBER`, and public HTTPS origin. Add only authorized recipients:

```dotenv
PUBLIC_BASE_URL=https://your-public-voice-server.example
TEST_NUMBER_ALLOWLIST=+14045550123,+14125550123
COMPANY_PROFILE_APPROVED=true
```

Review `server/src/prompt.ts` with an authorized Haladir representative before setting `COMPANY_PROFILE_APPROVED=true`.

## 2. Register the Twilio number with xAI Direct SIP

Register the same Twilio number with xAI and point its webhook at Relay. Use the current Twilio SIP signaling CIDRs from Twilio's documentation; do not substitute the example range below in production.

```bash
curl -X POST "https://api.x.ai/v2/phone-numbers" \
  -H "Authorization: Bearer $XAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "origin": "byo_trunk",
    "name": "Haladir Relay",
    "phone_number": "+14045550123",
    "webhook": {
      "name": "Haladir Relay SIP webhook",
      "url": "https://your-public-voice-server.example/xai/sip-webhook"
    },
    "sip_auth": {
      "allowed_addresses": ["203.0.113.0/24"]
    }
  }'
```

xAI returns `webhook.dispatch_signing_secret` only once. Save it as `XAI_SIP_WEBHOOK_SECRET`. If the SIP registration uses digest authentication instead of IP allowlisting, also set `XAI_SIP_USERNAME` and `XAI_SIP_PASSWORD` so Twilio can authenticate its `<Sip>` leg.

The app sends answered calls to:

```text
sip:{XAI_SIP_NUMBER}@sip.voice.x.ai;transport=tls
```

It adds an `x-relay-call-id` SIP header so the signed xAI incoming-call webhook maps back to the correct local record.

## 3. Run

```bash
npm run dev
```

Open `http://localhost:3000`. All five launch gates must pass before the server accepts a call request. Twilio webhook URLs are supplied on each outbound call.

## Environment reference

| Variable | Required | Purpose |
| --- | --- | --- |
| `XAI_API_KEY` | Yes | Authenticates xAI REST and Realtime APIs. |
| `XAI_TELEPHONY_MODE` | No | Defaults to `xai_sip`; use `twilio_media_stream` only as fallback. |
| `XAI_SIP_WEBHOOK_SECRET` | SIP mode | Verifies signed incoming-call webhooks from xAI. |
| `XAI_SIP_NUMBER` | No | Registered Direct SIP number; defaults to the Twilio number. |
| `XAI_SIP_USERNAME`, `XAI_SIP_PASSWORD` | Sometimes | Twilio-to-xAI digest credentials when configured. |
| `XAI_REALTIME_URL` | No | Defaults to `grok-voice-latest`, currently Grok Voice 3.0. |
| `XAI_VOICE` | No | Defaults to `eve`. |
| `XAI_IDLE_TIMEOUT_MS` | No | Defaults to 12 seconds; valid range is 5–60 seconds. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | Yes | Outbound calls and signed callback verification. |
| `TWILIO_PHONE_NUMBER` | Yes | Caller ID and default Direct SIP number. |
| `PUBLIC_BASE_URL` | Yes | Public HTTPS origin of the voice server. |
| `TEST_NUMBER_ALLOWLIST` | Yes by default | Comma-separated authorized E.164 recipients. |
| `ALLOW_UNRESTRICTED_DIALING` | No | Defaults to false; keep false in Phase 1. |
| `COMPANY_PROFILE_APPROVED` | Yes to call | Confirms the prompt's company facts were reviewed. |
| `VALIDATE_TWILIO_SIGNATURES` | No | Defaults to true. |
| `CALL_STORE_PATH` | No | Defaults to `data/calls.json`. |
| `NEXT_PUBLIC_API_BASE_URL` | No | Dashboard API origin; defaults to `http://localhost:3001`. |

## Verification

```bash
npm run typecheck
npm run lint
npm test
```

The automated suite uses fake sockets and makes no real phone calls. Before accepting Phase 1, run an authorized end-to-end test and review:

1. The AI disclosure is the first spoken line.
2. First audio arrives quickly enough for a natural pickup.
3. The recipient can interrupt without overlapping speech.
4. Names, dates, times, and logistics terms match the audio.
5. Ambiguous availability remains unconfirmed.
6. An opt-out saves immediately and ends both call legs.
7. Twilio completion and xAI/provider failures produce a reviewable terminal state.

Do not begin Phase 2 until an authorized real call passes those checks.
