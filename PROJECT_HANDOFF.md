# Relay / Haladir browser-chat handoff

Use this document as the source of truth when continuing this project in a new ChatGPT Work conversation.

## Project goal

Relay is Haladir's operating system for AI-assisted distributor outreach. Relay owns the distributor database, Haladir information, scripts, call goals, internal notes, authorization records, call schedule, outcomes, and transcripts. Grok Bot is only the calling agent: it receives a complete call brief, prepares a native Call card, conducts the conversation after the operator taps **Call**, and returns the result to Relay.

Functionality and voice accuracy are more important than visual design.

## Live application

- Private Relay dashboard: https://relay-haladir-call-drop.anthonye4259.chatgpt.site
- ChatGPT/MCP endpoint under development: https://relay-haladir-call-drop.anthonye4259.chatgpt.site/mcp
- The Site is private. Do not make it public or expose contact data, transcripts, credentials, or webhook tokens.

## Current workflow

1. Relay selects the next ready distributor.
2. Relay sends Grok a full call brief.
3. Grok creates one native Call card.
4. The operator must tap **Call** in Grok. This platform approval cannot currently be bypassed.
5. Grok conducts the conversation.
6. Grok posts the status, complete speaker-labeled transcript, disposition, summary, callback details, notes, and DNC result to Relay.
7. Relay marks the distributor completed or blocked.
8. Auto-run waits for the callback and the spacing interval before preparing the next card.

## Calling rules

- Monday through Friday only.
- Calling window: 10:00–11:30 AM Eastern.
- Maximum: 10 calls per rolling 24 hours.
- Minimum spacing: 10 minutes between prepared calls.
- Intended slots: 10:00, 10:10, 10:20, 10:30, 10:40, 10:50, 11:00, 11:10, 11:20, and 11:30.
- Maximum four calls to the same number in a rolling 24 hours, though normal operation should not repeatedly dial a completed record.
- One pending Call card at a time.
- Auto-run pauses if the prior callback is missing, Relay loses connection, no ready contacts remain, a limit is reached, or it is outside the calling window.
- Auto-run currently requires the Relay dashboard to remain open. Start it with **Start auto-run**.

## Call behavior

Grok should think like a capable SDR while sounding familiar, friendly, conversational, curious, concise, and low-pressure. It should listen more than it speaks, respond naturally instead of reading a rigid script, and never argue or pressure the recipient.

Goals:

- Build quick rapport and confirm the correct business or person.
- Learn about the warehouse or distribution operation and workflow pain points.
- Identify the person responsible for warehouse operations.
- Explain only the approved Haladir information supplied by Relay.
- Capture interest level, best follow-up time, and a clear agreed next step.
- Respect a no, opt-out, or request to end the call immediately.

Default opening:

> Hi, I'm an AI assistant calling on behalf of Haladir. Is this the warehouse or distribution office?

Haladir is described as an AI logistics software company serving warehouses, independent distributors, and smaller 3PLs. It integrates with WMS, TMS, and ERP systems to automate logistics workflows. Grok must not invent prices, savings, integrations, implementation timelines, appointments, or commitments.

## Data

- An Atlanta small-distributor workbook was imported.
- The primary Prospects sheet supplied 83 ready distributor records.
- Relay uses each company's main business line as the dialing number.
- Decision-maker name, title, direct/mobile number when available, products, category, address, website, phone source, and research notes are attached as call context.
- Direct/mobile numbers are kept as context; the main business line is the default dialing number.
- The operator explicitly authorized this imported list for calling.
- Completed and blocked records are excluded from future ready queues.
- DNC results must remain blocked.

## Relay features already implemented

- Persistent distributor database.
- Haladir knowledge and script editor.
- Call objectives, questions, approved claims, prohibited claims, and agent personality.
- Grok webhook integration and private authorization.
- Rolling call limits and weekday/time-window enforcement.
- Auto-run card preparation while the dashboard remains open.
- Call history with transcripts and outcomes.
- Callback endpoint with request-specific authorization.
- Notes and DNC updates returned to distributor records.
- Private deployment.

## ChatGPT tools implemented at `/mcp`

- `get_relay_status`
- `list_call_queue`
- `get_recent_calls`
- `get_haladir_call_brief`
- `update_haladir_call_brief`
- `add_distributor`
- `update_distributor_notes`

The MCP route is deployed, but the private Site does not yet advertise the OAuth discovery required to install it securely in ChatGPT. Do not make it unauthenticated or public. The next integration task is secure authentication and one-time installation as a custom MCP plugin in ChatGPT.

## Remaining priorities

1. Finish secure ChatGPT MCP authentication and install the Relay plugin.
2. Test every MCP tool with read, write, invalid-input, and authentication cases.
3. Add missing-callback and missing-transcript alerts.
4. Add controlled retry handling without repeatedly calling the same contact.
5. Define voicemail behavior.
6. Add callback/appointment tasks and optional follow-up email drafts.
7. Add transcript quality scoring for friendliness, factual accuracy, useful discovery, and a clear next step.
8. Monitor the outbound number for spam labeling and use a consistent verified business identity.
9. Keep operational scripts and records editable in Relay; use Codex for source-code changes.

## Security requirements

- Never reveal or repeat the Grok webhook authorization token.
- Never put secrets into chat, source code, Git history, call notes, or MCP tool results.
- Preserve owner-private access unless the owner explicitly changes it.
- Require authentication for all ChatGPT tools.
- Treat transcripts, phone numbers, names, direct numbers, notes, and authorization records as private business data.
- Preserve DNC status and call-window enforcement.

## Instructions for the next ChatGPT conversation

Treat this document and the live Relay database as the source of truth. Do not redesign the product unless requested. Prioritize reliability, voice behavior, accurate data flow, safety controls, and reducing repetitive operator actions. Explain unavoidable platform limitations plainly. For operational changes, update Relay data and scripts. For application-code changes, use Codex with the project repository and deploy the validated private Site.

Start by confirming you understand this division:

> Relay owns all intelligence and records. Grok only makes the call and returns what happened.


