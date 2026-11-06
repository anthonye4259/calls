"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, "") ??
  "";

type CallState =
  | "queued"
  | "initiating"
  | "ringing"
  | "in_progress"
  | "completed"
  | "busy"
  | "no_answer"
  | "canceled"
  | "failed";

type Outcome = {
  outcome: string;
  summary: string;
  contactName?: string;
  contactTitle?: string;
  managerAvailability?: string;
  visitPermission: string;
  visitDate?: string;
  visitTime?: string;
  accessInstructions?: string;
  notes?: string;
  doNotCall: boolean;
  confidence: number;
  capturedBy: "ai" | "human" | "system";
};

type Call = {
  id: string;
  phoneNumber: string;
  state: CallState;
  createdAt: string;
  updatedAt: string;
  transport: "grok_bot_call_card" | "xai_sip" | "twilio_media_stream";
  interruptionCount: number;
  firstAudioLatencyMs?: number;
  dtmfEventCount?: number;
  providerReconnectCount?: number;
  transcript: Array<{ role: "agent" | "recipient"; text: string; at: string }>;
  outcome?: Outcome;
  error?: string;
};

type Config = {
  ready: boolean;
  checks: Record<string, boolean>;
  mode: string;
  allowlistedNumbers: number;
  dailyLimit?: number;
  callingWindow?: string;
  minimumSpacingMinutes?: number;
  voiceProvider: string;
};

type Distributor = {
  id: string;
  company: string;
  phoneNumber: string;
  city: string;
  state: string;
  contactName?: string;
  consentSource: string;
  consentTimestamp: string;
  internalNotes: string;
  status: "ready" | "research" | "completed" | "blocked";
  callNotes?: string;
};

type RelayProfile = {
  companyName: string;
  companySummary: string;
  valueProposition: string;
  defaultObjective: string;
  openingStatement: string;
  questionsToAsk: string[];
  approvedClaims: string[];
  prohibitedClaims: string[];
  agentStyle: string;
};

const OUTCOME_LABELS: Record<string, string> = {
  visit_welcomed: "Visit welcomed",
  manager_available_not_confirmed: "Manager available — not confirmed",
  appointment_scheduled: "Appointment scheduled",
  manager_unavailable: "Manager unavailable",
  callback_requested: "Callback requested",
  wrong_business_or_number: "Wrong business or number",
  not_qualified: "Not qualified",
  declined_do_not_call: "Declined / do not call",
  no_answer_voicemail: "No answer / voicemail",
  call_failed: "Call failed",
  needs_review: "Needs review",
};

const OUTCOME_OPTIONS = Object.entries(OUTCOME_LABELS);

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatPhone(value: string) {
  if (/^\+1\d{10}$/.test(value)) {
    return `(${value.slice(2, 5)}) ${value.slice(5, 8)}–${value.slice(8)}`;
  }
  return value;
}

function statusLabel(state: CallState) {
  return state.replaceAll("_", " ");
}

function isEasternCallWindow(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  if (["Sat", "Sun"].includes(part("weekday"))) return false;
  const minutes = Number(part("hour")) * 60 + Number(part("minute"));
  return minutes >= 10 * 60 && minutes <= 11 * 60 + 30;
}

export function Dashboard() {
  const [calls, setCalls] = useState<Call[]>([]);
  const [config, setConfig] = useState<Config | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [phoneNumber, setPhoneNumber] = useState("");
  const [authorized, setAuthorized] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [backendOnline, setBackendOnline] = useState(true);
  const [distributors, setDistributors] = useState<Distributor[]>([]);
  const [profile, setProfile] = useState<RelayProfile | null>(null);
  const [autoRun, setAutoRun] = useState(false);
  const autoPreparing = useRef(false);

  const load = useCallback(async () => {
    try {
      const [callsResponse, configResponse, distributorsResponse, profileResponse] = await Promise.all([
        fetch(`${API_BASE}/api/calls`, { cache: "no-store" }),
        fetch(`${API_BASE}/api/config`, { cache: "no-store" }),
        fetch(`${API_BASE}/api/distributors`, { cache: "no-store" }),
        fetch(`${API_BASE}/api/relay-profile`, { cache: "no-store" }),
      ]);
      if (!callsResponse.ok || !configResponse.ok || !distributorsResponse.ok || !profileResponse.ok) throw new Error("offline");
      const callsPayload = (await callsResponse.json()) as { calls: Call[] };
      setCalls(callsPayload.calls);
      setConfig((await configResponse.json()) as Config);
      const distributorPayload = (await distributorsResponse.json()) as { distributors: Distributor[] };
      setDistributors(distributorPayload.distributors);
      setProfile(((await profileResponse.json()) as { profile: RelayProfile }).profile);
      setBackendOnline(true);
      if (!selectedId && callsPayload.calls[0]) {
        setSelectedId(callsPayload.calls[0].id);
      }
    } catch {
      setBackendOnline(false);
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => void load(), 3_000);
    return () => {
      window.clearTimeout(initialLoad);
      window.clearInterval(timer);
    };
  }, [load]);

  useEffect(() => {
    const saved = window.localStorage.getItem("relay-auto-run") === "true";
    setAutoRun(saved);
  }, []);

  const selectedCall = calls.find((call) => call.id === selectedId) ?? null;
  const metrics = useMemo(() => {
    const connected = calls.filter((call) =>
      ["in_progress", "completed"].includes(call.state),
    ).length;
    const useful = calls.filter(
      (call) =>
        call.outcome &&
        !["no_answer_voicemail", "call_failed", "needs_review"].includes(
          call.outcome.outcome,
        ),
    ).length;
    const welcomed = calls.filter((call) =>
      ["visit_welcomed", "appointment_scheduled"].includes(
        call.outcome?.outcome ?? "",
      ),
    ).length;
    const optOuts = calls.filter((call) => call.outcome?.doNotCall).length;
    return { attempted: calls.length, connected, useful, welcomed, optOuts };
  }, [calls]);

  async function startCall(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setNotice(null);
    try {
      const response = await fetch(`${API_BASE}/api/calls`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phoneNumber, authorized }),
      });
      const payload = (await response.json()) as {
        error?: string;
        call?: Call;
      };
      if (!response.ok || !payload.call) {
        throw new Error(payload.error ?? "The call could not be started");
      }
      setSelectedId(payload.call.id);
      setPhoneNumber("");
      setAuthorized(false);
      setNotice("Call card prepared in Grok Bot. Open Grok Bot and tap it to call.");
      await load();
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function addDistributor(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setNotice(null);
    const data = new FormData(event.currentTarget);
    try {
      const response = await fetch(`${API_BASE}/api/distributors`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.fromEntries(data)),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Could not save distributor");
      event.currentTarget.reset();
      setNotice("Distributor saved in Relay. Records without permission remain research-only.");
      await load();
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function prepareDistributor(distributorId: string) {
    setSubmitting(true);
    setNotice(null);
    try {
      const response = await fetch(`${API_BASE}/api/calls`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ distributorId, authorized: true }),
      });
      const payload = (await response.json()) as { error?: string; call?: Call };
      if (!response.ok || !payload.call) throw new Error(payload.error ?? "Could not prepare Call card");
      setSelectedId(payload.call.id);
      setNotice("Relay sent the full distributor brief to Grok Bot. Tap its Call card to begin.");
      await load();
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  useEffect(() => {
    if (!autoRun) return;
    const tick = async () => {
      if (autoPreparing.current || submitting || !backendOnline) return;
      if (!isEasternCallWindow()) return;
      const latest = calls[0];
      if (latest?.state === "queued") return;
      if (latest && Date.now() < new Date(latest.createdAt).getTime() + 10 * 60 * 1_000) return;
      const next = distributors.find((distributor) => distributor.status === "ready");
      if (!next) {
        setNotice("Auto-run is waiting because there are no ready distributors.");
        return;
      }
      autoPreparing.current = true;
      try {
        const response = await fetch(`${API_BASE}/api/calls`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ distributorId: next.id, authorized: true }),
        });
        const payload = (await response.json()) as { error?: string; call?: Call };
        if (!response.ok || !payload.call) {
          if (response.status !== 429 && response.status !== 403) {
            setNotice(payload.error ?? "Auto-run could not prepare the next card.");
          }
          return;
        }
        setSelectedId(payload.call.id);
        setNotice(`Auto-run prepared ${next.company}. Tap Call in Grok Bot.`);
        await load();
      } catch {
        setNotice("Auto-run lost its connection to Relay and will retry safely.");
      } finally {
        autoPreparing.current = false;
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 15_000);
    return () => window.clearInterval(timer);
  }, [autoRun, backendOnline, calls, distributors, load, submitting]);

  function toggleAutoRun() {
    const next = !autoRun;
    setAutoRun(next);
    window.localStorage.setItem("relay-auto-run", String(next));
    setNotice(
      next
        ? "Auto-run started. Relay will prepare the next card after each callback and 10-minute interval."
        : "Auto-run stopped. No additional cards will be prepared automatically.",
    );
  }

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    const data = new FormData(event.currentTarget);
    const lines = (name: string) => String(data.get(name) ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
    try {
      const response = await fetch(`${API_BASE}/api/relay-profile`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyName: data.get("companyName"),
          companySummary: data.get("companySummary"),
          valueProposition: data.get("valueProposition"),
          defaultObjective: data.get("defaultObjective"),
          openingStatement: data.get("openingStatement"),
          questionsToAsk: lines("questionsToAsk"),
          approvedClaims: lines("approvedClaims"),
          prohibitedClaims: lines("prohibitedClaims"),
          agentStyle: data.get("agentStyle"),
        }),
      });
      if (!response.ok) throw new Error("Could not save the agent brief");
      setNotice("Relay's Haladir knowledge and call script were saved.");
      await load();
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-mark">R</div>
          <div>
            <strong>Relay</strong>
            <span>by Haladir Labs</span>
          </div>
        </div>

        <nav aria-label="Primary navigation">
          <a className="nav-item active" href="#overview">
            <span>01</span> Overview
          </a>
          <a className="nav-item" href="#calls">
            <span>02</span> Call history
          </a>
          <a className="nav-item" href="#agent">
            <span>03</span> Agent profile
          </a>
        </nav>

        <div className="sidebar-foot">
          <div className={`status-dot ${backendOnline ? "online" : ""}`} />
          <div>
            <strong>{backendOnline ? "Grok Bot connected" : "Call service offline"}</strong>
            <span>{config?.voiceProvider ?? "Grok Bot Call cards"}</span>
          </div>
        </div>
      </aside>

      <section className="workspace" id="overview">
        <header className="topbar">
          <div>
            <p className="eyebrow">PHASE 1 · AUTHORIZED TESTING</p>
            <h1>Call & Drop console</h1>
          </div>
          <div className="safety-pill">
            <span>●</span> One-tap authorization
          </div>
        </header>

        <section className="hero-grid">
          <div className="launch-card">
            <div className="card-heading">
              <div>
                <p className="eyebrow">NEW CALL</p>
                <h2>Start one careful conversation.</h2>
              </div>
              <span className="call-number">01</span>
            </div>
            <p className="lead">
              Relay prepares a native Grok Bot Call card. You tap once in Grok
              Bot, then the agent handles the authorized conversation.
            </p>
            <form onSubmit={startCall}>
              <label htmlFor="phone-number">Authorized test number</label>
              <div className="phone-row">
                <input
                  id="phone-number"
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  placeholder="+1 404 555 0123"
                  value={phoneNumber}
                  onChange={(event) => setPhoneNumber(event.target.value)}
                  required
                />
                <button
                  className="primary-button"
                  type="submit"
                  disabled={submitting || !backendOnline}
                >
                  {submitting ? "Preparing…" : "Prepare Call card"}
                </button>
              </div>
              <label className="consent-row">
                <input
                  type="checkbox"
                  checked={authorized}
                  onChange={(event) => setAuthorized(event.target.checked)}
                  required
                />
                <span>
                  I confirm this recipient authorized this call and the stated
                  follow-up purpose.
                </span>
              </label>
            </form>
            {notice && <div className="notice" role="status">{notice}</div>}
          </div>

          <div className="readiness-card" id="agent">
            <div className="readiness-head">
              <div>
                <p className="eyebrow">LAUNCH GATES</p>
                <h3>{config?.ready ? "Ready for Call cards" : "Connection locked"}</h3>
              </div>
              <div className={`readiness-ring ${config?.ready ? "ready" : ""}`}>
                {config?.ready ? "2/2" : `${Object.values(config?.checks ?? {}).filter(Boolean).length}/2`}
              </div>
            </div>
            <div className="check-list">
              {[
                ["webhook", "Grok Bot routine webhook"],
                ["authorization", "Private authorization connected"],
              ].map(([key, label]) => (
                <div className="check-row" key={key}>
                  <span className={config?.checks[key] ? "pass" : "pending"}>
                    {config?.checks[key] ? "✓" : "—"}
                  </span>
                  <p>{label}</p>
                  <small>{config?.checks[key] ? "Passed" : "Required"}</small>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="history-section" id="distributors">
          <div className="section-title">
            <div>
              <p className="eyebrow">RELAY DATABASE</p>
              <h2>Georgia distributor queue</h2>
            </div>
            <div>
              <span className="safety-pill">
                {config?.callingWindow ?? "Weekdays, 10:00–11:30 AM Eastern"} · {config?.minimumSpacingMinutes ?? 10}-minute spacing
              </span>
              <button className="primary-button" type="button" onClick={toggleAutoRun}>
                {autoRun ? "Stop auto-run" : "Start auto-run"}
              </button>
            </div>
          </div>
          <div className="ledger-layout">
            <form className="detail-card edit-form" onSubmit={addDistributor}>
              <label>Business<input name="company" required /></label>
              <div className="split-fields">
                <label>Phone<input name="phoneNumber" placeholder="+1 404 555 0123" required /></label>
                <label>City<input name="city" /></label>
              </div>
              <label>Contact name<input name="contactName" /></label>
              <label>Internal notes<textarea name="internalNotes" placeholder="Context for Grok. Never spoken aloud." /></label>
              <label>Permission source<input name="consentSource" placeholder="Requested callback, existing customer…" /></label>
              <label>Permission timestamp<input name="consentTimestamp" type="datetime-local" /></label>
              <input name="state" type="hidden" value="GA" />
              <button className="primary-button full" disabled={submitting}>Save distributor</button>
            </form>
            <div className="call-table-wrap">
              <table className="call-table">
                <thead><tr><th>Distributor</th><th>Status</th><th>Notes</th><th>Action</th></tr></thead>
                <tbody>
                  {distributors.map((distributor) => (
                    <tr key={distributor.id}>
                      <td><strong>{distributor.company}</strong><span>{distributor.city || "Georgia"} · {formatPhone(distributor.phoneNumber)}</span></td>
                      <td><span className={`state-badge ${distributor.status === "ready" ? "queued" : distributor.status === "completed" ? "completed" : "canceled"}`}>{distributor.status}</span></td>
                      <td>{distributor.callNotes || distributor.internalNotes || "—"}</td>
                      <td>
                        <button className="quiet-button" type="button" disabled={submitting || distributor.status !== "ready"} onClick={() => void prepareDistributor(distributor.id)}>
                          Prepare
                        </button>
                      </td>
                    </tr>
                  ))}
                  {!loading && distributors.length === 0 && <tr><td colSpan={4} className="empty-state"><strong>No distributors saved yet.</strong><span>Add the first Georgia record on the left.</span></td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {profile && (
          <section className="history-section" id="agent-brief">
            <div className="section-title"><div><p className="eyebrow">GROK CALL CONTEXT</p><h2>Haladir knowledge & script</h2></div></div>
            <form className="detail-card edit-form" onSubmit={saveProfile}>
              <div className="split-fields">
                <label>Company<input name="companyName" defaultValue={profile.companyName} /></label>
                <label>Opening statement<input name="openingStatement" defaultValue={profile.openingStatement} /></label>
              </div>
              <label>Company information<textarea name="companySummary" defaultValue={profile.companySummary} /></label>
              <label>Value proposition<textarea name="valueProposition" defaultValue={profile.valueProposition} /></label>
              <label>Call objective<textarea name="defaultObjective" defaultValue={profile.defaultObjective} /></label>
              <label>Call personality<textarea name="agentStyle" defaultValue={profile.agentStyle} /></label>
              <div className="split-fields">
                <label>Questions to ask — one per line<textarea name="questionsToAsk" defaultValue={profile.questionsToAsk.join("\n")} /></label>
                <label>Approved claims — one per line<textarea name="approvedClaims" defaultValue={profile.approvedClaims.join("\n")} /></label>
              </div>
              <label>Never say — one per line<textarea name="prohibitedClaims" defaultValue={profile.prohibitedClaims.join("\n")} /></label>
              <button className="primary-button full" disabled={submitting}>Save Grok call brief</button>
            </form>
          </section>
        )}

        <section className="metrics" aria-label="Campaign metrics">
          {[
            ["Calls attempted", metrics.attempted],
            ["Connected", metrics.connected],
            ["Useful outcomes", metrics.useful],
            ["Visits welcomed", metrics.welcomed],
            ["Opt-outs", metrics.optOuts],
          ].map(([label, value]) => (
            <article key={label}>
              <span>{label}</span>
              <strong>{value}</strong>
            </article>
          ))}
        </section>

        <section className="history-section" id="calls">
          <div className="section-title">
            <div>
              <p className="eyebrow">LIVE RESULTS</p>
              <h2>Conversation ledger</h2>
            </div>
            <button className="quiet-button" type="button" onClick={() => void load()}>
              Refresh
            </button>
          </div>

          <div className="ledger-layout">
            <div className="call-table-wrap">
              <table className="call-table">
                <thead>
                  <tr>
                    <th>Recipient</th>
                    <th>Status</th>
                    <th>Outcome</th>
                    <th>Started</th>
                  </tr>
                </thead>
                <tbody>
                  {calls.map((call) => (
                    <tr
                      key={call.id}
                      className={call.id === selectedId ? "selected" : ""}
                      onClick={() => setSelectedId(call.id)}
                    >
                      <td>
                        <strong>{formatPhone(call.phoneNumber)}</strong>
                        <span>Authorized test</span>
                      </td>
                      <td>
                        <span className={`state-badge ${call.state}`}>
                          {statusLabel(call.state)}
                        </span>
                      </td>
                      <td>{OUTCOME_LABELS[call.outcome?.outcome ?? ""] ?? "Awaiting result"}</td>
                      <td>{formatDate(call.createdAt)}</td>
                    </tr>
                  ))}
                  {!loading && calls.length === 0 && (
                    <tr>
                      <td colSpan={4} className="empty-state">
                        <strong>No test calls yet.</strong>
                        <span>Your first structured result will appear here.</span>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <CallDetail call={selectedCall} onSaved={load} />
          </div>
        </section>

        <footer>
          <span>RELAY / PHASE 1</span>
          <p>Reliability before scale. Authorized numbers only.</p>
        </footer>
      </section>
    </main>
  );
}

function CallDetail({
  call,
  onSaved,
}: {
  call: Call | null;
  onSaved: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!call) {
    return (
      <aside className="detail-card detail-empty">
        <span>↗</span>
        <h3>Select a call</h3>
        <p>Transcript and extracted outcome details will appear here.</p>
      </aside>
    );
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const data = new FormData(event.currentTarget);
    const outcome = String(data.get("outcome"));
    try {
      const response = await fetch(`${API_BASE}/api/calls/${call!.id}/outcome`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          outcome,
          summary: data.get("summary"),
          contactName: data.get("contactName"),
          notes: data.get("notes"),
          visitPermission: data.get("visitPermission"),
          visitDate: data.get("visitDate"),
          visitTime: data.get("visitTime"),
          doNotCall: outcome === "declined_do_not_call",
          confidence: 1,
        }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Could not save");
      setEditing(false);
      await onSaved();
    } catch (saveError) {
      setError((saveError as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <aside className="detail-card">
      <div className="detail-head">
        <div>
          <p className="eyebrow">CALL DETAIL</p>
          <h3>{formatPhone(call.phoneNumber)}</h3>
        </div>
        <button className="quiet-button" type="button" onClick={() => setEditing(!editing)}>
          {editing ? "Cancel" : "Correct result"}
        </button>
      </div>

      {editing ? (
        <form className="edit-form" onSubmit={save}>
          <label>
            Outcome
            <select name="outcome" defaultValue={call.outcome?.outcome ?? "needs_review"}>
              {OUTCOME_OPTIONS.map(([value, label]) => (
                <option value={value} key={value}>{label}</option>
              ))}
            </select>
          </label>
          <label>
            Summary
            <textarea name="summary" defaultValue={call.outcome?.summary ?? "Reviewed by a person."} required />
          </label>
          <label>
            Contact name
            <input name="contactName" defaultValue={call.outcome?.contactName} />
          </label>
          <label>
            Visit permission
            <select name="visitPermission" defaultValue={call.outcome?.visitPermission ?? "unknown"}>
              <option value="explicitly_welcomed">Explicitly welcomed</option>
              <option value="present_not_confirmed">Present, not confirmed</option>
              <option value="appointment_required">Appointment required</option>
              <option value="not_welcomed">Not welcomed</option>
              <option value="unknown">Unknown</option>
            </select>
          </label>
          <div className="split-fields">
            <label>Visit date<input name="visitDate" defaultValue={call.outcome?.visitDate} /></label>
            <label>Visit time<input name="visitTime" defaultValue={call.outcome?.visitTime} /></label>
          </div>
          <label>
            Notes
            <textarea name="notes" defaultValue={call.outcome?.notes} />
          </label>
          {error && <p className="form-error">{error}</p>}
          <button className="primary-button full" disabled={saving} type="submit">
            {saving ? "Saving…" : "Save correction"}
          </button>
        </form>
      ) : (
        <>
          <div className="outcome-block">
            <span>Outcome</span>
            <strong>{OUTCOME_LABELS[call.outcome?.outcome ?? ""] ?? "In progress"}</strong>
            <p>{call.outcome?.summary ?? "The voice session has not produced a final result yet."}</p>
          </div>
          <dl className="detail-list">
            <div><dt>Contact</dt><dd>{call.outcome?.contactName ?? "Not captured"}</dd></div>
            <div><dt>Visit signal</dt><dd>{call.outcome?.visitPermission?.replaceAll("_", " ") ?? "Unknown"}</dd></div>
            <div><dt>Interruptions</dt><dd>{call.interruptionCount}</dd></div>
            <div><dt>Voice path</dt><dd>{call.transport === "grok_bot_call_card" ? "Grok Bot Call card" : call.transport === "xai_sip" ? "xAI native SIP" : "Media fallback"}</dd></div>
            <div><dt>First audio</dt><dd>{call.firstAudioLatencyMs === undefined ? "—" : `${call.firstAudioLatencyMs} ms`}</dd></div>
            <div><dt>Voice reconnects</dt><dd>{call.providerReconnectCount ?? 0}</dd></div>
            <div><dt>Captured by</dt><dd>{call.outcome?.capturedBy ?? "—"}</dd></div>
          </dl>
          <div className="transcript-block">
            <div className="transcript-title">
              <span>Transcript</span>
              <small>{call.transcript.length} turns</small>
            </div>
            <div className="transcript-scroll">
              {call.transcript.map((entry, index) => (
                <div className={`transcript-line ${entry.role}`} key={`${entry.at}-${index}`}>
                  <b>{entry.role === "agent" ? "AI" : "Recipient"}</b>
                  <p>{entry.text}</p>
                </div>
              ))}
              {call.transcript.length === 0 && <p className="muted">No transcript received yet.</p>}
            </div>
          </div>
        </>
      )}
    </aside>
  );
}
