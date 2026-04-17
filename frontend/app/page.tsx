"use client";

import { FormEvent, useMemo, useState } from "react";
import { ensureRedditPixel, trackRedditEvent } from "../lib/redditPixel";
import { CapiResult, EventLogEntry, PixelPayload, RedditEventName } from "../lib/types";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:4000";

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
  const [testMode, setTestMode] = useState(false);
  const [testEventCode, setTestEventCode] = useState("");
  const [delayMs, setDelayMs] = useState(0);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [eventLog, setEventLog] = useState<EventLogEntry[]>([]);
  /** Only true while "Simulate 3 Users" is running — do not tie this to every fireEvent or parallel sims block the UI. */
  const [simulating, setSimulating] = useState(false);
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

  const lastPayload = useMemo(() => eventLog[0]?.payload || null, [eventLog]);

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
      test_mode: true
    };

    console.info("[CAPI] POST /capi/event", { event_name: eventName, conversion_id: conversionId, event_time: options.eventTimeSeconds });

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

  const fireEvent = async (
    eventType: RedditEventName,
    payload: Record<string, unknown>,
    options?: { replayOf?: string; providedEmail?: string; externalId?: string; userId?: string; conversionId?: string }
  ) => {
    if (!pixelId.trim()) {
      pushSystemLog("Set a Pixel ID before firing events.");
      return;
    }

    const eventTimeSeconds = Math.floor(Date.now() / 1000);
    const conversionId = options?.conversionId ?? crypto.randomUUID();

    ensureRedditPixel(pixelId, debugMode);

    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    /** Same id on Pixel + CAPI for deduplication; Pixel uses `conversionId` per Reddit pixel.js. */
    const enrichedPayload = {
      ...payload,
      conversion_id: conversionId,
      conversionId,
      ...(options?.userId ? { simulator_user_id: options.userId } : {})
    };

    const pixelPayload: PixelPayload = {
      eventType,
      payload: enrichedPayload,
      timestamp: new Date().toISOString()
    };

    const pixelFired = trackRedditEvent(eventType, enrichedPayload);
    appendLog({
      id: crypto.randomUUID(),
      source: "pixel",
      eventType,
      timestamp: pixelPayload.timestamp,
      payload: pixelPayload
    });

    if (!pixelFired) {
      pushSystemLog("Pixel event failed: rdt unavailable");
    }

    try {
      const capi = await sendCapiEvent(eventType, enrichedPayload, {
        eventTimeSeconds,
        providedEmail: options?.providedEmail,
        externalId: options?.externalId
      });
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
      appendLog({
        id: crypto.randomUUID(),
        source: "capi",
        eventType,
        timestamp: new Date().toISOString(),
        payload: enrichedPayload,
        capi,
        replayOf: options?.replayOf
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
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
      appendLog({
        id: crypto.randomUUID(),
        source: "capi",
        eventType,
        timestamp: new Date().toISOString(),
        payload: {
          error: message
        }
      });
    }
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
    if (!pixelId.trim()) {
      pushSystemLog("Set a Pixel ID before simulating users.");
      return;
    }

    setSimulating(true);
    try {
      /** Browse funnel only; cart + purchase are appended so every user completes checkout. */
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
              eventPayload.currency = "USD";
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
                  currency: "USD"
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
              currency: "USD",
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
    let conversionId: string | undefined;

    const raw = entry.payload;
    if (raw && typeof raw === "object") {
      if (
        "payload" in raw &&
        typeof (raw as PixelPayload).payload === "object" &&
        (raw as PixelPayload).payload !== null
      ) {
        const inner = (raw as PixelPayload).payload as Record<string, unknown>;
        payload = { ...inner };
        conversionId =
          typeof inner.conversion_id === "string"
            ? inner.conversion_id
            : typeof inner.conversionId === "string"
              ? inner.conversionId
              : undefined;
      } else {
        payload = { ...(raw as Record<string, unknown>) };
        conversionId = typeof payload.conversion_id === "string" ? payload.conversion_id : undefined;
      }
    }

    await fireEvent(entry.eventType as RedditEventName, payload, {
      replayOf: entry.id,
      ...(conversionId ? { conversionId } : {})
    });
  };

  const sourceBadgeClass = (source: EventLogEntry["source"]) => {
    if (source === "pixel") return "bg-blue-100 text-blue-700";
    if (source === "capi") return "bg-emerald-100 text-emerald-700";
    return "bg-slate-200 text-slate-700";
  };

  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-100 via-slate-50 to-white">
      <div className="mx-auto max-w-7xl px-4 py-8 md:px-6 lg:px-8">
        <header className="mb-8 rounded-2xl border border-slate-200 bg-white/80 p-6 shadow-sm backdrop-blur">
          <h1 className="text-3xl font-bold tracking-tight text-slate-900 md:text-4xl">Reddit Pixel + CAPI Validation App</h1>
          <p className="mt-2 text-slate-600">Test client-side and server-side event delivery with shared logs.</p>
        </header>

      <section className="mb-6 grid gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm md:grid-cols-2">
        <label className="flex flex-col gap-2">
          <span className="text-sm font-medium text-slate-700">Reddit Pixel ID</span>
          <input
            className="rounded-lg border border-slate-300 p-2.5 text-sm shadow-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-200"
            value={pixelId}
            onChange={(e) => setPixelId(e.target.value)}
            placeholder="Enter Pixel ID"
          />
        </label>
        <label className="flex flex-col gap-2">
          <span className="text-sm font-medium text-slate-700">Test Event Code</span>
          <input
            className="rounded-lg border border-slate-300 p-2.5 text-sm shadow-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-200"
            value={testEventCode}
            onChange={(e) => setTestEventCode(e.target.value)}
            placeholder="Optional test event code"
          />
        </label>
        <div className="flex flex-wrap items-center gap-5">
          <label className="inline-flex items-center gap-2 text-sm font-medium text-slate-700">
            <input type="checkbox" checked={debugMode} onChange={(e) => setDebugMode(e.target.checked)} />
            <span>Debug Mode</span>
          </label>
          <label className="inline-flex items-center gap-2 text-sm font-medium text-slate-700">
            <input type="checkbox" checked={testMode} onChange={(e) => setTestMode(e.target.checked)} />
            <span>Test Mode</span>
          </label>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <span className="font-medium">Delay (ms):</span>
          <input
            type="number"
            className="w-32 rounded-lg border border-slate-300 p-2 text-sm shadow-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-200"
            value={delayMs}
            onChange={(e) => setDelayMs(Number(e.target.value) || 0)}
          />
        </label>
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
          onClick={() => fireEvent("ViewContent", { item_count: 1, content_type: "product", ...baseMeta })}
        >
          View Product
        </button>
        <button
          className="rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700"
          onClick={() => fireEvent("AddToCart", { value: 49.99, currency: "USD", quantity: 1, ...baseMeta })}
        >
          Add to Cart
        </button>
        <button
          className="rounded-lg bg-cyan-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-cyan-700"
          onClick={() =>
            fireEvent("ViewContent", {
              ...baseMeta,
              content_type: "cart",
              cart_view: true,
              item_count: 1,
              line_items: [{ id: baseMeta.product_id, quantity: 1, value: 49.99, currency: "USD" }]
            })
          }
        >
          View Cart
        </button>
        <button
          className="rounded-lg bg-purple-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-purple-700"
          onClick={() =>
            fireEvent("Purchase", {
              value: 99.99,
              currency: "USD",
              order_id: `order-${Date.now()}`,
              ...baseMeta
            })
          }
        >
          Purchase
        </button>
      </section>

      <section className="mb-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="mb-3 text-xl font-semibold text-slate-900">Sign Up Form</h2>
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
          <button className="rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800" type="submit">
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
            {simulating ? "Simulating users…" : "Idle"}
          </span>
        </div>
      </section>

      <section className="mb-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="mb-2 text-xl font-semibold text-slate-900">CAPI status</h2>
        <p className="mb-4 text-sm text-slate-600">
          Browser <code className="rounded bg-slate-100 px-1">POST /capi/event</code> → Reddit{" "}
          <code className="rounded bg-slate-100 px-1">/api/v2.0/conversions/events/{"{account_id}"}</code>. Env:{" "}
          <code className="rounded bg-slate-100 px-1">REDDIT_ACCESS_TOKEN</code>,{" "}
          <code className="rounded bg-slate-100 px-1">REDDIT_PIXEL_ID</code>, and{" "}
          <code className="rounded bg-slate-100 px-1">REDDIT_AD_ACCOUNT_ID</code> (or <code className="rounded bg-slate-100 px-1">aid</code>{" "}
          inside your JWT). One <code className="rounded bg-slate-100 px-1">conversion_id</code> per click for Pixel + CAPI.
        </p>
        {!capiStatus && <p className="text-sm text-slate-500">No CAPI calls yet.</p>}
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
          <h2 className="mb-3 text-xl font-semibold text-slate-900">Live Event Log</h2>
          <div className="max-h-[500px] space-y-3 overflow-auto">
            {eventLog.length === 0 && <p className="text-sm text-slate-500">No events yet.</p>}
            {eventLog.map((entry) => (
              <article key={entry.id} className="rounded-xl border border-slate-200 bg-slate-50/60 p-3 text-sm">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <strong className={`rounded-full px-2.5 py-1 text-xs font-semibold ${sourceBadgeClass(entry.source)}`}>
                    {entry.source.toUpperCase()}
                  </strong>
                  <span className="text-slate-500">{new Date(entry.timestamp).toLocaleTimeString()}</span>
                </div>
                <p className="font-semibold text-slate-900">{entry.eventType}</p>
                {typeof entry.payload === "object" &&
                  entry.payload !== null &&
                  "simulator_user_id" in entry.payload && (
                    <p className="text-xs text-slate-500">
                      Simulated user: {(entry.payload as { simulator_user_id: string }).simulator_user_id}
                    </p>
                  )}
                {entry.replayOf && <p className="text-xs text-slate-500">Replay of: {entry.replayOf}</p>}
                <pre className="mt-2 overflow-auto rounded-lg border border-slate-200 bg-white p-2 text-xs text-slate-700">
                  {JSON.stringify(entry.payload, null, 2)}
                </pre>
                {entry.capi && (
                  <pre className="mt-2 overflow-auto rounded-lg border border-slate-200 bg-white p-2 text-xs text-slate-700">
                    {JSON.stringify(entry.capi, null, 2)}
                  </pre>
                )}
                {entry.source !== "system" && (
                  <button
                    className="mt-2 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 transition hover:bg-slate-100"
                    onClick={() => replayEvent(entry)}
                  >
                    Replay
                  </button>
                )}
              </article>
            ))}
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="mb-3 text-xl font-semibold text-slate-900">Raw Payload Inspector</h2>
          <p className="mb-2 text-sm text-slate-600">Most recent payload sent to Pixel/CAPI:</p>
          <pre className="max-h-[500px] overflow-auto rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
            {JSON.stringify(lastPayload, null, 2)}
          </pre>
        </div>
      </section>
      </div>
    </main>
  );
}
