# Reddit Pixel + Conversion API Test Website

This project is a minimal full-stack environment for validating Reddit Pixel (client-side) and Reddit Conversion API (server-side) events together.

## What it includes

- Next.js frontend with:
  - Dynamic Pixel ID input
  - Buttons for `PageVisit`, `ViewContent`, `AddToCart`, `Purchase`
  - `SignUp` form (`name + email`)
  - Live event log with timestamps, payloads, backend request/response
  - Test Mode + Test Event Code toggle
  - Delay simulation, simulated users, and event replay
- Express backend with:
  - `POST /capi/event` endpoint
  - Reddit CAPI forwarding
  - SHA-256 hashing of email in `user_data`
  - Environment variable support for Reddit token and account details

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

- `REDDIT_AD_ACCOUNT_ID`
- `REDDIT_ACCESS_TOKEN`
- Optional: `REDDIT_TEST_EVENT_CODE`

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

Backend should be deployed separately (for example Render/Railway/Fly/another Vercel project) and must include:

- `REDDIT_ACCESS_TOKEN`
- `REDDIT_AD_ACCOUNT_ID`
- Optional `REDDIT_TEST_EVENT_CODE`

## How to test events

1. Enter your Reddit Pixel ID.
2. (Optional) enable Test Mode and add test event code.
3. Trigger events with the UI buttons/form.
4. Each action sends:
   - Pixel event via `window.rdt("track", ...)`
   - Server request to `/capi/event` for Reddit CAPI
5. Inspect:
   - In-app event log (frontend + backend response)
   - Reddit Ads dashboard event diagnostics / test events

## Verification in Reddit Ads

- In Reddit Ads Manager, open your Pixel and Conversion diagnostics.
- Fire events from this app and verify:
  - Event names match (`PageVisit`, `ViewContent`, `AddToCart`, `SignUp`, `Purchase`)
  - Event volume increments for pixel and server pathways
  - Test events appear when Test Mode is enabled

## Notes

- Pixel loading and tracking logic: `frontend/lib/redditPixel.ts`
- CAPI forwarding + hashing logic: `backend/app/server.js`
- UI actions and event orchestration: `frontend/app/page.tsx`
