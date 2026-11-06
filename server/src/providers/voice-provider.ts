import type { RawData, WebSocket } from "ws";

export type TelephonyStart = {
  event: "start";
  start: {
    streamSid: string;
    callSid: string;
    customParameters?: Record<string, string>;
  };
};

export type TelephonyMessage =
  | TelephonyStart
  | {
      event: "media";
      streamSid: string;
      media: { track: string; payload: string };
    }
  | { event: "stop"; streamSid: string }
  | { event: "connected" }
  | { event: "mark"; streamSid: string; mark: { name: string } };

export interface VoiceSession {
  handleTelephonyMessage(message: TelephonyMessage): Promise<void> | void;
  close(): void;
}

export type VoiceSessionContext = {
  callId: string;
  callSid: string;
  streamSid: string;
  telephonySocket: WebSocket;
  endCall: () => Promise<void>;
};

export interface VoiceProviderAdapter {
  connect(context: VoiceSessionContext): VoiceSession;
}

export function parseTelephonyMessage(data: RawData): TelephonyMessage | null {
  try {
    return JSON.parse(data.toString()) as TelephonyMessage;
  } catch {
    return null;
  }
}
