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
  /** Payload the browser sent to our Express `/capi/event` route. */
  requestBody: unknown;
  /** Exact JSON our server POSTed to Reddit (for debugging CAPI shape). */
  redditRequestBody?: unknown;
  error?: string;
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
