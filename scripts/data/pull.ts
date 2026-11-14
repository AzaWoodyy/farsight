/**
 * data:pull: download the published database from a GitHub release of this
 * repository, check it, and install it as data/lol.sqlite. Runs before
 * `next build` (see the `build` script).
 *
 *   bun run data:pull                      latest release matching the code's schema
 *   bun run data:pull --release=data-20261113
 *   bun run data:pull --force              replace a local file that is already usable
 *
 * Environment:
 *   DATA_GITHUB_TOKEN  read-only token on this repository (required to download)
 *   DATA_RELEASE       pinned release tag (same as --release)
 *   DATA_REPO          owner/name (default: the Vercel Git repository, then AzaWoodyy/lol-esports-agent)
 *   DATA_GITHUB_API    API base URL (default https://api.github.com)
 *
 * Outside Vercel, a local database with the expected schema is kept as is (it
 * may be a fresh `data:build`), so `bun run build` works offline. On Vercel the
 * release is resolved when a token is set, and the download is skipped when
 * the local file already has the release's sha256. Without a token, only a
 * usable local file (a local `vercel build`) lets the build go on.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";
import { z } from "zod";
import { type Json, JsonSchema } from "../../src/lib/json";
import { DB_ASSET, MANIFEST_ASSET, Manifest, SIDE_FILES, TAG_PREFIX, corruption, sha256File, usabilityProblems } from "./artifact";
import { DB_FILE, SCHEMA_VERSION } from "./scope";

const args = process.argv.slice(2);
const force = args.includes("--force");
const pinned = args.find((a) => a.startsWith("--release="))?.slice(10) || process.env.DATA_RELEASE || null;
const onVercel = process.env.VERCEL === "1";
const token = process.env.DATA_GITHUB_TOKEN || "";
const api = (process.env.DATA_GITHUB_API || "https://api.github.com").replace(/\/$/, "");

const vercelRepo =
  process.env.VERCEL_GIT_REPO_OWNER && process.env.VERCEL_GIT_REPO_SLUG
    ? `${process.env.VERCEL_GIT_REPO_OWNER}/${process.env.VERCEL_GIT_REPO_SLUG}`
    : null;

const repo = process.env.DATA_REPO || vercelRepo || "AzaWoodyy/lol-esports-agent";

class PullError extends Error {}

const log = (msg: string) => console.log(`data:pull: ${msg}`);
const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;

// --- GitHub API ---------------------------------------------------------------

const Asset = z.object({ id: z.number(), name: z.string(), size: z.number() });

const Release = z.object({
  tag_name: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  published_at: z.string().nullable(),
  assets: z.array(Asset),
});

type Release = z.infer<typeof Release>;

type Asset = z.infer<typeof Asset>;

const headers = (accept: string) => ({
  Accept: accept,
  Authorization: `Bearer ${token}`,
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "lol-esports-agent-data-pull",
});

/** GitHub error body without anything from the request (no token in logs). */
async function describe(res: Response): Promise<string> {
  const body = await res.text().catch(() => "");
  const message = z.object({ message: z.string() }).safeParse(body ? JSON.parse(body) : {});
  const hint = res.status === 401 ? " (token invalid or expired)" : res.status === 404 ? " (not found, or the token cannot read this repository)" : "";

  return `HTTP ${res.status}${message.success ? ` ${message.data.message}` : ""}${hint}`;
}

async function getJson(path: string): Promise<Json> {
  const res = await fetch(`${api}${path}`, { headers: headers("application/vnd.github+json"), signal: AbortSignal.timeout(30_000) });

  if (!res.ok) throw new PullError(`GET ${path}: ${await describe(res)}`);

  return JsonSchema.parse(await res.json());
}

/**
 * Asset content. GitHub answers 302 to a signed storage URL that must be
 * fetched without the Authorization header, so the redirect is followed by hand.
 */
async function download(asset: Asset, timeoutMs: number): Promise<Response> {
  const path = `/repos/${repo}/releases/assets/${asset.id}`;
  const signal = AbortSignal.timeout(timeoutMs);
  let res = await fetch(`${api}${path}`, { headers: headers("application/octet-stream"), redirect: "manual", signal });

  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("location");

    if (!location) throw new PullError(`GET ${path}: redirect without a location`);
    res = await fetch(location, { signal });
  }

  if (!res.ok) throw new PullError(`download ${asset.name}: ${await describe(res)}`);

  return res;
}

async function readManifest(release: Release): Promise<Manifest> {
  const asset = release.assets.find((a) => a.name === MANIFEST_ASSET);

  if (!asset) throw new PullError(`release ${release.tag_name} has no ${MANIFEST_ASSET}`);
  const parsed = Manifest.safeParse(await (await download(asset, 30_000)).json());

  if (!parsed.success) throw new PullError(`release ${release.tag_name}: invalid ${MANIFEST_ASSET} (${parsed.error.issues[0]?.message})`);

  if (parsed.data.tag !== release.tag_name)
    throw new PullError(`release ${release.tag_name}: its manifest describes ${parsed.data.tag}`);

  return parsed.data;
}

/** The pinned release, or the newest published data release built with the code's schema. */
async function resolveRelease(): Promise<{ release: Release; manifest: Manifest }> {
  if (pinned) {
    const release = Release.parse(await getJson(`/repos/${repo}/releases/tags/${encodeURIComponent(pinned)}`));
    const manifest = await readManifest(release);

    if (manifest.schema_version !== SCHEMA_VERSION)
      throw new PullError(`release ${pinned} is schema v${manifest.schema_version}, the code expects v${SCHEMA_VERSION}`);

    return { release, manifest };
  }

  const seen: string[] = [];

  for (let page = 1; page <= 5; page++) {
    const releases = z.array(Release).parse(await getJson(`/repos/${repo}/releases?per_page=50&page=${page}`));

    const candidates = releases
      .filter((r) => !r.draft && !r.prerelease && r.tag_name.startsWith(TAG_PREFIX))
      // published_at, not created_at: GitHub's created_at is the date of the tagged commit, so
      // two releases cut from the same commit (two weekly runs without a push) would tie.
      .toSorted((a, b) => (b.published_at ?? "").localeCompare(a.published_at ?? ""));

    for (const release of candidates) {
      const manifest = await readManifest(release);

      if (manifest.schema_version === SCHEMA_VERSION) return { release, manifest };
      seen.push(`${release.tag_name} (v${manifest.schema_version})`);
    }

    if (releases.length < 50) break;
  }

  throw new PullError(
    seen.length > 0
      ? `no published release has schema v${SCHEMA_VERSION} (newest: ${seen.slice(0, 3).join(", ")}). Run the "Data release" workflow on code with schema v${SCHEMA_VERSION}, or pin DATA_RELEASE.`
      : `no published ${TAG_PREFIX}* release in ${repo}. Run the "Data release" workflow first.`,
  );
}

// --- Install ------------------------------------------------------------------

/** Pass-through stream that hashes what goes through it. */
function hashing(hash: ReturnType<typeof createHash>) {
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk);
      done(null, chunk);
    },
  });
}

async function install(release: Release, manifest: Manifest) {
  const asset = release.assets.find((a) => a.name === DB_ASSET);

  if (!asset) throw new PullError(`release ${release.tag_name} has no ${DB_ASSET}`);

  if (asset.size !== manifest.asset.size)
    throw new PullError(`${DB_ASSET} is ${asset.size} bytes, the manifest says ${manifest.asset.size}`);

  const dir = dirname(DB_FILE);
  mkdirSync(dir, { recursive: true });
  const tmpAsset = resolve(dir, `.${DB_ASSET}.${process.pid}.part`);
  const tmpDb = resolve(dir, `.${basename(DB_FILE)}.${process.pid}.part`);

  try {
    log(`downloading ${release.tag_name}/${DB_ASSET} (${mb(asset.size)})`);
    // About 20 MB compressed: buffered in memory, hashed, then written.
    const compressed = Buffer.from(await (await download(asset, 10 * 60_000)).arrayBuffer());
    const assetSha = createHash("sha256").update(compressed).digest("hex");

    writeFileSync(tmpAsset, compressed);

    if (assetSha !== manifest.asset.sha256)
      throw new PullError(`${DB_ASSET} sha256 is ${assetSha}, the manifest says ${manifest.asset.sha256}`);

    const dbHash = createHash("sha256");
    await pipeline(createReadStream(tmpAsset), createZstdDecompress(), hashing(dbHash), createWriteStream(tmpDb));
    const dbSha = dbHash.digest("hex");

    if (dbSha !== manifest.database.sha256)
      throw new PullError(`decompressed database sha256 is ${dbSha}, the manifest says ${manifest.database.sha256}`);

    if (statSync(tmpDb).size !== manifest.database.size)
      throw new PullError(`decompressed database is ${statSync(tmpDb).size} bytes, the manifest says ${manifest.database.size}`);

    const problems = usabilityProblems(tmpDb, SCHEMA_VERSION);

    if (problems.length > 0) throw new PullError(`downloaded database: ${problems.join("; ")}`);
    const broken = corruption(tmpDb, false);

    if (broken) throw new PullError(`downloaded database fails quick_check: ${broken}`);

    for (const suffix of SIDE_FILES) rmSync(DB_FILE + suffix, { force: true });
    renameSync(tmpDb, DB_FILE);
  } finally {
    rmSync(tmpAsset, { force: true });
    rmSync(tmpDb, { force: true });

    for (const suffix of SIDE_FILES) rmSync(tmpDb + suffix, { force: true });
  }

  log(`installed ${DB_FILE} from ${release.tag_name}: schema v${manifest.schema_version}, ${manifest.counts.games} games, ${manifest.counts.leagues} leagues, ${mb(manifest.database.size)}`);
}

async function main() {
  const localProblems = existsSync(DB_FILE) ? usabilityProblems(DB_FILE, SCHEMA_VERSION) : null;
  const localUsable = localProblems?.length === 0;

  if (localProblems && !localUsable) log(`local ${basename(DB_FILE)} not usable: ${localProblems.join("; ")}`);

  if (localUsable && !onVercel && !pinned && !force) {
    log(`keeping local ${DB_FILE} (schema v${SCHEMA_VERSION}); --force replaces it with the latest release`);

    return;
  }

  // A local `vercel build` sets VERCEL=1 too; a cloud build never has a local file.
  if (localUsable && !token && !pinned && !force) {
    log(`DATA_GITHUB_TOKEN is not set: keeping local ${DB_FILE} (schema v${SCHEMA_VERSION}) without comparing it to the latest release`);

    return;
  }

  if (!token)
    throw new PullError(
      onVercel
        ? "DATA_GITHUB_TOKEN is not set on this Vercel project (see docs/deploy.md)"
        : `no usable local database and DATA_GITHUB_TOKEN is not set: run \`bun run data:build\`, or set the token to download a release`,
    );

  const { release, manifest } = await resolveRelease();
  log(`${pinned ? "pinned" : "latest"} release ${release.tag_name}: schema v${manifest.schema_version}, built ${manifest.created_at}`);

  if (localUsable && !force && (await sha256File(DB_FILE)) === manifest.database.sha256) {
    log(`local ${basename(DB_FILE)} already matches ${release.tag_name}, nothing to download`);

    return;
  }

  await install(release, manifest);
}

try {
  await main();
} catch (err) {
  console.error(`data:pull: ${err instanceof PullError ? err.message : err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
}
