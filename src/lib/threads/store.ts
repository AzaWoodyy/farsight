import { attachDatabasePool } from "@vercel/functions";
import { z } from "zod";
import { StoredMessages, type ThreadSummary } from "../agent/chat-parts";
import { createPool, type PgPool } from "../db/postgres";

export const KEPT_THREADS = 30;
export const THREAD_MAX_BYTES = 600_000;
export const DAILY_MESSAGES = 100;
const USAGE_KEPT_DAYS = 7;
const CLEANUP_SHARE = 0.02;
const TITLE_MAX_LENGTH = 60;

export const ThreadMessages = StoredMessages;

export type ThreadMessages = StoredMessages;

const SummaryRow = z.object({ id: z.string(), title: z.string(), updated_at: z.coerce.date() });

const Row = SummaryRow.extend({ messages: ThreadMessages });

export type Thread = ThreadSummary & { messages: ThreadMessages };

let pool: PgPool | null = null;

export const threadsConfigured = (): boolean => Boolean(process.env.THREADS_DATABASE_URL?.trim());

function threads(): PgPool {
  if (pool) return pool;

  const url = process.env.THREADS_DATABASE_URL;

  if (!url) throw new Error("THREADS_DATABASE_URL is not set (see db/threads.sql).");

  pool = createPool(url, { max: 3 });

  if (process.env.VERCEL === "1") attachDatabasePool(pool);

  return pool;
}

function titleOf(messages: ThreadMessages): string {
  const first = messages.find((m) => m.role === "user");
  const text = (first?.parts ?? []).flatMap((p) => (p.type === "text" ? [p.text] : [])).join(" ").replace(/\s+/g, " ").trim();

  return text.length > TITLE_MAX_LENGTH ? `${text.slice(0, TITLE_MAX_LENGTH - 1).trimEnd()}…` : text;
}

export async function listThreads(userId: string): Promise<ThreadSummary[]> {
  const { rows } = await threads().query("SELECT id, title, updated_at FROM farsight_users.threads WHERE user_id = $1 ORDER BY updated_at DESC LIMIT $2", [userId, KEPT_THREADS]);

  return rows.flatMap((row) => {
    const thread = SummaryRow.safeParse(row);

    return thread.success ? [{ id: thread.data.id, title: thread.data.title, updatedAt: thread.data.updated_at.getTime() }] : [];
  });
}

export async function readThread(userId: string, id: string): Promise<Thread | null> {
  const { rows } = await threads().query("SELECT id, title, messages, updated_at FROM farsight_users.threads WHERE user_id = $1 AND id = $2", [userId, id]);
  const thread = Row.safeParse(rows[0]);

  return thread.success ? { id: thread.data.id, title: thread.data.title, updatedAt: thread.data.updated_at.getTime(), messages: thread.data.messages } : null;
}

export async function saveThread(userId: string, id: string, messages: ThreadMessages): Promise<"saved" | "too_large" | "not_yours"> {
  const body = JSON.stringify(messages);

  if (Buffer.byteLength(body) > THREAD_MAX_BYTES) return "too_large";

  const { rows } = await threads().query(
    `INSERT INTO farsight_users.threads (id, user_id, title, messages, updated_at) VALUES ($1, $2, $3, $4::jsonb, now())
     ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, messages = EXCLUDED.messages, updated_at = now()
     WHERE farsight_users.threads.user_id = EXCLUDED.user_id
     RETURNING id`,
    [id, userId, titleOf(messages), body],
  );

  if (rows.length === 0) return "not_yours";

  await threads().query(
    `DELETE FROM farsight_users.threads WHERE user_id = $1 AND id NOT IN (
       SELECT id FROM farsight_users.threads WHERE user_id = $1 ORDER BY updated_at DESC LIMIT $2)`,
    [userId, KEPT_THREADS],
  );

  return "saved";
}

export async function deleteThread(userId: string, id: string): Promise<void> {
  await threads().query("DELETE FROM farsight_users.threads WHERE user_id = $1 AND id = $2", [userId, id]);
}

export async function forgetUser(userId: string): Promise<void> {
  await threads().query("DELETE FROM farsight_users.threads WHERE user_id = $1", [userId]);
  await threads().query("DELETE FROM farsight_users.usage WHERE user_id = $1", [userId]);
}

export async function spendMessage(userId: string, limit: number = DAILY_MESSAGES): Promise<boolean> {
  const { rows } = await threads().query(
    `INSERT INTO farsight_users.usage (user_id, day, messages) VALUES ($1, (now() AT TIME ZONE 'UTC')::date, 1)
     ON CONFLICT (user_id, day) DO UPDATE SET messages = farsight_users.usage.messages + 1
     WHERE farsight_users.usage.messages < $2
     RETURNING messages`,
    [userId, limit],
  );

  if (Math.random() < CLEANUP_SHARE) await threads().query("DELETE FROM farsight_users.usage WHERE day < (now() AT TIME ZONE 'UTC')::date - $1::integer", [USAGE_KEPT_DAYS]);

  return rows.length > 0;
}
