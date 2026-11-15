/**
 * data:pull as a black box: the script runs in a child process against a
 * local fake of the GitHub releases API, and installs into a temp directory.
 */
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";
import { SCHEMA_VERSION, createQuerySchema, createSchema } from "../../src/lib/db/schema";
import { DB_ASSET, MANIFEST_ASSET, Manifest, usabilityProblems } from "./artifact";

const root = mkdtempSync(join(tmpdir(), "farsight-pull-"));

afterAll(() => rmSync(root, { recursive: true, force: true }));

let ids = 0;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

type FakeRelease = {
  json: { tag_name: string; draft: boolean; prerelease: boolean; published_at: string | null; assets: { id: number; name: string; size: number }[] };
  assets: Map<number, Uint8Array>;
};

/** A published data release: an empty database with the given `user_version`, compressed, and its manifest. */
function release(
  tag: string,
  opts: { schema?: number; fileSchema?: number; publishedAt?: string | null; corrupt?: boolean; manifestTag?: string; draft?: boolean; prerelease?: boolean } = {},
): FakeRelease {
  const path = join(mkdtempSync(join(root, "build-")), "lol.sqlite");
  const db = new DatabaseSync(path);

  try {
    createSchema(db);
    createQuerySchema(db);
    db.exec(`PRAGMA user_version=${opts.fileSchema ?? opts.schema ?? SCHEMA_VERSION}; PRAGMA journal_mode=DELETE;`);
  } finally {
    db.close();
  }

  const raw = readFileSync(path);
  const compressed = new Uint8Array(zstdCompressSync(raw));

  const manifest = Manifest.parse({
    format: 1,
    tag: opts.manifestTag ?? tag,
    schema_version: opts.schema ?? SCHEMA_VERSION,
    created_at: "2026-11-15T00:00:00Z",
    commit: "test",
    database: { file: "lol.sqlite", size: raw.length, sha256: sha256(raw) },
    asset: { file: DB_ASSET, compression: "zstd", size: compressed.length, sha256: sha256(compressed) },
    counts: { games: 0, leagues: 0, tournaments: 0, players: 0, teams: 0, ingame_games: 0 },
    ddragon_version: null,
  });

  // Altered after the manifest was computed: same size, different bytes.
  if (opts.corrupt) compressed[compressed.length - 1] ^= 0xff;

  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const files: [string, Uint8Array][] = [[MANIFEST_ASSET, manifestBytes], [DB_ASSET, compressed]];
  const assets = new Map<number, Uint8Array>();

  const list = files.map(([name, bytes]) => {
    const id = ++ids;
    assets.set(id, bytes);

    return { id, name, size: bytes.length };
  });

  return {
    json: { tag_name: tag, draft: opts.draft ?? false, prerelease: opts.prerelease ?? false, published_at: opts.publishedAt === undefined ? "2026-11-15T00:00:00Z" : opts.publishedAt, assets: list },
    assets,
  };
}

/** The GitHub releases API of repository o/r, in this process on an ephemeral port. */
function fakeGitHub(releases: FakeRelease[]) {
  const requests: string[] = [];

  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      requests.push(`${url.pathname}${url.search}`);

      if (url.pathname === "/repos/o/r/releases") {
        const page = Number(url.searchParams.get("page") ?? 1);
        const perPage = Number(url.searchParams.get("per_page") ?? 30);

        return Response.json(releases.slice((page - 1) * perPage, page * perPage).map((r) => r.json));
      }

      const tag = url.pathname.match(/^\/repos\/o\/r\/releases\/tags\/(.+)$/)?.[1];

      if (tag) {
        const found = releases.find((r) => r.json.tag_name === decodeURIComponent(tag));

        return found ? Response.json(found.json) : Response.json({ message: "Not Found" }, { status: 404 });
      }

      const id = url.pathname.match(/^\/repos\/o\/r\/releases\/assets\/(\d+)$/)?.[1];
      const bytes = id ? releases.map((r) => r.assets.get(Number(id))).find(Boolean) : undefined;

      return bytes ? new Response(new Uint8Array(bytes)) : Response.json({ message: "Not Found" }, { status: 404 });
    },
  });

  return { url: `http://localhost:${server.port}`, requests, stop: () => server.stop(true) };
}

/**
 * Runs `data:pull` against the fake. Asynchronous on purpose: a synchronous
 * spawn would block the event loop that serves the fake API.
 */
async function pull(releases: FakeRelease[], env: Record<string, string> = {}) {
  const github = fakeGitHub(releases);
  const dir = mkdtempSync(join(root, "install-"));
  const dest = join(dir, "lol.sqlite");

  try {
    const child = Bun.spawn(["bun", "--no-env-file", "scripts/data/pull.ts"], {
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DATABASE_PATH: dest, DATA_GITHUB_API: github.url, DATA_REPO: "o/r", ...env },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 20_000,
    });

    const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);

    return { status, stdout, stderr, dest, installed: existsSync(dest), leftovers: readdirSync(dir).filter((f) => f !== "lol.sqlite"), requests: github.requests };
  } finally {
    github.stop();
  }
}

const otherSchema = SCHEMA_VERSION + 1;

test("installs the latest release, a usable database", async () => {
  const r = await pull([release("data-20261115")]);

  expect(r.status).toBe(0);
  expect(r.stdout).toContain("latest release data-20261115");
  expect(r.installed).toBe(true);
  expect(usabilityProblems(r.dest, SCHEMA_VERSION)).toEqual([]);
  expect(r.leftovers).toEqual([]);
  expect(r.requests.every((p) => p.startsWith("/repos/o/r/"))).toBe(true);
});

test("skips a newer release built with another schema", async () => {
  const r = await pull([
    release("data-20261115", { schema: otherSchema, publishedAt: "2026-11-15T00:00:00Z" }),
    release("data-20261108", { publishedAt: "2026-11-08T00:00:00Z" }),
  ]);

  expect(r.status).toBe(0);
  expect(r.stdout).toContain("latest release data-20261108");
  expect(r.installed).toBe(true);
});

test("the latest published_at wins, whatever the listing order", async () => {
  const r = await pull([
    release("data-20261108", { publishedAt: "2026-11-08T00:00:00Z" }),
    release("data-20261115", { publishedAt: "2026-11-15T00:00:00Z" }),
  ]);

  expect(r.status).toBe(0);
  expect(r.stdout).toContain("latest release data-20261115");
});

test("ignores drafts, prereleases and tags outside data-*", async () => {
  const r = await pull([
    // Newer than the valid release, so the filter, not the sort, has to set them aside.
    release("data-20261122", { draft: true, publishedAt: "2026-11-22T00:00:00Z" }),
    release("data-20261121", { prerelease: true, publishedAt: "2026-11-21T00:00:00Z" }),
    release("v1.0.0", { manifestTag: "data-20261120", publishedAt: "2026-11-20T00:00:00Z" }),
    release("data-20261108", { publishedAt: "2026-11-08T00:00:00Z" }),
  ]);

  expect(r.status).toBe(0);
  expect(r.stdout).toContain("latest release data-20261108");
  expect(r.installed).toBe(true);
});

test("refuses an asset whose bytes do not match the manifest, and installs nothing", async () => {
  const r = await pull([release("data-20261115", { corrupt: true })]);

  expect(r.status).toBe(1);
  expect(r.stderr).toContain("data:pull:");
  expect(r.stderr).toContain("sha256");
  expect(r.installed).toBe(false);
  expect(r.leftovers).toEqual([]);
});

test("refuses a manifest that describes another release", async () => {
  const r = await pull([release("data-20261115", { manifestTag: "data-20261108" })]);

  expect(r.status).toBe(1);
  expect(r.stderr).toContain("its manifest describes data-20261108");
  expect(r.installed).toBe(false);
  expect(r.leftovers).toEqual([]);
});

test("refuses a file whose schema differs from what its manifest claims", async () => {
  const r = await pull([release("data-20261115", { fileSchema: otherSchema })]);

  expect(r.status).toBe(1);
  expect(r.stderr).toContain(`schema v${otherSchema}, the code expects v${SCHEMA_VERSION}`);
  expect(r.installed).toBe(false);
  expect(r.leftovers).toEqual([]);
});

test("fails when no data release is published", async () => {
  const r = await pull([]);

  expect(r.status).toBe(1);
  expect(r.stderr).toContain("no published data-* release in o/r");
  expect(r.installed).toBe(false);
  expect(r.leftovers).toEqual([]);
});

test("refuses a pinned release built with another schema", async () => {
  const r = await pull([release("data-20261115", { schema: otherSchema }), release("data-20261108")], { DATA_RELEASE: "data-20261115" });

  expect(r.status).toBe(1);
  expect(r.stderr).toContain(`release data-20261115 is schema v${otherSchema}`);
  expect(r.installed).toBe(false);
  expect(r.leftovers).toEqual([]);
});
