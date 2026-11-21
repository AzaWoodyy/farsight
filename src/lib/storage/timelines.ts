import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { getCache } from "@vercel/functions";
import { z } from "zod";
import { loadRawGame } from "../sources/riot";
import { EVENT_KINDS, type ParsedTimeline, parseTimeline, TIMELINE_FORMAT } from "../sources/timeline";
import { FsStore, type ObjectStore, R2Store, r2ReadConfigFromEnv } from ".";

type ObjectReader = Pick<ObjectStore, "label" | "get">;

export type TimelineSource = "cache" | "r2" | "local";

export type TimelineLoad =
  | { status: "ok"; timeline: ParsedTimeline; source: TimelineSource; ms: number }
  | { status: "missing"; source: TimelineSource; ms: number }
  | { status: "unconfigured" }
  | { status: "error"; message: string; timeoutSeconds?: number; ms: number };

const TTL_S = 30 * 24 * 3600;
const MISSING_TTL_S = 3600;
const READ_TIMEOUT_MS = 8000;

const LOCAL_DIR = resolve(/*turbopackIgnore: true*/ process.cwd(), "data/raw/riot");

let store: { reader: ObjectReader; source: "r2" | "local" } | null | undefined;

function timelineStore() {
  if (store !== undefined) return store;
  const r2 = r2ReadConfigFromEnv();

  if (r2) store = { reader: new R2Store(r2), source: "r2" };
  else if (process.env.VERCEL !== "1" && existsSync(LOCAL_DIR)) store = { reader: new FsStore(LOCAL_DIR), source: "local" };
  else store = null;

  return store;
}

export function resetTimelineStore() {
  store = undefined;
}

const Cached = z.union([
  z.object({
    format: z.literal(TIMELINE_FORMAT),
    key: z.string(),
    version: z.number(),
    durationS: z.number().nullable(),
    winner: z.union([z.literal(100), z.literal(200)]).nullable(),
    gold: z.array(z.object({ s: z.number(), diff: z.number() })),
    events: z.array(
      z.object({ s: z.number(), kind: z.enum(EVENT_KINDS), team: z.union([z.literal(100), z.literal(200)]), detail: z.string().nullable() }),
    ),
  }),
  z.object({ missing: z.literal(true) }),
]);

const cacheKey = (key: string) => `timeline:v${TIMELINE_FORMAT}:${key}`;

const cache = () => getCache({ namespace: "lolesport" });

async function readCache(key: string) {
  try {
    const parsed = Cached.safeParse(await cache().get(cacheKey(key)));

    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function writeCache(key: string, value: z.infer<typeof Cached>, ttl: number) {
  try {
    await cache().set(cacheKey(key), value, { ttl, tags: ["timeline"], name: "game-timeline" });
  } catch {
  }
}

class ReadTimeout extends Error {
  constructor(readonly seconds: number) {
    super(`read took more than ${seconds} s`);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new ReadTimeout(ms / 1000)), ms).unref?.()),
  ]);
}

export async function loadTimeline(key: string): Promise<TimelineLoad> {
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  const hit = await readCache(key);

  if (hit) return "missing" in hit ? { status: "missing", source: "cache", ms: ms() } : { status: "ok", timeline: hit, source: "cache", ms: ms() };

  const s = timelineStore();

  if (!s) return { status: "unconfigured" };

  try {
    const raw = await withTimeout(loadRawGame(s.reader, key), READ_TIMEOUT_MS);
    const timeline = raw ? parseTimeline(raw) : null;

    if (!timeline) {
      await writeCache(key, { missing: true }, MISSING_TTL_S);

      return { status: "missing", source: s.source, ms: ms() };
    }

    await writeCache(key, timeline, TTL_S);

    return { status: "ok", timeline, source: s.source, ms: ms() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    return err instanceof ReadTimeout
      ? { status: "error", message, timeoutSeconds: err.seconds, ms: ms() }
      : { status: "error", message, ms: ms() };
  }
}
