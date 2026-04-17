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
  - `POST /capi/event` — accepts event fields, fills **IP** and **user agent** from the request, injects **`REDDIT_PIXEL_ID`** and **`REDDIT_ACCESS_TOKEN`** from env (never sent to the browser)
  - Forwards to `POST https://ads-api.reddit.com/api/v2/conversions/events` with sandbox-friendly **`test_mode: true`**
  - Console logging for debugging

## Project structure

- `frontend` - Next.js app
- `backend` - Express API server

## Setup

1. Install dependencies:

```bash
npm run install:all
```

2. Configure backend environment:

```bash
cp backend/.env.example backend/.env
```

Then set:

- `REDDIT_ACCESS_TOKEN` — Conversion Access Token (Bearer)
- `REDDIT_PIXEL_ID` — same pixel you use in the UI (server attaches it to the CAPI payload)

3. Configure frontend environment:

```bash
cp frontend/.env.example frontend/.env.local
```

Defaults to backend URL `http://localhost:4000`.

## Run

Run backend:

```bash
npm run dev:backend
```

Run frontend (new terminal):

```bash
npm run dev:frontend
```

Open [http://localhost:3000](http://localhost:3000).

## Deploy on Vercel (important)

This repository is a monorepo-style layout, so in Vercel Project Settings set:

- **Root Directory**: `frontend`
- **Framework Preset**: Next.js

Then add frontend env var:

- `NEXT_PUBLIC_BACKEND_URL` = your deployed backend URL

Backend should be deployed separately (for example Render/Railway/Fly) and must include:

- `REDDIT_ACCESS_TOKEN`
- `REDDIT_PIXEL_ID`

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

## Troubleshooting CAPI env errors

If you see **`REDDIT_AD_ACCOUNT_ID`** in an error message, that text is from an **older backend build**. Redeploy the current `backend/app/server.js` from this repo.

This server only needs:

- `REDDIT_ACCESS_TOKEN` (or `REDDIT_CONVERSION_ACCESS_TOKEN`)
- `REDDIT_PIXEL_ID`

On Render, Railway, Fly, etc., add those in **Environment Variables** for the **backend** service (not only Vercel). A local `.env` file is **not** uploaded to the cloud unless your host loads it.

Verify without secrets: open **`GET https://<your-backend-host>/health/capi`** — both flags should be `true`.

## Notes

- Pixel loading and tracking: `frontend/lib/redditPixel.ts`
- CAPI forwarding: `backend/app/server.js`
- UI orchestration: `frontend/app/page.tsx`
