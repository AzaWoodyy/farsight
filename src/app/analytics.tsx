"use client";

import { Analytics, type BeforeSendEvent } from "@vercel/analytics/react";

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
//
// The React component, not the Next one: that one reads the search params to name the route, which takes its
// part of the page out of the static HTML (Next then closes the document and appends its scripts after
// </html>). No route here has a parameter, and the script counts navigations by itself. The Next component
// also read where Vercel serves the script from; these two variables are what it passed.
export function SiteAnalytics() {
  if (process.env.NODE_ENV !== "production") return null;

  return (
    <Analytics
      beforeSend={pathOnly}
      framework="next"
      basePath={process.env.NEXT_PUBLIC_VERCEL_OBSERVABILITY_BASEPATH}
      configString={process.env.NEXT_PUBLIC_VERCEL_OBSERVABILITY_CLIENT_CONFIG}
    />
  );
}
