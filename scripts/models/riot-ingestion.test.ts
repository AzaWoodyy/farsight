import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { z } from "zod";
import type { WikiPage } from "../../src/lib/sources/leaguepedia";
import { rawGameKey } from "../../src/lib/sources/riot";
import type { ObjectStore } from "../../src/lib/storage";
import { DERIVE_VERSION } from "../data/ingame";
import { SUMMARIES_KEY, fetchRiotGames, loadIngame, pullSummaries, pushSummaries } from "../data/riot";
import { riotGame, riotRow } from "../fixtures/riot-games";
import { type Schedule, explore } from "./explore";

const KEYS = ["G_1", "G_2", "G_3"];
const ROWS = KEYS.map(riotRow);
const BUDGET_MINUTES = 60;

class MemoryStore implements ObjectStore {
  constructor(
    readonly label: string,
    readonly objects = new Map<string, Uint8Array>(),
  ) {}

  async get(key: string) {
    return this.objects.get(key) ?? null;
  }

  async put(key: string, body: Uint8Array) {
    this.objects.set(key, body);
  }

  async has(key: string) {
    return this.objects.has(key);
  }

  async list(prefix: string) {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix));
  }
}

class Violation extends Error {}

class InjectedFault extends Error {
  constructor(
    message: string,
    readonly stopsTheRun: boolean,
  ) {
    super(message);
  }
}

function holds(condition: boolean, invariant: string) {
  if (!condition) throw new Violation(invariant);
}

type Run = { faults: Set<"grouped omission" | "other">; uploads: Map<string, number>; lateRequests: number };

class FaultyR2 extends MemoryStore {
  constructor(
    objects: Map<string, Uint8Array>,
    readonly schedule: Schedule,
    readonly run: Run,
  ) {
    super("R2", objects);
  }

  override async get(key: string) {
    if (this.schedule.fault(`R2 read ${key}`, "answers", ["fails"]) === "fails") {
      this.run.faults.add("other");
      throw new InjectedFault("R2 read failed", key === SUMMARIES_KEY);
    }

    return super.get(key);
  }

  override async put(key: string, body: Uint8Array) {
    if (this.schedule.fault(`R2 write ${key}`, "succeeds", ["fails"]) === "fails") {
      this.run.faults.add("other");
      throw new InjectedFault("R2 write failed", false);
    }

    this.run.uploads.set(key, (this.run.uploads.get(key) ?? 0) + 1);
    await super.put(key, body);
  }

  override async list(prefix: string) {
    if (this.schedule.fault(`R2 list ${prefix}`, "answers", ["fails"]) === "fails") {
      this.run.faults.add("other");
      throw new InjectedFault("R2 list failed", true);
    }

    return super.list(prefix);
  }
}

function wiki(schedule: Schedule, run: Run, clock: { now: number }) {
  return async (titles: string[]): Promise<Map<string, WikiPage>> => {
    if (clock.now > BUDGET_MINUTES * 60_000) run.lateRequests++;
    const asked = ROWS.filter((r) => titles.includes(r.StatsPage));
    const request = `wiki asked ${asked.map((r) => r.Key).join("+")}`;

    if (schedule.fault(request, "answers", ["is down"]) === "is down") {
      run.faults.add("other");
      throw new InjectedFault("wiki down", false);
    }

    if (schedule.fault(`${request}, answer`, "in time", ["past the time budget"]) !== "in time") {
      run.faults.add("other");
      clock.now += 2 * BUDGET_MINUTES * 60_000;
    }

    const pages = new Map<string, WikiPage>();

    for (const row of asked) {
      if (schedule.fault(`${request}, ${row.Key}`, "served", ["left out"]) !== "served") {
        run.faults.add(asked.length > 1 ? "grouped omission" : "other");
        continue;
      }

      const game = riotGame(row.Key);
      pages.set(row.StatsPage, { title: row.StatsPage, revid: 1, timestamp: game.fetchedAt, content: JSON.stringify(game.stats) });
      pages.set(row.TimelinePage!, { title: row.TimelinePage!, revid: 2, timestamp: game.fetchedAt, content: JSON.stringify(game.timeline) });
    }

    return pages;
  };
}

const SummaryHead = z.object({ key: z.string(), status: z.string(), derive: z.number().optional() });

function currentOnR2(r2: Map<string, Uint8Array>): Set<string> {
  const body = r2.get(SUMMARIES_KEY);

  if (!body) return new Set();
  const lines = zstdDecompressSync(body).toString("utf8").split("\n").filter(Boolean);

  return new Set(
    lines
      .map((l) => SummaryHead.parse(JSON.parse(l)))
      .filter((l) => l.status === "ok" && l.derive === DERIVE_VERSION)
      .map((l) => l.key),
  );
}

type Machine = { local: MemoryStore; file: string };

let dir = "";
let files = 0;

const ephemeral = (): Machine => ({ local: new MemoryStore("local"), file: join(dir, `ci-${++files}.jsonl`) });

async function dailyRun(machine: Machine, r2: Map<string, Uint8Array>, schedule: Schedule) {
  const run: Run = { faults: new Set(), uploads: new Map(), lateRequests: 0 };
  const remote = new FaultyR2(r2, schedule, run);
  const clock = { now: 0 };
  let pulled;
  let counts;

  try {
    pulled = await pullSummaries(remote, machine.file);
    counts = await fetchRiotGames(ROWS, {
      budgetMinutes: BUDGET_MINUTES,
      remote,
      rederive: false,
      local: machine.local,
      ingameFile: machine.file,
      fetchPages: wiki(schedule, run, clock),
      now: () => clock.now,
      sleep: async () => {},
    });
  } catch (error) {
    if (!(error instanceof InjectedFault && error.stopsTheRun)) throw error;
  }

  holds(run.lateRequests === 0, "no wiki request starts after the time budget");

  if (!counts) return;

  const verdicts = loadIngame(machine.file);
  holds(counts.left === ROWS.filter((r) => !verdicts.has(r.Key)).length, "every game of the run ends with a verdict, or is counted as left for the next run");
  holds([...run.uploads.values()].every((n) => n === 1), "a game is uploaded at most once per run");

  if (![...run.faults].some((f) => f === "other")) holds(counts.left === 0, "a game the wiki serves when asked alone is downloaded in the same run");

  await pushSummaries(remote, pulled, machine.file);

  for (const key of currentOnR2(r2)) holds(r2.has(rawGameKey(key)), "no current summary on R2 without the game's JSON on R2");
}

async function healthyRun(r2: Map<string, Uint8Array>) {
  await dailyRun(ephemeral(), r2, { pick: (_, options) => options[0], fault: (_, healthy) => healthy });
  const current = currentOnR2(r2);
  holds(KEYS.every((k) => current.has(k) && r2.has(rawGameKey(k))), "once the faults stop, one run brings every game and its summary to R2");
}

const silenced = [spyOn(console, "log"), spyOn(console, "warn")];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "riot-model-"));

  for (const spy of silenced) spy.mockImplementation(() => {});
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });

  for (const spy of silenced) spy.mockRestore();
});

test("the daily runs on CI keep every ingestion invariant under any two faults", async () => {
  const result = await explore(2, 20_000, async (schedule) => {
    const r2 = new Map<string, Uint8Array>();

    for (let day = 0; day < 2; day++) await dailyRun(ephemeral(), r2, schedule);
    await healthyRun(r2);
  });

  expect(result.counterexample).toBeNull();
  expect(result.schedules).toBeGreaterThan(100);
}, 120_000);

test("runs on a machine that keeps its cache, between CI runs, keep them too", async () => {
  const result = await explore(2, 20_000, async (schedule) => {
    const r2 = new Map<string, Uint8Array>();
    const laptop: Machine = { local: new MemoryStore("laptop"), file: join(dir, `laptop-${++files}.jsonl`) };

    for (let day = 0; day < 3; day++) await dailyRun(schedule.pick(`day ${day + 1} runs on`, ["ci", "laptop"]) === "ci" ? ephemeral() : laptop, r2, schedule);
    await healthyRun(r2);
  });

  expect(result.counterexample).toBeNull();
}, 120_000);
