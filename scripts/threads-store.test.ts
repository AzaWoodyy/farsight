import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { deleteThread, forgetUser, KEPT_THREADS, listThreads, saveThread, spendMessage, THREAD_MAX_BYTES, type ThreadMessages } from "../src/lib/threads/store";
import { testDatabaseUrl } from "./fixtures/test-db";

const SCHEMA_STATEMENT = /^CREATE (?:SCHEMA|TABLE|INDEX) /;

const schemaStatements = () =>
  readFileSync("db/threads.sql", "utf8")
    .replace(/^--.*$/gm, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => SCHEMA_STATEMENT.test(statement));

const before = process.env.THREADS_DATABASE_URL;
const accounts: string[] = [];
let admin: pg.Pool;

const account = () => {
  const userId = `test_${randomUUID()}`;

  accounts.push(userId);

  return userId;
};

const message = (role: "user" | "assistant", ...texts: string[]): ThreadMessages[number] => ({ id: randomUUID(), role, parts: texts.map((text) => ({ type: "text", text })) });

const asked = (text: string): ThreadMessages => [message("user", text), message("assistant", "Réponse.")];

const counted = async (userId: string) => (await admin.query("SELECT messages FROM farsight_users.usage WHERE user_id = $1", [userId])).rows.map((r) => r.messages);

beforeAll(async () => {
  const url = testDatabaseUrl();

  process.env.THREADS_DATABASE_URL = url;
  admin = new pg.Pool({ connectionString: url, max: 1 });

  await admin.query("SELECT pg_advisory_lock(hashtext('farsight_users'))");

  try {
    for (const statement of schemaStatements()) await admin.query(statement);
  } finally {
    await admin.query("SELECT pg_advisory_unlock(hashtext('farsight_users'))");
  }
});

afterEach(async () => {
  const mine = accounts.splice(0);

  await admin.query("DELETE FROM farsight_users.threads WHERE user_id = ANY($1)", [mine]);
  await admin.query("DELETE FROM farsight_users.usage WHERE user_id = ANY($1)", [mine]);
});

afterAll(async () => {
  await admin.end();

  if (before === undefined) delete process.env.THREADS_DATABASE_URL;
  else process.env.THREADS_DATABASE_URL = before;
});

test("the schema of the test is the one db/threads.sql creates", () => {
  expect(schemaStatements().map((statement) => statement.split("(")[0].trim())).toEqual([
    "CREATE SCHEMA IF NOT EXISTS farsight_users",
    "CREATE TABLE IF NOT EXISTS farsight_users.threads",
    "CREATE INDEX IF NOT EXISTS threads_by_user ON farsight_users.threads",
    "CREATE TABLE IF NOT EXISTS farsight_users.usage",
  ]);
});

describe("threads of an account", () => {
  test("a saved thread is read back with its messages, most recent first", async () => {
    const userId = account();
    const [first, second] = [randomUUID(), randomUUID()];
    const messages = asked("Chovy aux Worlds");

    expect(await saveThread(userId, first, messages)).toBe("saved");
    expect(await saveThread(userId, second, asked("Roster de T1"))).toBe("saved");

    const threads = await listThreads(userId);

    expect(threads.map((t) => [t.id, t.title])).toEqual([
      [second, "Roster de T1"],
      [first, "Chovy aux Worlds"],
    ]);
    expect(threads[1].messages).toEqual(messages);
    expect(threads[0].updatedAt).toBeGreaterThan(threads[1].updatedAt);
  });

  test("saving a thread again replaces it and brings it back first", async () => {
    const userId = account();
    const [first, second] = [randomUUID(), randomUUID()];

    await saveThread(userId, first, asked("Première question"));
    await saveThread(userId, second, asked("Autre fil"));

    const longer = [...asked("Première question"), message("user", "Et en 2024 ?")];

    expect(await saveThread(userId, first, longer)).toBe("saved");

    const threads = await listThreads(userId);

    expect(threads.map((t) => t.id)).toEqual([first, second]);
    expect(threads[0].messages).toEqual(longer);
  });

  test.each([
    ["the first message of the visitor, on one line", [message("assistant", "Bonjour"), message("user", "  Chovy   aux\nWorlds ", "et après"), message("user", "autre")], "Chovy aux Worlds et après"],
    ["cut at sixty characters", [message("user", `${"mot ".repeat(14)}fin de la question`)], `${"mot ".repeat(14)}fin…`],
    ["empty without a visitor message", [message("assistant", "Bonjour")], ""],
  ])("the title is %s", async (_, messages, title) => {
    const userId = account();

    await saveThread(userId, randomUUID(), messages);

    expect((await listThreads(userId)).map((t) => t.title)).toEqual([title]);
    expect(title.length).toBeLessThanOrEqual(60);
  });

  test("another account does not read, overwrite or delete a thread", async () => {
    const [owner, other] = [account(), account()];
    const id = randomUUID();
    const messages = asked("Question du propriétaire");

    await saveThread(owner, id, messages);

    expect(await listThreads(other)).toEqual([]);
    expect(await saveThread(other, id, asked("Écrasé"))).toBe("not_yours");

    await deleteThread(other, id);

    expect(await listThreads(other)).toEqual([]);
    expect((await listThreads(owner)).map((t) => [t.id, t.title, t.messages])).toEqual([[id, "Question du propriétaire", messages]]);
  });

  test("its owner deletes a thread, and only that one", async () => {
    const userId = account();
    const [kept, deleted] = [randomUUID(), randomUUID()];

    await saveThread(userId, kept, asked("Gardé"));
    await saveThread(userId, deleted, asked("Supprimé"));
    await deleteThread(userId, deleted);

    expect((await listThreads(userId)).map((t) => t.id)).toEqual([kept]);
  });

  test("an account keeps its most recent threads, and another account's are not counted", async () => {
    const [userId, other] = [account(), account()];
    const ids = Array.from({ length: KEPT_THREADS + 1 }, () => randomUUID());
    const others = randomUUID();

    await saveThread(other, others, asked("Fil d'un autre compte"));

    for (const [i, id] of ids.entries()) expect(await saveThread(userId, id, asked(`Question ${i}`))).toBe("saved");

    expect((await listThreads(userId)).map((t) => t.id)).toEqual(ids.slice(1).toReversed());
    expect((await admin.query("SELECT count(*)::integer AS n FROM farsight_users.threads WHERE user_id = $1", [userId])).rows).toEqual([{ n: KEPT_THREADS }]);
    expect((await listThreads(other)).map((t) => t.id)).toEqual([others]);
  });

  test("a thread over the size limit is refused, in bytes and not in characters", async () => {
    const userId = account();
    const id = randomUUID();

    expect(await saveThread(userId, id, asked("x".repeat(THREAD_MAX_BYTES)))).toBe("too_large");
    expect(await saveThread(userId, id, asked("é".repeat(THREAD_MAX_BYTES / 2)))).toBe("too_large");
    expect(await listThreads(userId)).toEqual([]);
    expect(await saveThread(userId, id, asked("x".repeat(THREAD_MAX_BYTES / 2)))).toBe("saved");
  });

  test("a thread that grew over the limit keeps its last saved state", async () => {
    const userId = account();
    const id = randomUUID();
    const messages = asked("Avant");

    await saveThread(userId, id, messages);

    expect(await saveThread(userId, id, asked("x".repeat(THREAD_MAX_BYTES)))).toBe("too_large");
    expect((await listThreads(userId)).map((t) => t.messages)).toEqual([messages]);
  });
});

describe("daily messages of an account", () => {
  test("a message is spent until the limit, and the counter stops there", async () => {
    const userId = account();
    const spent: boolean[] = [];

    for (let i = 0; i < 4; i++) spent.push(await spendMessage(userId, 2));

    expect(spent).toEqual([true, true, false, false]);
    expect(await counted(userId)).toEqual([2]);
  });

  test("each account has its own counter", async () => {
    const [first, second] = [account(), account()];

    expect(await spendMessage(first, 1)).toBe(true);
    expect(await spendMessage(first, 1)).toBe(false);
    expect(await spendMessage(second, 1)).toBe(true);
    expect(await counted(second)).toEqual([1]);
  });

  test("messages spent at the same time never go over the limit", async () => {
    const userId = account();
    const spent = await Promise.all(Array.from({ length: 8 }, () => spendMessage(userId, 3)));

    expect(spent.filter(Boolean)).toHaveLength(3);
    expect(await counted(userId)).toEqual([3]);
  });
});

describe("forgetUser", () => {
  test("the threads and the counter of the account are deleted, another account keeps its own", async () => {
    const [gone, kept] = [account(), account()];
    const id = randomUUID();

    await saveThread(gone, randomUUID(), asked("À oublier"));
    await saveThread(gone, randomUUID(), asked("À oublier aussi"));
    await spendMessage(gone);
    await saveThread(kept, id, asked("À garder"));
    await spendMessage(kept);

    await forgetUser(gone);

    expect(await listThreads(gone)).toEqual([]);
    expect(await counted(gone)).toEqual([]);
    expect((await listThreads(kept)).map((t) => t.id)).toEqual([id]);
    expect(await counted(kept)).toEqual([1]);
    expect(await spendMessage(gone, 1)).toBe(true);
  });

  test("forgetting an account that has nothing changes nothing", async () => {
    await forgetUser(account());
  });
});
