import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { AwsClient } from "aws4fetch";
import { writeFileAtomic } from "../fs-atomic";

/**
 * Object storage for the per-game Riot JSON (end-of-game stats and the
 * minute-by-minute timeline). They stay out of SQL: the SQLite file only holds
 * what ingestion computes from them, and a game's detail is read one object at
 * a time.
 *
 * Two implementations behind one interface:
 * - `FsStore`: a local directory. It is the ingestion cache (data/raw/riot)
 *   and the store used by tests and local runs.
 * - `R2Store`: a Cloudflare R2 bucket through its S3-compatible API, signed
 *   with aws4fetch. Configured by the R2_* variables (docs/deploy.md).
 */
export interface ObjectStore {
  /** Short description for logs (never contains a secret). */
  readonly label: string;
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  has(key: string): Promise<boolean>;
  /** Every key under `prefix`. */
  list(prefix: string): Promise<string[]>;
}

const KEY = /^[\w.\-/]+$/;

function checkKey(key: string): string {
  if (!KEY.test(key) || key.includes("..") || key.startsWith("/")) throw new Error(`Invalid object key: ${key}`);

  return key;
}

export class FsStore implements ObjectStore {
  readonly label: string;

  constructor(private root: string) {
    this.label = `fs:${root}`;
  }

  // turbopackIgnore: the root is chosen at runtime (local cache in development);
  // without it the tracer would ship the whole project with the /api/ask function.
  private path(key: string) {
    return resolve(/*turbopackIgnore: true*/ this.root, checkKey(key));
  }

  async get(key: string) {
    const file = this.path(key);

    return existsSync(file) ? new Uint8Array(readFileSync(file)) : null;
  }

  /** Written to a temporary file then renamed, so an interrupted run never leaves half an object. */
  async put(key: string, body: Uint8Array, _contentType: string) {
    const file = this.path(key);
    mkdirSync(dirname(file), { recursive: true });
    writeFileAtomic(file, body);
  }

  async has(key: string) {
    return existsSync(this.path(key));
  }

  async list(prefix: string) {
    const dir = resolve(/*turbopackIgnore: true*/ this.root, checkKey(prefix.replace(/\/$/, "") || "."));

    if (!existsSync(dir)) return [];

    return readdirSync(dir, { recursive: true, withFileTypes: true }).flatMap((e) =>
      e.isFile() && !e.name.includes(".tmp-")
        ? [relative(this.root, resolve(e.parentPath, e.name)).split(sep).join("/")]
        : [],
    );
  }
}

export type R2Config = {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Override for tests or a jurisdiction endpoint (default https://<account>.r2.cloudflarestorage.com). */
  endpoint?: string;
  /** Per-request limit; an upload gets four times as long (default 30 s). */
  timeoutMs?: number;
};

export class R2Store implements ObjectStore {
  readonly label: string;
  private client: AwsClient;
  private base: string;
  private timeoutMs: number;

  constructor(config: R2Config) {
    this.timeoutMs = config.timeoutMs ?? 30_000;
    const endpoint = (config.endpoint || `https://${config.accountId}.r2.cloudflarestorage.com`).replace(/\/$/, "");
    this.base = `${endpoint}/${config.bucket}`;
    this.label = `r2:${config.bucket}`;
    this.client = new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      service: "s3",
      region: "auto",
      retries: 3,
    });
  }

  private url(key: string) {
    return `${this.base}/${checkKey(key).split("/").map(encodeURIComponent).join("/")}`;
  }

  private async fail(res: Response, what: string): Promise<never> {
    const body = await res.text().catch(() => "");
    const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1];

    throw new Error(`R2 ${what}: HTTP ${res.status}${code ? ` ${code}` : ""}`);
  }

  async get(key: string) {
    const res = await this.client.fetch(this.url(key), { signal: AbortSignal.timeout(this.timeoutMs) });

    if (res.status === 404) return null;

    if (!res.ok) return this.fail(res, `GET ${key}`);

    return new Uint8Array(await res.arrayBuffer());
  }

  async put(key: string, body: Uint8Array, contentType: string) {
    const res = await this.client.fetch(this.url(key), {
      method: "PUT",
      body: new Blob([new Uint8Array(body)]),
      headers: { "Content-Type": contentType },
      signal: AbortSignal.timeout(4 * this.timeoutMs),
    });

    if (!res.ok) await this.fail(res, `PUT ${key}`);
  }

  async has(key: string) {
    const res = await this.client.fetch(this.url(key), { method: "HEAD", signal: AbortSignal.timeout(this.timeoutMs) });

    if (res.status === 404) return false;

    if (!res.ok) return this.fail(res, `HEAD ${key}`);

    return true;
  }

  /** ListObjectsV2, 1000 keys per request. */
  async list(prefix: string) {
    const keys: string[] = [];
    let token: string | null = null;

    do {
      const params = new URLSearchParams({ "list-type": "2", prefix });

      if (token) params.set("continuation-token", token);
      const res = await this.client.fetch(`${this.base}?${params}`, { signal: AbortSignal.timeout(this.timeoutMs) });

      if (!res.ok) await this.fail(res, `LIST ${prefix}`);
      const xml = await res.text();

      for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(decodeXml(m[1]));
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? (/<NextContinuationToken>([^<]+)</.exec(xml)?.[1] ?? null) : null;
    } while (token);

    return keys;
  }
}

const decodeXml = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** The R2 settings from the environment, or null when any of them is missing. */
export function r2ConfigFromEnv(env: Record<string, string | undefined> = process.env): R2Config | null {
  const accountId = env.R2_ACCOUNT_ID || "";
  const bucket = env.R2_BUCKET || "";
  const accessKeyId = env.R2_ACCESS_KEY_ID || "";
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY || "";

  if (!accountId || !bucket || !accessKeyId || !secretAccessKey) return null;

  return { accountId, bucket, accessKeyId, secretAccessKey, endpoint: env.R2_ENDPOINT || undefined };
}

/**
 * The read-only R2 settings the app uses at runtime (the game timeline tool):
 * the same account and bucket, with an Object Read only token of its own
 * (R2_READ_*). The read-write R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY of
 * ingestion are never read here, so a deployment cannot hold a write key by
 * accident. Null when any of them is missing.
 */
export function r2ReadConfigFromEnv(env: Record<string, string | undefined> = process.env): R2Config | null {
  return r2ConfigFromEnv({
    R2_ACCOUNT_ID: env.R2_ACCOUNT_ID,
    R2_BUCKET: env.R2_BUCKET,
    R2_ACCESS_KEY_ID: env.R2_READ_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: env.R2_READ_SECRET_ACCESS_KEY,
    R2_ENDPOINT: env.R2_ENDPOINT,
  });
}

/** R2 when it is configured, null otherwise. */
export function remoteStoreFromEnv(): R2Store | null {
  const config = r2ConfigFromEnv();

  return config ? new R2Store(config) : null;
}
