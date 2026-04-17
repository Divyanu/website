export type RedditEventName =
  | "PageVisit"
  | "ViewContent"
  | "AddToCart"
  | "SignUp"
  | "Purchase";

export interface PixelPayload {
  eventType: RedditEventName;
  payload: Record<string, unknown>;
  timestamp: string;
}

export interface CapiResult {
  ok: boolean;
  status: number;
  responseBody: unknown;
  requestBody: unknown;
}

export interface EventLogEntry {
  id: string;
  source: "pixel" | "capi" | "system";
  eventType: string;
  timestamp: string;
  payload: unknown;
  capi?: CapiResult;
  replayOf?: string;
}
