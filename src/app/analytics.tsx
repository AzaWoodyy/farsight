"use client";

import { Analytics } from "@vercel/analytics/react";
import { SpeedInsights } from "@vercel/speed-insights/react";

function pathOnly<Event extends { url: string }>(event: Event): Event {
  const url = new URL(event.url);

  return { ...event, url: `${url.origin}${url.pathname}` };
}

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
