export type RedditEventName =
  | "PageVisit"
  | "Search"
  | "AddToCart"
  | "AddToWishlist"
  | "Purchase"
  | "ViewContent"
  | "Lead"
  | "SignUp"
  | "Custom";

/** How a fired event is delivered: client Pixel, server CAPI, or both (recommended for deduplication). */
export type DeliveryMode = "both" | "pixel_only" | "capi_only";

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

/**
 * One logical tracking action (e.g. one Purchase click).
 * Pixel + CAPI share the same conversion_id so Reddit can deduplicate if both arrive.
 */
export interface EventLogEntry {
  id: string;
  /** `event` = one user action with optional Pixel + CAPI outcomes; `system` = messages. */
  source: "event" | "system";
  eventType: string;
  timestamp: string;
  conversionId?: string;
  /** Whether the client called rdt('track', ...) successfully (rdt present). */
  pixelOk?: boolean;
  /** True when delivery mode skipped Pixel intentionally. */
  pixelSkipped?: boolean;
  /** Whether the server round-trip to Reddit succeeded. */
  capiOk?: boolean;
  capiSkipped?: boolean;
  deliveryMode?: DeliveryMode;
  /** Full payload passed to Pixel / mirrored in CAPI custom_data where applicable. */
  payload?: unknown;
  capi?: CapiResult;
  replayOf?: string;
}
