/**
 * Reddit Conversion API (CAPI) — sandbox integration
 *
 * Forwards browser-originated events to Reddit using the payload shape required for this project.
 * Secrets stay server-side: REDDIT_ACCESS_TOKEN, REDDIT_PIXEL_ID (never sent to the browser).
 *
 * Reddit endpoint (per project spec):
 *   POST https://ads-api.reddit.com/api/v2/conversions/events
 */

const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");

dotenv.config();

const app = express();

app.set("trust proxy", true);
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const port = process.env.PORT || 4000;

const REDDIT_CAPI_URL = "https://ads-api.reddit.com/api/v2/conversions/events";

function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) {
    const first = String(xff).split(",")[0].trim();
    if (first) return first;
  }
  return req.socket?.remoteAddress || "";
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "reddit-capi-test-backend" });
});

/** Quick check that CAPI env is set (no secrets returned). */
app.get("/health/capi", (_req, res) => {
  const token = (process.env.REDDIT_ACCESS_TOKEN || process.env.REDDIT_CONVERSION_ACCESS_TOKEN || "").trim();
  const pixel = (process.env.REDDIT_PIXEL_ID || "").trim();
  res.json({
    ok: true,
    reddit_access_token_configured: Boolean(token),
    reddit_pixel_id_configured: Boolean(pixel),
    capi_ready: Boolean(token && pixel),
    hint: "Set REDDIT_ACCESS_TOKEN and REDDIT_PIXEL_ID on this server (Render/Railway/etc.). REDDIT_AD_ACCOUNT_ID is not used by this app."
  });
});

function getAccessToken() {
  return (process.env.REDDIT_ACCESS_TOKEN || process.env.REDDIT_CONVERSION_ACCESS_TOKEN || "").trim();
}

app.post("/capi/event", async (req, res) => {
  const accessToken = getAccessToken();
  const pixelId = (process.env.REDDIT_PIXEL_ID || "").trim();

  try {
    const {
      event_name,
      event_time,
      event_source_url,
      conversion_id,
      custom_data = {},
      client_user_agent,
      value: bodyValue,
      currency: bodyCurrency,
      test_mode
    } = req.body;

    if (!event_name || !event_source_url) {
      console.warn("[capi/event] 400 missing fields", { event_name: !!event_name, event_source_url: !!event_source_url });
      return res.status(400).json({
        ok: false,
        error: "event_name and event_source_url are required"
      });
    }

    if (!conversion_id || typeof conversion_id !== "string") {
      console.warn("[capi/event] 400 missing conversion_id");
      return res.status(400).json({
        ok: false,
        error: "conversion_id is required (use the same id as the Pixel for deduplication)"
      });
    }

    if (!accessToken || !pixelId) {
      const missing = [];
      if (!accessToken) missing.push("REDDIT_ACCESS_TOKEN");
      if (!pixelId) missing.push("REDDIT_PIXEL_ID");
      console.error("[capi/event] 500 missing env:", missing.join(", "));
      return res.status(500).json({
        ok: false,
        error: `Missing environment variable(s): ${missing.join(", ")}. Add them in your host’s Environment settings and redeploy. This app does not use REDDIT_AD_ACCOUNT_ID.`,
        missing,
        docs: "GET /health/capi on this server to verify configuration."
      });
    }

    const eventTime =
      typeof event_time === "number" && Number.isFinite(event_time)
        ? event_time
        : Math.floor(Date.now() / 1000);

    const ua = (client_user_agent && String(client_user_agent).trim()) || req.get("user-agent") || "";
    const ip = clientIp(req);

    const merged =
      custom_data && typeof custom_data === "object" && !Array.isArray(custom_data) ? { ...custom_data } : {};
    delete merged.conversion_id;
    delete merged.conversionId;

    const v = merged.value != null ? merged.value : bodyValue;
    const c = merged.currency != null ? merged.currency : bodyCurrency;
    if (v != null && v !== "") {
      const n = Number(v);
      merged.value = Number.isNaN(n) ? v : n;
    }
    if (c != null && c !== "") {
      merged.currency = String(c);
    }

    const customDataOut = merged;

    const redditRequestBody = {
      test_mode: test_mode !== false,
      pixel_id: pixelId,
      events: [
        {
          event_name: String(event_name),
          event_time: eventTime,
          event_source_url: String(event_source_url),
          conversion_id: String(conversion_id),
          user_data: {
            ...(ip ? { client_ip_address: ip } : {}),
            ...(ua ? { client_user_agent: ua } : {})
          },
          custom_data: customDataOut
        }
      ]
    };

    console.log("[capi/event] Reddit CAPI request", JSON.stringify({ ...redditRequestBody, pixel_id: "[set]" }, null, 2));
    console.log("[capi/event] POST", REDDIT_CAPI_URL);

    const redditResponse = await fetch(REDDIT_CAPI_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": "reddit-capi-test-backend/1.0"
      },
      body: JSON.stringify(redditRequestBody)
    });

    const rawText = await redditResponse.text();
    let redditJson;
    try {
      redditJson = rawText ? JSON.parse(rawText) : {};
    } catch {
      redditJson = { parse_error: true, raw: rawText };
    }

    if (redditResponse.ok) {
      console.log("[capi/event] Reddit OK", redditResponse.status, JSON.stringify(redditJson, null, 2));
    } else {
      console.error("[capi/event] Reddit error", redditResponse.status, JSON.stringify(redditJson, null, 2));
    }

    return res.status(redditResponse.ok ? 200 : redditResponse.status).json({
      ok: redditResponse.ok,
      status: redditResponse.status,
      reddit_status: redditResponse.status,
      reddit_response: redditJson,
      reddit_request_body: redditRequestBody,
      backend_received: req.body
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[capi/event] Exception", message, error);
    return res.status(500).json({
      ok: false,
      error: message,
      reddit_request_body: null,
      backend_received: req.body
    });
  }
});

app.listen(port, () => {
  console.log(`Reddit CAPI backend listening on http://localhost:${port}`);
  console.log(`CAPI → ${REDDIT_CAPI_URL} (sandbox: test_mode defaults to true)`);
  if (!getAccessToken() || !process.env.REDDIT_PIXEL_ID?.trim()) {
    console.warn(
      "[startup] CAPI is not fully configured: set REDDIT_ACCESS_TOKEN (or REDDIT_CONVERSION_ACCESS_TOKEN) and REDDIT_PIXEL_ID. Check GET /health/capi"
    );
  }
});
