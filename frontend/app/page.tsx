"use client";

import { FormEvent, useMemo, useState } from "react";
import { ensureRedditPixel, trackRedditEvent } from "../lib/redditPixel";
import { CapiResult, DeliveryMode, EventLogEntry, RedditEventName } from "../lib/types";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:4000";

/** Demo product metadata; currency INR matches common CAPI examples for this sandbox. */
const baseMeta = {
  product_id: "sku-demo-001",
  category: "test-product",
  test_environment: true
};

function randomUser() {
  const id = Math.floor(Math.random() * 100000);
  return {
    name: `User ${id}`,
    email: `user${id}@example.com`
  };
}

const randomDelay = (min = 100, max = 1000) => Math.floor(Math.random() * (max - min + 1)) + min;

const shuffle = <T,>(items: T[]): T[] => {
  const array = [...items];
  for (let i = array.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
};

export default function HomePage() {
  const [pixelId, setPixelId] = useState(process.env.NEXT_PUBLIC_DEFAULT_PIXEL_ID ?? "");
  const [debugMode, setDebugMode] = useState(true);
  /** When true, Reddit receives test_mode (and optional test_event_code). */
  const [testMode, setTestMode] = useState(true);
  const [testEventCode, setTestEventCode] = useState("");
  const [delayMs, setDelayMs] = useState(0);
  const [deliveryMode, setDeliveryMode] = useState<DeliveryMode>("both");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [eventLog, setEventLog] = useState<EventLogEntry[]>([]);
  const [simulating, setSimulating] = useState(false);

  const [lastDelivery, setLastDelivery] = useState<{
    at: string;
    eventName: RedditEventName;
    conversionId: string;
    deliveryMode: DeliveryMode;
    pixelOk: boolean | null;
    capiOk: boolean | null;
  } | null>(null);

  const [capiStatus, setCapiStatus] = useState<{
    at: string;
    ok: boolean;
    eventName: string;
    httpStatus: number;
    summary: string;
    clientRequest: unknown;
    redditRequest: unknown;
    redditResponse: unknown;
  } | null>(null);

  const lastPayload = useMemo(() => {
    const first = eventLog[0];
    if (!first || first.source !== "event") return null;
    return first.payload ?? null;
  }, [eventLog]);

  const summarizeCapi = (capi: CapiResult, eventName: string) => {
    if (capi.ok) return `Success: ${eventName} delivered to Reddit CAPI`;
    const body = capi.responseBody as Record<string, unknown> | null;
    if (!body) return `Failed: HTTP ${capi.status}`;
    const msg = body.error ?? body.message ?? body.reason;
    if (typeof msg === "string") return msg;
    const redditRaw = body.reddit_response;
    if (redditRaw && typeof redditRaw === "object") {
      const n = redditRaw as Record<string, unknown>;
      const m = n.error ?? n.message;
      if (typeof m === "string") return m;
    }
    try {
      return `Failed: HTTP ${capi.status} — ${JSON.stringify(body).slice(0, 280)}`;
    } catch {
      return `Failed: HTTP ${capi.status}`;
    }
  };

  const appendLog = (entry: EventLogEntry) => {
    setEventLog((prev) => [entry, ...prev].slice(0, 120));
  };

  const pushSystemLog = (message: string, payload: unknown = null) => {
    appendLog({
      id: crypto.randomUUID(),
      source: "system",
      eventType: message,
      timestamp: new Date().toISOString(),
      payload
    });
  };

  const sendCapiEvent = async (
    eventName: RedditEventName,
    payload: Record<string, unknown>,
    options: { eventTimeSeconds: number; providedEmail?: string; externalId?: string }
  ): Promise<CapiResult> => {
    const conversionId = typeof payload.conversion_id === "string" ? payload.conversion_id : "";
    const { conversion_id: _cid, conversionId: _cId, ...customRest } = payload;
    const requestBody: Record<string, unknown> = {
      event_name: eventName,
      event_time: options.eventTimeSeconds,
      event_source_url: window.location.href,
      conversion_id: conversionId,
      custom_data: customRest,
      user_data: {
        email: options?.providedEmail || email || undefined,
        external_id: options?.externalId
      },
      client_user_agent: typeof navigator !== "undefined" ? navigator.userAgent : "",
      test_mode: testMode,
      ...(testEventCode.trim() ? { test_event_code: testEventCode.trim() } : {})
    };

    console.info("[CAPI] POST /capi/event", {
      event_name: eventName,
      conversion_id: conversionId,
      event_time: options.eventTimeSeconds,
      test_mode: testMode
    });

    let response: Response;
    try {
      response = await fetch(`${BACKEND_URL}/capi/event`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody)
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        status: 0,
        responseBody: { error: message },
        requestBody,
        error: message
      };
    }

    const text = await response.text();
    let body: unknown = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }

    const parsed = body as Record<string, unknown>;
    const redditOk = parsed.ok === true;

    console.info("[CAPI] backend response", { http: response.status, ok: response.ok && redditOk, body: parsed });

    return {
      ok: response.ok && redditOk,
      status: response.status,
      responseBody: body,
      requestBody,
      redditRequestBody: parsed.reddit_request_body,
      error: typeof parsed.error === "string" ? parsed.error : undefined
    };
  };

  /**
   * Fires one logical event: optionally Pixel (browser) and/or CAPI (Express → Reddit).
   * Deduplication: the SAME `conversion_id` / `conversionId` must go to Pixel and CAPI when both run,
   * or Reddit may double-count the conversion in reporting.
   */
  const fireEvent = async (
    eventType: RedditEventName,
    payload: Record<string, unknown>,
    options?: {
      replayOf?: string;
      providedEmail?: string;
      externalId?: string;
      userId?: string;
      conversionId?: string;
    }
  ) => {
    const runPixel = deliveryMode === "pixel_only" || deliveryMode === "both";
    const runCapi = deliveryMode === "capi_only" || deliveryMode === "both";

    if (runPixel && !pixelId.trim()) {
      pushSystemLog("Set a Reddit Pixel ID before firing client-side events (or switch to CAPI only).");
      return;
    }

    const eventTimeSeconds = Math.floor(Date.now() / 1000);
    const conversionId = options?.conversionId ?? crypto.randomUUID();

    if (runPixel) {
      ensureRedditPixel(pixelId, debugMode);
    }

    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    const enrichedPayload = {
      ...payload,
      conversion_id: conversionId,
      conversionId,
      ...(options?.userId ? { simulator_user_id: options.userId } : {})
    };

    let pixelOk: boolean | null = runPixel ? false : null;
    if (runPixel) {
      const fired = trackRedditEvent(eventType, enrichedPayload);
      pixelOk = Boolean(fired);
      if (!fired) {
        console.warn("[Pixel] rdt unavailable or stub failed to queue", eventType);
      }
    }

    let capi: CapiResult | undefined;
    let capiOk: boolean | null = runCapi ? false : null;

    if (runCapi) {
      try {
        capi = await sendCapiEvent(eventType, enrichedPayload, {
          eventTimeSeconds,
          providedEmail: options?.providedEmail,
          externalId: options?.externalId
        });
        capiOk = capi.ok;
        setCapiStatus({
          at: new Date().toISOString(),
          ok: capi.ok,
          eventName: eventType,
          httpStatus: capi.status,
          summary: summarizeCapi(capi, eventType),
          clientRequest: capi.requestBody,
          redditRequest: capi.redditRequestBody ?? null,
          redditResponse: capi.responseBody
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        capi = {
          ok: false,
          status: 0,
          responseBody: { error: message },
          requestBody: null,
          error: message
        };
        capiOk = false;
        setCapiStatus({
          at: new Date().toISOString(),
          ok: false,
          eventName: eventType,
          httpStatus: 0,
          summary: message,
          clientRequest: null,
          redditRequest: null,
          redditResponse: { error: message }
        });
      }
    } else {
      setCapiStatus(null);
    }

    setLastDelivery({
      at: new Date().toISOString(),
      eventName: eventType,
      conversionId,
      deliveryMode,
      pixelOk,
      capiOk
    });

    appendLog({
      id: crypto.randomUUID(),
      source: "event",
      eventType: eventType,
      timestamp: new Date().toISOString(),
      conversionId,
      pixelOk: pixelOk ?? undefined,
      pixelSkipped: !runPixel,
      capiOk: capiOk ?? undefined,
      capiSkipped: !runCapi,
      deliveryMode,
      payload: enrichedPayload,
      capi,
      replayOf: options?.replayOf
    });
  };

  const onSignUp = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await fireEvent(
      "SignUp",
      {
        email,
        name,
        ...baseMeta
      },
      { providedEmail: email }
    );
  };

  const simulateUsers = async () => {
    const runPixel = deliveryMode === "pixel_only" || deliveryMode === "both";
    if (runPixel && !pixelId.trim()) {
      pushSystemLog("Set a Pixel ID before simulating users with Pixel enabled, or choose CAPI only.");
      return;
    }

    setSimulating(true);
    try {
      const browseEvents: RedditEventName[] = ["PageVisit", "ViewContent", "AddToCart"];
      const simulatedUsers = Array.from({ length: 3 }, () => {
        const user = randomUser();
        return {
          ...user,
          externalId: crypto.randomUUID(),
          events: shuffle(browseEvents)
        };
      });

      await Promise.all(
        simulatedUsers.map(async (simUser, userIndex) => {
          await fireEvent(
            "SignUp",
            {
              name: simUser.name,
              email: simUser.email,
              user_external_id: simUser.externalId,
              ...baseMeta
            },
            {
              providedEmail: simUser.email,
              externalId: simUser.externalId,
              userId: simUser.externalId
            }
          );

          for (const eventName of simUser.events) {
            await new Promise((resolve) => setTimeout(resolve, randomDelay()));

            const eventPayload: Record<string, unknown> = {
              ...baseMeta,
              user_external_id: simUser.externalId,
              user_name: simUser.name
            };

            if (eventName === "ViewContent") {
              eventPayload.item_count = 1;
              eventPayload.content_type = "product";
            }
            if (eventName === "AddToCart") {
              eventPayload.value = 49.99 + userIndex;
              eventPayload.currency = "INR";
              eventPayload.quantity = 1;
            }

            await fireEvent(eventName, eventPayload, {
              providedEmail: simUser.email,
              externalId: simUser.externalId,
              userId: simUser.externalId
            });
          }

          await new Promise((resolve) => setTimeout(resolve, randomDelay()));
          await fireEvent(
            "ViewContent",
            {
              ...baseMeta,
              user_external_id: simUser.externalId,
              user_name: simUser.name,
              content_type: "cart",
              cart_view: true,
              item_count: 1,
              line_items: [
                {
                  id: baseMeta.product_id,
                  quantity: 1,
                  value: 49.99 + userIndex,
                  currency: "INR"
                }
              ]
            },
            {
              providedEmail: simUser.email,
              externalId: simUser.externalId,
              userId: simUser.externalId
            }
          );

          await new Promise((resolve) => setTimeout(resolve, randomDelay()));
          await fireEvent(
            "Purchase",
            {
              ...baseMeta,
              user_external_id: simUser.externalId,
              user_name: simUser.name,
              value: 99.99 + userIndex,
              currency: "INR",
              order_id: `order-${simUser.externalId}-${Date.now()}`,
              items: [{ id: baseMeta.product_id, quantity: 1 }]
            },
            {
              providedEmail: simUser.email,
              externalId: simUser.externalId,
              userId: simUser.externalId
            }
          );
        })
      );
    } finally {
      setSimulating(false);
    }
  };

  const replayEvent = async (entry: EventLogEntry) => {
    if (entry.source === "system") return;
    let payload: Record<string, unknown> = {};
    const raw = entry.payload;
    if (raw && typeof raw === "object") {
      const o = raw as Record<string, unknown>;
      if ("payload" in o && typeof o.payload === "object" && o.payload !== null) {
        payload = { ...(o.payload as Record<string, unknown>) };
      } else {
        payload = { ...o };
      }
    }
    delete payload.conversion_id;
    delete payload.conversionId;

    const ext =
      typeof payload.user_external_id === "string" ? (payload.user_external_id as string) : undefined;
    const mail = typeof payload.email === "string" ? (payload.email as string) : undefined;

    await fireEvent(entry.eventType as RedditEventName, payload, {
      replayOf: entry.id,
      ...(entry.conversionId ? { conversionId: entry.conversionId } : {}),
      ...(mail ? { providedEmail: mail } : {}),
      ...(ext ? { externalId: ext, userId: ext } : {})
    });
  };

  const statusChip = (label: string, ok: boolean | null, skipped: boolean) => {
    if (skipped) {
      return (
        <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
          {label}: skipped
        </span>
      );
    }
    if (ok === null) return null;
    return (
      <span
        className={`rounded-full px-3 py-1 text-xs font-semibold ${
          ok ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-800"
        }`}
      >
        {label}: {ok ? "success" : "failure"}
      </span>
    );
  };

  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-100 via-slate-50 to-white">
      <div className="mx-auto max-w-7xl px-4 py-8 md:px-6 lg:px-8">
        <header className="mb-8 rounded-2xl border border-slate-200 bg-white/80 p-6 shadow-sm backdrop-blur">
          <h1 className="text-3xl font-bold tracking-tight text-slate-900 md:text-4xl">
            Reddit Ads Pixel + CAPI Sandbox
          </h1>
          <p className="mt-2 text-slate-600">
            Fire standard events through the browser Pixel and/or server Conversion API with shared{" "}
            <code className="rounded bg-slate-100 px-1">conversion_id</code> for deduplication. Access token stays on
            the backend.
          </p>
        </header>

        <section className="mb-6 grid gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm md:grid-cols-2">
          <label className="flex flex-col gap-2">
            <span className="text-sm font-medium text-slate-700">Reddit Pixel ID (client init)</span>
            <input
              className="rounded-lg border border-slate-300 p-2.5 text-sm shadow-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-200"
              value={pixelId}
              onChange={(e) => setPixelId(e.target.value)}
              placeholder="Pixel ID for rdt('init', …)"
            />
          </label>
          <label className="flex flex-col gap-2">
            <span className="text-sm font-medium text-slate-700">Test event code (optional)</span>
            <input
              className="rounded-lg border border-slate-300 p-2.5 text-sm shadow-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-200"
              value={testEventCode}
              onChange={(e) => setTestEventCode(e.target.value)}
              placeholder="Forwarded to Reddit when test mode is on"
            />
          </label>
          <div className="md:col-span-2">
            <p className="mb-2 text-sm font-medium text-slate-700">Delivery mode</p>
            <div className="flex flex-wrap gap-4 text-sm text-slate-800">
              {(
                [
                  ["both", "Pixel + CAPI (dedupe with shared conversion_id)"],
                  ["pixel_only", "Pixel only"],
                  ["capi_only", "CAPI only"]
                ] as const
              ).map(([value, label]) => (
                <label key={value} className="inline-flex items-center gap-2">
                  <input
                    type="radio"
                    name="delivery"
                    checked={deliveryMode === value}
                    onChange={() => setDeliveryMode(value)}
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-5">
            <label className="inline-flex items-center gap-2 text-sm font-medium text-slate-700">
              <input type="checkbox" checked={debugMode} onChange={(e) => setDebugMode(e.target.checked)} />
              <span>Pixel debug (extra PageVisit on init)</span>
            </label>
            <label className="inline-flex items-center gap-2 text-sm font-medium text-slate-700">
              <input type="checkbox" checked={testMode} onChange={(e) => setTestMode(e.target.checked)} />
              <span>Reddit test_mode</span>
            </label>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <span className="font-medium">Artificial delay (ms):</span>
            <input
              type="number"
              className="w-32 rounded-lg border border-slate-300 p-2 text-sm shadow-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-200"
              value={delayMs}
              onChange={(e) => setDelayMs(Number(e.target.value) || 0)}
            />
          </label>
        </section>

        <section className="mb-6 rounded-2xl border border-amber-200 bg-amber-50/80 p-5 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">Debug — last delivery</h2>
          <p className="mt-1 text-sm text-slate-600">
            Pixel runs in the browser; CAPI runs on your Express server with{" "}
            <code className="rounded bg-white px-1">REDDIT_ACCESS_TOKEN</code>. Match outcomes here with Events
            Manager / network logs.
          </p>
          {!lastDelivery && <p className="mt-2 text-sm text-slate-500">No events fired yet.</p>}
          {lastDelivery && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-slate-800">{lastDelivery.eventName}</span>
              <span className="text-xs text-slate-500">{new Date(lastDelivery.at).toLocaleString()}</span>
              <span className="text-xs text-slate-500">
                mode: <code className="rounded bg-white px-1">{lastDelivery.deliveryMode}</code>
              </span>
            </div>
          )}
          {lastDelivery && (
            <div className="mt-2 flex flex-wrap gap-2">
              {statusChip(
                "Pixel",
                lastDelivery.pixelOk,
                lastDelivery.deliveryMode === "capi_only"
              )}
              {statusChip(
                "CAPI",
                lastDelivery.capiOk,
                lastDelivery.deliveryMode === "pixel_only"
              )}
            </div>
          )}
          {lastDelivery && (
            <p className="mt-2 break-all font-mono text-xs text-slate-700">
              conversion_id: {lastDelivery.conversionId}
            </p>
          )}
        </section>

        <section className="mb-6 grid gap-3 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm md:grid-cols-2 lg:grid-cols-3">
          <button
            className="rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700"
            onClick={() => fireEvent("PageVisit", { ...baseMeta })}
          >
            Fire PageVisit
          </button>
          <button
            className="rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700"
            onClick={() =>
              fireEvent("ViewContent", { item_count: 1, content_type: "product", ...baseMeta })
            }
          >
            View Content
          </button>
          <button
            className="rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700"
            onClick={() => fireEvent("AddToCart", { value: 49.99, currency: "INR", quantity: 1, ...baseMeta })}
          >
            Add To Cart
          </button>
          <button
            className="rounded-lg bg-purple-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-purple-700"
            onClick={() =>
              fireEvent("Purchase", {
                value: 99.99,
                currency: "INR",
                order_id: `order-${Date.now()}`,
                ...baseMeta
              })
            }
          >
            Purchase
          </button>
        </section>

        <section className="mb-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="mb-3 text-xl font-semibold text-slate-900">Sign Up</h2>
          <p className="mb-3 text-sm text-slate-600">
            Email is sent to the backend in plaintext only for hashing (SHA-256 normalized email); it is never logged
            raw server-side in this demo.
          </p>
          <form className="grid gap-3 md:grid-cols-3" onSubmit={onSignUp}>
            <input
              className="rounded-lg border border-slate-300 p-2.5 text-sm shadow-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-200"
              placeholder="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
            <input
              type="email"
              className="rounded-lg border border-slate-300 p-2.5 text-sm shadow-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-200"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <button
              className="rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
              type="submit"
            >
              Sign Up
            </button>
          </form>
        </section>

        <section className="mb-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-center gap-3">
            <button
              className="rounded-lg bg-orange-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-orange-700 disabled:cursor-not-allowed disabled:opacity-60"
              onClick={simulateUsers}
              disabled={simulating}
            >
              Simulate 3 Users
            </button>
            <span
              className={`rounded-full px-3 py-1 text-xs font-semibold ${
                simulating ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700"
              }`}
            >
              {simulating ? "Simulating (Promise.all + random delays)…" : "Idle"}
            </span>
          </div>
          <p className="mt-2 text-sm text-slate-600">
            Three synthetic profiles run in parallel; each has its own <code className="rounded bg-slate-100 px-1">external_id</code>{" "}
            and random 100–1000ms gaps between steps.
          </p>
        </section>

        <section className="mb-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="mb-2 text-xl font-semibold text-slate-900">Latest CAPI round-trip</h2>
          <p className="mb-4 text-sm text-slate-600">
            Browser <code className="rounded bg-slate-100 px-1">POST /capi/event</code> → Reddit{" "}
            <code className="rounded bg-slate-100 px-1">/api/v2.0/conversions/events/{"{account_id}"}</code>. Configure{" "}
            <code className="rounded bg-slate-100 px-1">REDDIT_ACCESS_TOKEN</code>,{" "}
            <code className="rounded bg-slate-100 px-1">REDDIT_PIXEL_ID</code>, and{" "}
            <code className="rounded bg-slate-100 px-1">REDDIT_AD_ACCOUNT_ID</code> (or JWT with{" "}
            <code className="rounded bg-slate-100 px-1">aid</code>) in <code className="rounded bg-slate-100 px-1">backend/.env</code>.
          </p>
          {!capiStatus && <p className="text-sm text-slate-500">No CAPI calls yet (or Pixel-only mode).</p>}
          {capiStatus && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`rounded-full px-3 py-1 text-xs font-semibold ${
                    capiStatus.ok ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-800"
                  }`}
                >
                  {capiStatus.ok ? "Success" : "Failure"}
                </span>
                <span className="text-sm font-medium text-slate-800">{capiStatus.eventName}</span>
                <span className="text-xs text-slate-500">HTTP {capiStatus.httpStatus}</span>
                <span className="text-xs text-slate-500">{new Date(capiStatus.at).toLocaleString()}</span>
              </div>
              <p className="text-sm text-slate-700">{capiStatus.summary}</p>
              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Browser → backend</p>
                  <pre className="max-h-48 overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-800">
                    {JSON.stringify(capiStatus.clientRequest, null, 2)}
                  </pre>
                </div>
                <div>
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Backend → Reddit</p>
                  <pre className="max-h-48 overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-800">
                    {JSON.stringify(capiStatus.redditRequest, null, 2)}
                  </pre>
                </div>
              </div>
              <div>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Reddit response</p>
                <pre className="max-h-48 overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-800">
                  {JSON.stringify(capiStatus.redditResponse, null, 2)}
                </pre>
              </div>
            </div>
          )}
        </section>

        <section className="grid gap-6 md:grid-cols-2">
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="mb-3 text-xl font-semibold text-slate-900">Live event log</h2>
            <div className="max-h-[520px] space-y-3 overflow-auto">
              {eventLog.length === 0 && <p className="text-sm text-slate-500">No events yet.</p>}
              {eventLog.map((entry) => (
                <article key={entry.id} className="rounded-xl border border-slate-200 bg-slate-50/60 p-3 text-sm">
                  {entry.source === "system" ? (
                    <>
                      <span className="rounded-full bg-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-700">
                        SYSTEM
                      </span>
                      <p className="mt-2 font-medium text-slate-900">{entry.eventType}</p>
                    </>
                  ) : (
                    <>
                      <div className="mb-2 flex flex-wrap items-center gap-2">
                        <strong className="text-slate-900">{entry.eventType}</strong>
                        <span className="text-xs text-slate-500">{new Date(entry.timestamp).toLocaleString()}</span>
                        {entry.deliveryMode && (
                          <span className="text-xs text-slate-500">
                            mode: <code className="rounded bg-white px-1">{entry.deliveryMode}</code>
                          </span>
                        )}
                      </div>
                      <p className="mb-1 break-all font-mono text-xs text-slate-700">
                        conversion_id: {entry.conversionId ?? "—"}
                      </p>
                      <div className="mb-2 flex flex-wrap gap-2 text-xs">
                        {entry.pixelSkipped ? (
                          <span className="rounded bg-slate-200 px-2 py-0.5 font-semibold text-slate-700">Pixel: skipped</span>
                        ) : (
                          <span
                            className={`rounded px-2 py-0.5 font-semibold ${
                              entry.pixelOk ? "bg-blue-100 text-blue-800" : "bg-red-100 text-red-800"
                            }`}
                          >
                            Pixel: {entry.pixelOk ? "ok" : "fail"}
                          </span>
                        )}
                        {entry.capiSkipped ? (
                          <span className="rounded bg-slate-200 px-2 py-0.5 font-semibold text-slate-700">CAPI: skipped</span>
                        ) : (
                          <span
                            className={`rounded px-2 py-0.5 font-semibold ${
                              entry.capiOk ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-800"
                            }`}
                          >
                            CAPI: {entry.capiOk ? "ok" : "fail"}
                          </span>
                        )}
                      </div>
                      {typeof entry.payload === "object" &&
                        entry.payload !== null &&
                        "simulator_user_id" in entry.payload && (
                          <p className="text-xs text-slate-500">
                            Simulated user: {(entry.payload as { simulator_user_id: string }).simulator_user_id}
                          </p>
                        )}
                      {entry.replayOf && <p className="text-xs text-slate-500">Replay of: {entry.replayOf}</p>}
                      <pre className="mt-2 max-h-40 overflow-auto rounded-lg border border-slate-200 bg-white p-2 text-xs text-slate-700">
                        {JSON.stringify(entry.payload, null, 2)}
                      </pre>
                      {entry.capi && (
                        <pre className="mt-2 max-h-32 overflow-auto rounded-lg border border-slate-200 bg-white p-2 text-xs text-slate-700">
                          {JSON.stringify(entry.capi, null, 2)}
                        </pre>
                      )}
                      <button
                        className="mt-2 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 transition hover:bg-slate-100"
                        onClick={() => replayEvent(entry)}
                      >
                        Replay (same conversion_id)
                      </button>
                    </>
                  )}
                </article>
              ))}
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="mb-3 text-xl font-semibold text-slate-900">Payload inspector</h2>
            <p className="mb-2 text-sm text-slate-600">Most recent event payload sent to Pixel / mirrored into CAPI:</p>
            <pre className="max-h-[520px] overflow-auto rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
              {JSON.stringify(lastPayload, null, 2)}
            </pre>
          </div>
        </section>
      </div>
    </main>
  );
}
