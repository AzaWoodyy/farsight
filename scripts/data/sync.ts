import { RAW_GAME_CONTENT_TYPE } from "../../src/lib/sources/riot";
import { remoteStoreFromEnv } from "../../src/lib/storage";
import { localRiotStore } from "./riot";

const dryRun = process.argv.includes("--dry-run");
const remote = remoteStoreFromEnv();

if (!remote) {
  console.error("data:sync: R2 is not configured (R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY).");
  process.exit(1);
}

const local = localRiotStore();
const t0 = Date.now();
const [mine, theirs] = await Promise.all([local.list("games"), remote.list("games/")]);
const present = new Set(theirs);
const todo = mine.filter((k) => !present.has(k));

console.log(`data:sync: ${mine.length} local objects, ${theirs.length} in ${remote.label}, ${todo.length} to upload`);

if (dryRun) process.exit(0);

const CONCURRENCY = 8;
let done = 0;
let failed = 0;

async function worker(queue: string[]) {
  for (let key = queue.pop(); key; key = queue.pop()) {
    const body = await local.get(key);

    try {
      if (body) await remote!.put(key, body, RAW_GAME_CONTENT_TYPE);
      done++;
    } catch (err) {
      failed++;
      console.warn(`  ${key}: ${err instanceof Error ? err.message : String(err)}`);
    }

    if ((done + failed) % 500 === 0) console.log(`  ${done + failed}/${todo.length}`);
  }
}

const queue = [...todo];

await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)));

console.log(`data:sync: ${done} uploaded, ${failed} failed in ${((Date.now() - t0) / 60000).toFixed(1)} min`);

if (failed) process.exit(1);
