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

export default function HomePage() {
  const [pixelId, setPixelId] = useState("");
  const [debugMode, setDebugMode] = useState(true);
  const [testMode, setTestMode] = useState(false);
  const [testEventCode, setTestEventCode] = useState("");
  const [delayMs, setDelayMs] = useState(0);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [eventLog, setEventLog] = useState<EventLogEntry[]>([]);
  const [busy, setBusy] = useState(false);

  const lastPayload = useMemo(() => eventLog[0]?.payload || null, [eventLog]);

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
    providedEmail?: string
  ): Promise<CapiResult> => {
    const requestBody = {
      event_name: eventName,
      event_time: Math.floor(Date.now() / 1000),
      event_source_url: window.location.href,
      action_source: "website",
      user_data: {
        email: providedEmail || email || undefined
      },
      custom_data: payload,
      test_mode: testMode,
      test_event_code: testMode ? testEventCode || undefined : undefined
    };

    const response = await fetch(`${BACKEND_URL}/capi/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody)
    });
    const body = await response.json();
    return {
      ok: response.ok,
      status: response.status,
      responseBody: body,
      requestBody
    };
  };

  const fireEvent = async (
    eventType: RedditEventName,
    payload: Record<string, unknown>,
    options?: { replayOf?: string; providedEmail?: string }
  ) => {
    if (!pixelId.trim()) {
      pushSystemLog("Set a Pixel ID before firing events.");
      return;
    }

    setBusy(true);
    ensureRedditPixel(pixelId, debugMode);

    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    const pixelPayload: PixelPayload = {
      eventType,
      payload,
      timestamp: new Date().toISOString()
    };

    const pixelFired = trackRedditEvent(eventType, payload);
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
      const capi = await sendCapiEvent(eventType, payload, options?.providedEmail);
      appendLog({
        id: crypto.randomUUID(),
        source: "capi",
        eventType,
        timestamp: new Date().toISOString(),
        payload,
        capi,
        replayOf: options?.replayOf
      });
    } catch (error) {
      appendLog({
        id: crypto.randomUUID(),
        source: "capi",
        eventType,
        timestamp: new Date().toISOString(),
        payload: {
          error: error instanceof Error ? error.message : String(error)
        }
      });
    } finally {
      setBusy(false);
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
    for (let i = 0; i < 3; i += 1) {
      const user = randomUser();
      await fireEvent(
        "SignUp",
        {
          name: user.name,
          email: user.email,
          ...baseMeta
        },
        { providedEmail: user.email }
      );
      await fireEvent("Purchase", {
        value: 49.99 + i,
        currency: "USD",
        order_id: `order-${Date.now()}-${i}`,
        ...baseMeta
      });
    }
  };

  const replayEvent = async (entry: EventLogEntry) => {
    if (entry.source === "system") return;
    const payload =
      typeof entry.payload === "object" && entry.payload !== null ? (entry.payload as Record<string, unknown>) : {};
    await fireEvent(entry.eventType as RedditEventName, payload, { replayOf: entry.id });
  };

  return (
    <main className="mx-auto min-h-screen max-w-6xl p-6">
      <h1 className="mb-2 text-3xl font-bold">Reddit Pixel + CAPI Validation App</h1>
      <p className="mb-6 text-slate-600">Test client-side and server-side event delivery with shared logs.</p>

      <section className="mb-6 grid gap-4 rounded-lg border bg-white p-4 md:grid-cols-2">
        <label className="flex flex-col gap-2">
          <span className="text-sm font-medium">Reddit Pixel ID</span>
          <input
            className="rounded border p-2"
            value={pixelId}
            onChange={(e) => setPixelId(e.target.value)}
            placeholder="Enter Pixel ID"
          />
        </label>
        <label className="flex flex-col gap-2">
          <span className="text-sm font-medium">Test Event Code</span>
          <input
            className="rounded border p-2"
            value={testEventCode}
            onChange={(e) => setTestEventCode(e.target.value)}
            placeholder="Optional test event code"
          />
        </label>
        <div className="flex items-center gap-6">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={debugMode} onChange={(e) => setDebugMode(e.target.checked)} />
            <span>Debug Mode</span>
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={testMode} onChange={(e) => setTestMode(e.target.checked)} />
            <span>Test Mode</span>
          </label>
        </div>
        <label className="flex items-center gap-2">
          <span>Delay (ms):</span>
          <input
            type="number"
            className="w-32 rounded border p-2"
            value={delayMs}
            onChange={(e) => setDelayMs(Number(e.target.value) || 0)}
          />
        </label>
      </section>

      <section className="mb-6 grid gap-4 rounded-lg border bg-white p-4 md:grid-cols-2">
        <button
          className="rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
          onClick={() => fireEvent("PageVisit", { ...baseMeta })}
        >
          Fire PageVisit
        </button>
        <button
          className="rounded bg-indigo-600 px-4 py-2 text-white hover:bg-indigo-700"
          onClick={() => fireEvent("ViewContent", { item_count: 1, ...baseMeta })}
        >
          View Product
        </button>
        <button
          className="rounded bg-emerald-600 px-4 py-2 text-white hover:bg-emerald-700"
          onClick={() => fireEvent("AddToCart", { value: 49.99, currency: "USD", quantity: 1, ...baseMeta })}
        >
          Add to Cart
        </button>
        <button
          className="rounded bg-purple-600 px-4 py-2 text-white hover:bg-purple-700"
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

      <section className="mb-6 rounded-lg border bg-white p-4">
        <h2 className="mb-3 text-xl font-semibold">Sign Up Form</h2>
        <form className="grid gap-3 md:grid-cols-3" onSubmit={onSignUp}>
          <input
            className="rounded border p-2"
            placeholder="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <input
            type="email"
            className="rounded border p-2"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <button className="rounded bg-slate-900 px-4 py-2 text-white hover:bg-slate-800" type="submit">
            Sign Up
          </button>
        </form>
      </section>

      <section className="mb-6 rounded-lg border bg-white p-4">
        <div className="flex flex-wrap items-center gap-3">
          <button
            className="rounded bg-orange-600 px-4 py-2 text-white hover:bg-orange-700"
            onClick={simulateUsers}
            disabled={busy}
          >
            Simulate 3 Users
          </button>
          <span className="text-sm text-slate-600">{busy ? "Running events..." : "Idle"}</span>
        </div>
      </section>

      <section className="grid gap-6 md:grid-cols-2">
        <div className="rounded-lg border bg-white p-4">
          <h2 className="mb-3 text-xl font-semibold">Live Event Log</h2>
          <div className="max-h-[500px] space-y-3 overflow-auto">
            {eventLog.length === 0 && <p className="text-sm text-slate-500">No events yet.</p>}
            {eventLog.map((entry) => (
              <article key={entry.id} className="rounded border p-3 text-sm">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <strong>{entry.source.toUpperCase()}</strong>
                  <span className="text-slate-500">{new Date(entry.timestamp).toLocaleTimeString()}</span>
                </div>
                <p className="font-medium">{entry.eventType}</p>
                {entry.replayOf && <p className="text-xs text-slate-500">Replay of: {entry.replayOf}</p>}
                <pre className="mt-2 overflow-auto rounded bg-slate-100 p-2 text-xs">
                  {JSON.stringify(entry.payload, null, 2)}
                </pre>
                {entry.capi && (
                  <pre className="mt-2 overflow-auto rounded bg-slate-100 p-2 text-xs">
                    {JSON.stringify(entry.capi, null, 2)}
                  </pre>
                )}
                {entry.source !== "system" && (
                  <button
                    className="mt-2 rounded border px-2 py-1 text-xs hover:bg-slate-100"
                    onClick={() => replayEvent(entry)}
                  >
                    Replay
                  </button>
                )}
              </article>
            ))}
          </div>
        </div>

        <div className="rounded-lg border bg-white p-4">
          <h2 className="mb-3 text-xl font-semibold">Raw Payload Inspector</h2>
          <p className="mb-2 text-sm text-slate-600">Most recent payload sent to Pixel/CAPI:</p>
          <pre className="max-h-[500px] overflow-auto rounded bg-slate-100 p-3 text-xs">
            {JSON.stringify(lastPayload, null, 2)}
          </pre>
        </div>
      </section>
    </main>
  );
}
