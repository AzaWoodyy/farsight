"use client";

import { Analytics, type BeforeSendEvent } from "@vercel/analytics/next";

// Page views only: no custom event is ever sent, and a question travels in the
// body of POST /api/ask, never in the URL. Dropping the query string and the
// hash keeps that true if a shareable `?q=` link is added one day.
function pathOnly(event: BeforeSendEvent): BeforeSendEvent {
  const url = new URL(event.url);

  return { ...event, url: `${url.origin}${url.pathname}` };
}

// Outside production the package loads a debug script from another origin,
// which the CSP refuses. In production the script is same-origin
// (/_vercel/insights), injected with `defer` after hydration.
export function SiteAnalytics() {
  if (process.env.NODE_ENV !== "production") return null;

  return <Analytics beforeSend={pathOnly} />;
}
