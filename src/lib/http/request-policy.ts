import { createHash } from "node:crypto";
import { ipAddress } from "@vercel/functions";

type Bucket = { count: number; until: number };

const buckets = new Map<string, Bucket>();
const WINDOW_MS = 10 * 60 * 1_000;
const MAX_BUCKETS = 10_000;

export const RATE_LIMITS = { ask: 30, feedback: 30, card: 300, link: 300 } as const;

export function rateLimited(req: Request, route: keyof typeof RATE_LIMITS, now = Date.now()): boolean {
  const ip = ipAddress(req) ?? "local";
  const key = createHash("sha256").update(`${route}:${ip}`).digest("hex");
  let bucket = buckets.get(key);

  if (!bucket || bucket.until <= now) {
    if (bucket) buckets.delete(key);

    if (buckets.size >= MAX_BUCKETS) {
      for (const [id, item] of buckets) {
        if (item.until > now) break;
        buckets.delete(id);
      }

      if (buckets.size >= MAX_BUCKETS) {
        const oldest = buckets.keys().next().value;

        if (oldest !== undefined) buckets.delete(oldest);
      }
    }

    bucket = { count: 0, until: now + WINDOW_MS };
    buckets.set(key, bucket);
  }

  bucket.count++;

  return bucket.count > RATE_LIMITS[route];
}

export function requestPolicy(req: Request, route: "ask" | "feedback"): Response | null {
  if (req.headers.get("sec-fetch-site") === "cross-site")
    return Response.json({ error: "cross-site request denied" }, { status: 403 });

  if (req.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json")
    return Response.json({ error: "application/json required" }, { status: 415 });

  if (rateLimited(req, route))
    return Response.json({ error: "too many requests" }, { status: 429, headers: { "Retry-After": "600" } });

  return null;
}
