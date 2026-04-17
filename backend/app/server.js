/**
 * Reddit Conversion API (CAPI) — server-side forwarding
 *
 * Reddit expects v2.0 format (not the legacy v2 shape we used before):
 *   POST https://ads-api.reddit.com/api/v2.0/conversions/events/{REDDIT_AD_ACCOUNT_ID}
 *   Authorization: Bearer {Conversion Access Token}
 *
 * Reference: PostHog’s maintained template (reddit.template.ts) + Reddit help / partner docs.
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

const RDT_STANDARD_EVENTS = new Set([
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

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

/** Reddit-style email normalization before SHA-256 (simplified; aligns with common CAPI practice). */
function hashEmailForReddit(email) {
  if (!email || typeof email !== "string") return undefined;
  const trimmed = email.trim().toLowerCase();
  const parts = trimmed.split("@");
  if (parts.length !== 2) return undefined;
  const local = parts[0].replace(/\./g, "").split("+")[0] || parts[0];
  const normalized = `${local}@${parts[1]}`;
  return sha256(normalized);
}

/** External ID: pass through if already 64-char hex, else SHA-256 of trimmed string. */
function hashExternalIdForReddit(value) {
  if (!value || typeof value !== "string") return undefined;
  const t = value.trim();
  if (/^[a-f0-9]{64}$/i.test(t)) return t.toLowerCase();
  return sha256(t.toLowerCase());
}

function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) {
    const first = String(xff).split(",")[0].trim();
    if (first) return first;
  }
  return req.socket?.remoteAddress || "";
}

function buildEventType(eventName) {
  const name = String(eventName || "").trim();
  if (RDT_STANDARD_EVENTS.has(name) && name !== "Custom") {
    return { tracking_type: name };
  }
  return { tracking_type: "Custom", custom_event_name: name || "Custom" };
}

function buildEventMetadata(customData, eventSourceUrl, pixelIdFromEnv) {
  const meta =
    customData && typeof customData === "object" && !Array.isArray(customData) ? { ...customData } : {};

  if (eventSourceUrl) meta.url = eventSourceUrl;
  if (pixelIdFromEnv) meta.pixel_id = pixelIdFromEnv;

  if (meta.value != null && typeof meta.value !== "number") {
    const n = Number(meta.value);
    if (!Number.isNaN(n)) meta.value = n;
  }

  if (meta.order_id != null && meta.conversion_id == null) {
    meta.conversion_id = String(meta.order_id);
  }

  return meta;
}

function buildRedditUser(userData, clientUserAgent, req) {
  const user = {};
  const plainEmail = userData?.email;
  if (plainEmail) {
    const hashed = hashEmailForReddit(plainEmail);
    if (hashed) user.email = hashed;
  }
  if (userData?.external_id) {
    const h = hashExternalIdForReddit(String(userData.external_id));
    if (h) user.external_id = h;
  }
  if (userData?.phone_number && typeof userData.phone_number === "string") {
    const digits = userData.phone_number.replace(/\D/g, "");
    if (digits.length >= 4) user.phone_number = sha256(digits);
  }

  const ua = (clientUserAgent && String(clientUserAgent).trim()) || req.get("user-agent") || "";
  if (ua) user.user_agent = ua;

  const ip = clientIp(req);
  if (ip && ip !== "::1") user.ip_address = ip;

  return user;
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "reddit-capi-test-backend" });
});

app.post("/capi/event", async (req, res) => {
  const accessToken = process.env.REDDIT_ACCESS_TOKEN || process.env.REDDIT_CONVERSION_ACCESS_TOKEN;
  const accountId = (process.env.REDDIT_AD_ACCOUNT_ID || "").trim();
  const pixelIdEnv = (process.env.REDDIT_PIXEL_ID || "").trim();

  try {
    const {
      event_name,
      event_time,
      event_source_url,
      user_data = {},
      custom_data = {},
      client_user_agent,
      test_mode = false,
      test_event_code,
      value: bodyValue,
      currency: bodyCurrency,
      click_id
    } = req.body;

    if (!event_name || !event_source_url) {
      return res.status(400).json({
        ok: false,
        error: "event_name and event_source_url are required"
      });
    }

    if (!accessToken || !accountId) {
      console.error("[capi/event] Missing REDDIT_ACCESS_TOKEN or REDDIT_AD_ACCOUNT_ID");
      return res.status(500).json({
        ok: false,
        error: "Server missing REDDIT_ACCESS_TOKEN (Conversion Access Token) or REDDIT_AD_ACCOUNT_ID"
      });
    }

    const eventAtSeconds =
      typeof event_time === "number" && Number.isFinite(event_time)
        ? event_time
        : Math.floor(Date.now() / 1000);
    const eventAtIso = new Date(eventAtSeconds * 1000).toISOString();

    const mergedCustom = { ...custom_data };
    if (bodyValue != null && mergedCustom.value == null) mergedCustom.value = bodyValue;
    if (bodyCurrency != null && mergedCustom.currency == null) mergedCustom.currency = bodyCurrency;

    const userPayload = { ...user_data };
    delete userPayload.email_plain;

    const redditUser = buildRedditUser(userPayload, client_user_agent, req);

    const eventMetadata = buildEventMetadata(mergedCustom, event_source_url, pixelIdEnv || undefined);

    const redditEvent = {
      event_at: eventAtIso,
      event_type: buildEventType(event_name),
      user: redditUser,
      event_metadata: eventMetadata
    };

    const cid = click_id || user_data?.click_id || mergedCustom?.rdt_cid;
    if (cid) redditEvent.click_id = String(cid);

    const redditRequestBody = {
      test_mode: Boolean(test_mode),
      events: [redditEvent]
    };

    const envTestCode = process.env.REDDIT_TEST_EVENT_CODE;
    if (redditRequestBody.test_mode) {
      redditRequestBody.test_event_code = test_event_code || envTestCode || undefined;
    }

    const url = `https://ads-api.reddit.com/api/v2.0/conversions/events/${encodeURIComponent(accountId)}`;

    console.info("[capi/event] Forwarding to Reddit", {
      event_name,
      event_at: eventAtIso,
      url: event_source_url,
      reddit_url: url
    });

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
      redditJson = { raw: rawText };
    }

    if (!redditResponse.ok) {
      console.error("[capi/event] Reddit error", redditResponse.status, redditJson);
    } else {
      console.info("[capi/event] Reddit OK", redditResponse.status);
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
    console.error("[capi/event] Exception", message);
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
});
