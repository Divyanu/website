const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const port = process.env.PORT || 4000;

const sha256 = (value) => crypto.createHash("sha256").update(value.trim().toLowerCase()).digest("hex");

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "reddit-capi-test-backend" });
});

app.post("/capi/event", async (req, res) => {
  try {
    const {
      event_name,
      event_time,
      event_source_url,
      action_source = "website",
      user_data = {},
      custom_data = {},
      test_mode = false,
      test_event_code
    } = req.body;

    if (!event_name || !event_time || !event_source_url) {
      return res.status(400).json({
        ok: false,
        error: "event_name, event_time, and event_source_url are required"
      });
    }

    const redditAccessToken = process.env.REDDIT_ACCESS_TOKEN;
    const adAccountId = process.env.REDDIT_AD_ACCOUNT_ID;
    if (!redditAccessToken || !adAccountId) {
      return res.status(500).json({
        ok: false,
        error: "Missing REDDIT_ACCESS_TOKEN or REDDIT_AD_ACCOUNT_ID in environment"
      });
    }

    // Reddit CAPI payload includes hashed PII in user_data.
    const payload = {
      event_attribution_token: adAccountId,
      events: [
        {
          event_name,
          event_time,
          event_source: {
            url: event_source_url
          },
          action_source,
          user_data: {
            ...user_data,
            email: user_data.email ? sha256(user_data.email) : undefined
          },
          custom_data
        }
      ],
      test_mode: Boolean(test_mode),
      test_event_code: test_mode ? test_event_code || process.env.REDDIT_TEST_EVENT_CODE || undefined : undefined
    };

    const redditResponse = await fetch("https://ads-api.reddit.com/api/v2/conversions/events", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${redditAccessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const responseBody = await redditResponse.json().catch(() => ({}));

    return res.status(redditResponse.status).json({
      ok: redditResponse.ok,
      reddit_status: redditResponse.status,
      reddit_response: responseBody,
      request_payload: payload
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

app.listen(port, () => {
  console.log(`Reddit CAPI backend listening on http://localhost:${port}`);
});
