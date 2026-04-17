import { RedditEventName } from "./types";

/**
 * Reddit's pixel.js expects a pre-bootstrap `window.rdt` that only uses `callQueue`.
 * After load, Reddit assigns `rdt.sendEvent` to a **function** — never `.push` on it.
 * @see https://www.redditstatic.com/ads/pixel.js (drains `callQueue`, sets `sendEvent`)
 */
type RedditRdtStub = ((...args: unknown[]) => void) & { callQueue: unknown[][] };

declare global {
  interface Window {
    rdt?: RedditRdtStub;
  }
}

let initializedPixelId: string | null = null;

function installRedditPixelStub() {
  if (typeof window === "undefined" || window.rdt) return;

  const callQueue: unknown[][] = [];
  const rdt = Object.assign(
    function rdt(...args: unknown[]) {
      callQueue.push(args);
    },
    { callQueue }
  ) as RedditRdtStub;

  window.rdt = rdt;

  const scriptTag = document.createElement("script");
  scriptTag.src = "https://www.redditstatic.com/ads/pixel.js";
  scriptTag.async = true;
  const firstScript = document.getElementsByTagName("script")[0];
  firstScript.parentNode?.insertBefore(scriptTag, firstScript);
}

export function ensureRedditPixel(pixelId: string, debug = true) {
  if (typeof window === "undefined" || !pixelId.trim()) return;

  installRedditPixelStub();

  if (initializedPixelId !== pixelId) {
    window.rdt?.("init", pixelId.trim(), { optOut: false, useDecimalCurrencyValues: true });
    initializedPixelId = pixelId;
    // Only once per pixel init — do not fire PageVisit on every button click (was causing huge Pixel noise).
    if (debug) {
      window.rdt?.("track", "PageVisit");
    }
  }
}

export function trackRedditEvent(eventName: RedditEventName, payload: Record<string, unknown>) {
  if (typeof window === "undefined" || !window.rdt) return false;
  window.rdt("track", eventName, payload);
  return true;
}
