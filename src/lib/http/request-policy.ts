import { createHash } from "node:crypto";
import { ipAddress } from "@vercel/functions";

type Bucket = { count: number; until: number };

const buckets = new Map<string, Bucket>();
const WINDOW_MS = 10 * 60 * 1_000;
const MAX_BUCKETS = 10_000;

/** Instance-local limit supplements Vercel's shared firewall. No IP is logged or traced. */
export function rateLimited(req: Request, route: "ask" | "feedback", now = Date.now()): boolean {
  const ip = ipAddress(req) ?? "local";
  const key = createHash("sha256").update(`${route}:${ip}`).digest("hex");
  let bucket = buckets.get(key);

  if (!bucket || bucket.until <= now) {
    for (const [id, item] of buckets) if (item.until <= now) buckets.delete(id);

    // Fail closed when full rather than evicting active quotas for new IPs.
    if (buckets.size >= MAX_BUCKETS) return true;
    bucket = { count: 0, until: now + WINDOW_MS };
    buckets.set(key, bucket);
  }

  bucket.count++;

  return bucket.count > (route === "ask" ? 15 : 30);
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
