# Reddit Pixel + Conversion API Test Website

This project is a minimal full-stack environment for validating Reddit Pixel (client-side) and Reddit Conversion API (server-side) events together.

## What it includes

- Next.js frontend with:
  - Dynamic Pixel ID input (browser pixel only)
  - Buttons for `PageVisit`, `ViewContent`, `AddToCart`, `Purchase`, `View Cart`, etc.
  - `SignUp` form (`name + email`)
  - **Shared `conversion_id` / `conversionId`** on each action for Pixel + CAPI deduplication
  - Live event log and **CAPI status** panel (request to backend, JSON sent to Reddit, Reddit response)
  - Delay simulation, simulated users, and event replay
- Express backend with:
  - `POST /capi/event` — builds Reddit’s **v2.0** payload and posts to **`/api/v2.0/conversions/events/{account_id}`**
  - Env: **`REDDIT_ACCESS_TOKEN`**, **`REDDIT_PIXEL_ID`**, **`REDDIT_AD_ACCOUNT_ID`** (or account id read from JWT `aid` / `lid`)
  - Sandbox-friendly **`test_mode: true`** by default; console logging for debugging

## Project structure

- `frontend` - Next.js app
- `backend` - Express API server

## Setup (automated)

From the repository root:

```bash
npm install
npm run setup
```

`setup` installs backend + frontend dependencies and creates **`backend/.env`** and **`frontend/.env.local`** from the examples **only if those files do not exist yet**. Then edit **`backend/.env`** and set:

- `REDDIT_ACCESS_TOKEN` — Conversion Access Token (Bearer)
- `REDDIT_PIXEL_ID` — pixel id (included in `event_metadata`)
- `REDDIT_AD_ACCOUNT_ID` — Ads account id (e.g. `t2_…`) for the CAPI URL; optional if your JWT already includes `aid`
- Optional: `REDDIT_TEST_EVENT_CODE`

Edit **`frontend/.env.local`** if your API is not on `http://localhost:4000` (set `NEXT_PUBLIC_BACKEND_URL`).

Check configuration without starting the UI:

```bash
npm run verify
```

## Run

**Both** servers in one terminal:

```bash
npm run dev
```

Then open [http://localhost:3000](http://localhost:3000) (frontend) and ensure the backend answers at [http://localhost:4000/health/capi](http://localhost:4000/health/capi).

Or run them separately:

```bash
npm run dev:backend
npm run dev:frontend
```

## Deploy on Vercel (important)

This repository is a monorepo-style layout, so in Vercel Project Settings set:

- **Root Directory**: `frontend`
- **Framework Preset**: Next.js

Then add frontend env var:

- `NEXT_PUBLIC_BACKEND_URL` = your deployed backend URL

Backend should be deployed separately (for example Render/Railway/Fly) and must include:

- `REDDIT_ACCESS_TOKEN`
- `REDDIT_PIXEL_ID`
- `REDDIT_AD_ACCOUNT_ID` (recommended; otherwise JWT must expose `aid`)

## How to test events

1. Enter your Reddit Pixel ID in the UI (for the browser pixel).
2. Trigger events with the UI buttons/form.
3. Each action:
   - Fires the Pixel with `conversionId` + `conversion_id`
   - POSTs to your `/capi/event` with the same `conversion_id` and `event_time`
4. Inspect:
   - Browser **Network** tab: `/capi/event` and Reddit response (via your server JSON)
   - **CAPI status** panel and **Live Event Log**

## Verification in Reddit Ads

- In Reddit Ads Manager, open Events Manager / diagnostics.
- Confirm events and deduplication behavior using the shared conversion id.

## Troubleshooting CAPI (HTTP 500 / failures)

1. Open **`GET /health/capi`** on your backend — `capi_ready` must be `true` (token + pixel + **resolved account id**).
2. If **`reddit_account_id_resolved`** is false, set **`REDDIT_AD_ACCOUNT_ID`** (from Reddit Ads Manager, often `t2_…`) or use a conversion JWT that includes **`aid`**.
3. The old flat URL **`/api/v2/conversions/events`** (no account in path) is **not** what this server uses anymore — redeploy the latest backend if errors persist.

Secrets belong only on the **backend** host env, not on Vercel `NEXT_PUBLIC_*` vars.

## Notes

- Pixel loading and tracking: `frontend/lib/redditPixel.ts`
- CAPI forwarding: `backend/app/server.js`
- UI orchestration: `frontend/app/page.tsx`
