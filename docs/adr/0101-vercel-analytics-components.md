# Vercel Analytics and Speed Insights: the React components, in production only

`src/app/analytics.tsx` mounts `@vercel/analytics/react` and `@vercel/speed-insights/react` rather than the `/next` entry points the documentation suggests for a Next app, and renders nothing outside production.

## Rules

- `SiteAnalytics` returns null unless `NODE_ENV` is `production`: outside production the packages load a debug script from another origin, which the site's CSP refuses. In production the scripts are same-origin (`/_vercel/insights`, `/_vercel/speed-insights`) and injected with `defer` after hydration.
- The Next components (`@vercel/analytics/next`, `@vercel/speed-insights/next`) are not used: they read the search params to name the route, which takes their part of the page out of the static HTML (Next then closes the document and appends its scripts after `</html>`). No route here has a path parameter, so there is no route name to compute, and the scripts follow client navigations by themselves.
- The Next components also read where Vercel serves the scripts from. The React components are given the same values by hand: `framework: "next"`, `basePath` from `NEXT_PUBLIC_VERCEL_OBSERVABILITY_BASEPATH` and `configString` from `NEXT_PUBLIC_VERCEL_OBSERVABILITY_CLIENT_CONFIG`. Without them the scripts are requested from the wrong place when Vercel changes it.
