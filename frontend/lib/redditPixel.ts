import { RedditEventName } from "./types";

declare global {
  interface Window {
    rdt?: (...args: unknown[]) => void;
  }
}

let initializedPixelId: string | null = null;

export function ensureRedditPixel(pixelId: string, debug = true) {
  if (typeof window === "undefined" || !pixelId.trim()) return;

  if (!window.rdt) {
    // Official Reddit bootstrap snippet adapted for dynamic loading.
    (function (w, d) {
      if ((w as Window).rdt) return;
      const p = ((w as Window).rdt = function () {
        // Queue until external script is loaded.
        (p as unknown as { sendEvent?: unknown[] }).sendEvent
          ? (p as unknown as { sendEvent: unknown[] }).sendEvent.push(arguments)
          : ((p as unknown as { callQueue?: unknown[][] }).callQueue = [
              ...(p as unknown as { callQueue?: unknown[][] }).callQueue || [],
              Array.from(arguments)
            ]);
      } as unknown as (...args: unknown[]) => void);
      const scriptTag = d.createElement("script");
      scriptTag.src = "https://www.redditstatic.com/ads/pixel.js";
      scriptTag.async = true;
      const firstScript = d.getElementsByTagName("script")[0];
      firstScript.parentNode?.insertBefore(scriptTag, firstScript);
    })(window, document);
  }

  if (initializedPixelId !== pixelId) {
    window.rdt?.("init", pixelId.trim(), { optOut: false, useDecimalCurrencyValues: true });
    initializedPixelId = pixelId;
  }

  if (debug) {
    window.rdt?.("track", "PageVisit");
  }
}

export function trackRedditEvent(eventName: RedditEventName, payload: Record<string, unknown>) {
  if (typeof window === "undefined" || !window.rdt) return false;
  window.rdt("track", eventName, payload);
  return true;
}
