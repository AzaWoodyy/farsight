"use client";

import { Analytics } from "@vercel/analytics/react";
import { SpeedInsights } from "@vercel/speed-insights/react";

// Page views and web vitals only: no custom event is ever sent. The link to an
// answer carries its question in the address (`?q=`, see question-link):
// dropping the query string and the hash keeps every question out of analytics.
function pathOnly<Event extends { url: string }>(event: Event): Event {
  const url = new URL(event.url);

  return { ...event, url: `${url.origin}${url.pathname}` };
}

// Outside production the packages load a debug script from another origin,
// which the CSP refuses. In production the scripts are same-origin
// (/_vercel/insights, /_vercel/speed-insights), injected with `defer` after hydration.
//
// The React components, not the Next ones: those read the search params to name the route, which takes its
// part of the page out of the static HTML (Next then closes the document and appends its scripts after
// </html>). No route here has a parameter, and the scripts follow navigations by themselves. The Next
// components also read where Vercel serves the scripts from; these two variables are what they passed.
export function SiteAnalytics() {
  if (process.env.NODE_ENV !== "production") return null;

  const served = {
    framework: "next",
    basePath: process.env.NEXT_PUBLIC_VERCEL_OBSERVABILITY_BASEPATH,
    configString: process.env.NEXT_PUBLIC_VERCEL_OBSERVABILITY_CLIENT_CONFIG,
  };

  return (
    <>
      <Analytics beforeSend={pathOnly} {...served} />
      <SpeedInsights beforeSend={pathOnly} {...served} />
    </>
  );
}
