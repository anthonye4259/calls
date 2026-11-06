import path from "node:path";

const readBoolean = (value: string | undefined, fallback = false) =>
  value === undefined ? fallback : value.toLowerCase() === "true";

const readInteger = (
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
};

export type TelephonyMode = "xai_sip" | "twilio_media_stream";

const readTelephonyMode = (value: string | undefined): TelephonyMode =>
  value === "twilio_media_stream" ? value : "xai_sip";

export function normalizeE164(value: string): string | null {
  const normalized = value.trim().replace(/[\s().-]/g, "");
  return /^\+[1-9]\d{7,14}$/.test(normalized) ? normalized : null;
}

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const allowlist = new Set(
    (env.TEST_NUMBER_ALLOWLIST ?? "")
      .split(",")
      .map(normalizeE164)
      .filter((value): value is string => Boolean(value)),
  );

  const publicBaseUrl = (env.PUBLIC_BASE_URL ?? "").replace(/\/$/, "");
  const telephonyMode = readTelephonyMode(env.XAI_TELEPHONY_MODE);

  return {
    port: Number(env.PORT ?? 3001),
    dashboardOrigin: env.DASHBOARD_ORIGIN ?? "http://localhost:3000",
    publicBaseUrl,
    xaiApiKey: env.XAI_API_KEY ?? "",
    xaiApiBaseUrl: (env.XAI_API_BASE_URL ?? "https://api.x.ai").replace(
      /\/$/,
      "",
    ),
    xaiRealtimeUrl:
      env.XAI_REALTIME_URL ??
      "wss://api.x.ai/v1/realtime?model=grok-voice-latest",
    xaiVoice: env.XAI_VOICE ?? "eve",
    xaiSipWebhookSecret: env.XAI_SIP_WEBHOOK_SECRET ?? "",
    xaiSipUsername: env.XAI_SIP_USERNAME ?? "",
    xaiSipPassword: env.XAI_SIP_PASSWORD ?? "",
    xaiSipNumber:
      normalizeE164(env.XAI_SIP_NUMBER ?? env.TWILIO_PHONE_NUMBER ?? "") ?? "",
    xaiIdleTimeoutMs: readInteger(
      env.XAI_IDLE_TIMEOUT_MS,
      12_000,
      5_000,
      60_000,
    ),
    telephonyMode,
    twilioAccountSid: env.TWILIO_ACCOUNT_SID ?? "",
    twilioAuthToken: env.TWILIO_AUTH_TOKEN ?? "",
    twilioPhoneNumber: normalizeE164(env.TWILIO_PHONE_NUMBER ?? "") ?? "",
    testNumberAllowlist: allowlist,
    allowUnrestrictedDialing: readBoolean(env.ALLOW_UNRESTRICTED_DIALING),
    companyProfileApproved: readBoolean(env.COMPANY_PROFILE_APPROVED),
    validateTwilioSignatures: readBoolean(
      env.VALIDATE_TWILIO_SIGNATURES,
      true,
    ),
    callStorePath:
      env.CALL_STORE_PATH ?? path.join(process.cwd(), "data", "calls.json"),
  };
}

export function readiness(config: AppConfig) {
  const sipCredentialsComplete = Boolean(config.xaiSipUsername) === Boolean(
    config.xaiSipPassword,
  );
  const checks = {
    xai: Boolean(
      config.xaiApiKey &&
        (config.telephonyMode === "twilio_media_stream" ||
          (config.xaiSipWebhookSecret &&
            config.xaiSipNumber &&
            sipCredentialsComplete)),
    ),
    twilio: Boolean(
      config.twilioAccountSid &&
        config.twilioAuthToken &&
        config.twilioPhoneNumber,
    ),
    publicUrl: /^https:\/\//.test(config.publicBaseUrl),
    allowlist:
      config.testNumberAllowlist.size > 0 || config.allowUnrestrictedDialing,
    companyProfile: config.companyProfileApproved,
  };

  return { ready: Object.values(checks).every(Boolean), checks };
}
