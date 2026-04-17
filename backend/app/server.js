/**
 * Reddit Conversion API (CAPI) — server-side attribution partner to the browser Pixel.
 *
 * Why two channels?
 * - Pixel: runs in the browser; strong for on-site behavior, but can be blocked or drop requests.
 * - CAPI: server-to-Reddit; resilient, can include hashed PII, and pairs with the Pixel for coverage.
 *
 * Deduplication (conversion_id):
 * - Advertisers often fire the SAME logical conversion from Pixel and CAPI.
 * - Reddit matches pairs using a shared `conversion_id` (we mirror it into `event_metadata.conversion_id`).
 * - If Pixel and CAPI use DIFFERENT IDs, Reddit may count ONE sale TWICE — inflating results and breaking trust.
 *
 * Endpoint note:
 * - Docs sometimes describe a flat `POST .../api/v2/conversions/events` body with `pixel_id` at the top level.
 * - The live Ads API expects v2.0: `POST https://ads-api.reddit.com/api/v2.0/conversions/events/{account_id}`
 *   with `events[]` shaped as `event_at`, `event_type`, `user`, `event_metadata` (pixel_id lives in metadata).
 * - This server translates our simple `/capi/event` JSON into that v2.0 shape so calls succeed in production-like tests.
 *
 * Env: REDDIT_ACCESS_TOKEN, REDDIT_PIXEL_ID, REDDIT_AD_ACCOUNT_ID (or `aid` / `lid` inside a JWT).
 */

const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");

dotenv.config();

const app = express();

app.set("trust proxy", true);
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const port = process.env.PORT || 4000;

const RDT_STANDARD = new Set([
  "PageVisit",
  "Search",
  "AddToCart",
  "AddToWishlist",
  "Purchase",
  "ViewContent",
  "Lead",
  "SignUp",
  "Custom"
]);

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

function hashEmail(email) {
  if (!email || typeof email !== "string") return undefined;
  const t = email.trim().toLowerCase();
  const p = t.split("@");
  if (p.length !== 2) return undefined;
  const local = p[0].replace(/\./g, "").split("+")[0] || p[0];
  return sha256(`${local}@${p[1]}`);
}

function hashExternalId(v) {
  if (!v || typeof v !== "string") return undefined;
  const t = v.trim();
  if (/^[a-f0-9]{64}$/i.test(t)) return t.toLowerCase();
  return sha256(t.toLowerCase());
}

function hashIp(ip) {
  if (!ip || typeof ip !== "string") return undefined;
  const t = ip.trim();
  if (!t) return undefined;
  return sha256(t.toLowerCase());
}

/** Reddit Ads JWT (conversion access token) often includes advertiser id as `aid` / `lid`. */
function extractAccountIdFromJwt(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  try {
    const part = token.split(".")[1];
    const json = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    if (json.aid && typeof json.aid === "string") return json.aid.trim();
    if (json.lid && typeof json.lid === "string") return json.lid.trim();
  } catch {
    return null;
  }
  return null;
}

function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) {
    const first = String(xff).split(",")[0].trim();
    if (first) return first;
  }
  return req.socket?.remoteAddress || "";
}

function getAccessToken() {
  return (process.env.REDDIT_ACCESS_TOKEN || process.env.REDDIT_CONVERSION_ACCESS_TOKEN || "").trim();
}

function getAccountId() {
  const fromEnv = (process.env.REDDIT_AD_ACCOUNT_ID || "").trim();
  if (fromEnv) return fromEnv;
  const token = getAccessToken();
  return extractAccountIdFromJwt(token) || "";
}

function buildEventType(name) {
  const n = String(name || "").trim();
  if (RDT_STANDARD.has(n) && n !== "Custom") return { tracking_type: n };
  return { tracking_type: "Custom", custom_event_name: n || "Custom" };
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "reddit-capi-test-backend" });
});

app.get("/health/capi", (_req, res) => {
  const token = getAccessToken();
  const pixel = (process.env.REDDIT_PIXEL_ID || "").trim();
  const account = getAccountId();
  res.json({
    ok: true,
    reddit_access_token_configured: Boolean(token),
    reddit_pixel_id_configured: Boolean(pixel),
    reddit_ad_account_id_configured: Boolean((process.env.REDDIT_AD_ACCOUNT_ID || "").trim()),
    reddit_account_id_resolved: Boolean(account),
    account_id_source: (process.env.REDDIT_AD_ACCOUNT_ID || "").trim()
      ? "REDDIT_AD_ACCOUNT_ID"
      : account
        ? "JWT aid/lid"
        : "missing",
    capi_ready: Boolean(token && pixel && account),
    hint: "CAPI uses POST .../api/v2.0/conversions/events/{account_id}. Set REDDIT_AD_ACCOUNT_ID (e.g. t2_xxx) or use a JWT token that includes aid."
  });
});

app.post("/capi/event", async (req, res) => {
  const accessToken = getAccessToken();
  const pixelId = (process.env.REDDIT_PIXEL_ID || "").trim();
  const accountId = getAccountId();

  try {
    const {
      event_name,
      event_time,
      event_source_url,
      conversion_id,
      custom_data = {},
      client_user_agent,
      user_data = {},
      value: bodyValue,
      currency: bodyCurrency,
      test_mode,
      test_event_code: testEventCodeBody
    } = req.body;

    if (!event_name || !event_source_url) {
      return res.status(400).json({
        ok: false,
        error: "event_name and event_source_url are required"
      });
    }

    if (!conversion_id || typeof conversion_id !== "string") {
      return res.status(400).json({
        ok: false,
        error: "conversion_id is required (same id as Pixel for deduplication)"
      });
    }

    if (!accessToken || !pixelId) {
      const missing = [];
      if (!accessToken) missing.push("REDDIT_ACCESS_TOKEN");
      if (!pixelId) missing.push("REDDIT_PIXEL_ID");
      return res.status(500).json({
        ok: false,
        error: `Missing: ${missing.join(", ")}`,
        missing
      });
    }

    if (!accountId) {
      return res.status(500).json({
        ok: false,
        error:
          "Missing Reddit ad account id for CAPI URL. Set REDDIT_AD_ACCOUNT_ID (e.g. t2_abc from Ads Manager) or use a conversion JWT that contains an `aid` claim.",
        hint: "GET /health/capi — account_id_resolved should be true."
      });
    }

    const eventTimeSec =
      typeof event_time === "number" && Number.isFinite(event_time)
        ? event_time
        : Math.floor(Date.now() / 1000);
    const eventAtIso = new Date(eventTimeSec * 1000).toISOString();

    const ua = (client_user_agent && String(client_user_agent).trim()) || req.get("user-agent") || "";
    const ipPlain = clientIp(req);

    const merged =
      custom_data && typeof custom_data === "object" && !Array.isArray(custom_data) ? { ...custom_data } : {};
    delete merged.conversion_id;
    delete merged.conversionId;

    const v = merged.value != null ? merged.value : bodyValue;
    const cur = merged.currency != null ? merged.currency : bodyCurrency;
    if (v != null && v !== "") {
      const n = Number(v);
      merged.value = Number.isNaN(n) ? v : n;
    }
    if (cur != null && cur !== "") merged.currency = String(cur);

    const event_metadata = {
      ...merged,
      conversion_id: String(conversion_id),
      url: String(event_source_url),
      pixel_id: pixelId
    };

    const user = {};
    const plainEmail = user_data?.email || merged.email;
    if (plainEmail && typeof plainEmail === "string") {
      const h = hashEmail(plainEmail);
      if (h) user.email = h;
    }
    if (user_data?.external_id) {
      const h = hashExternalId(String(user_data.external_id));
      if (h) user.external_id = h;
    }
    if (ua) user.user_agent = ua;
    const ipHash = hashIp(ipPlain);
    if (ipHash) user.ip = ipHash;

    const redditEvent = {
      event_at: eventAtIso,
      event_type: buildEventType(event_name),
      user,
      event_metadata
    };

    const cid = user_data?.click_id || merged.rdt_cid;
    if (cid) redditEvent.click_id = String(cid);

    const redditRequestBody = {
      test_mode: test_mode !== false,
      events: [redditEvent]
    };

    const testCodeFromEnv = (process.env.REDDIT_TEST_EVENT_CODE || "").trim();
    const testCodeFromClient =
      typeof testEventCodeBody === "string" && testEventCodeBody.trim() ? testEventCodeBody.trim() : "";
    const testCode = testCodeFromClient || testCodeFromEnv;
    if (redditRequestBody.test_mode && testCode) {
      redditRequestBody.test_event_code = testCode;
    }

    const url = `https://ads-api.reddit.com/api/v2.0/conversions/events/${encodeURIComponent(accountId)}`;

    console.log("[capi/event] POST", url);
    console.log("[capi/event] body (pixel_id in metadata only)", JSON.stringify(redditRequestBody, null, 2));

    const redditResponse = await fetch(url, {
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
      redditJson = { parse_error: true, raw: rawText.slice(0, 2000) };
    }

    if (redditResponse.ok) {
      console.log("[capi/event] Reddit OK", redditResponse.status);
    } else {
      console.error("[capi/event] Reddit error", redditResponse.status, redditJson);
    }

    return res.status(redditResponse.ok ? 200 : redditResponse.status || 502).json({
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

const server = app.listen(port, () => {
  console.log(`Reddit CAPI backend http://localhost:${port}`);
  const acc = getAccountId();
  console.log(
    acc
      ? `[capi] Account id resolved for v2.0 URL: ${acc.slice(0, 6)}…`
      : "[capi] WARNING: no account id — set REDDIT_AD_ACCOUNT_ID or use JWT with `aid`"
  );
});

server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    console.error(`[startup] Port ${port} is already in use. Stop the other process or set PORT=4001 in backend/.env`);
  } else {
    console.error("[startup]", err);
  }
  process.exit(1);
});
