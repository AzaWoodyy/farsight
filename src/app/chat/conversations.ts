import { z } from "zod";
import { StoredMessages, ThreadSummary } from "@/lib/agent/chat-parts";
import type { ChatUIMessage } from "@/lib/agent/chat-types";
import { dataMode, stressConversations } from "./worst-case";

export type Conversation = { id: string; title: string; updatedAt: number; messages: ChatUIMessage[] | null; unopened?: true };

const TITLE_MAX_LENGTH = 60;

export const UNDO_MS = 7000;

const Listed = z.object({ threads: z.array(ThreadSummary) });

const Opened = z.object({ thread: z.object({ messages: StoredMessages }) });

export type Library = { list: Conversation[]; state: "loading" | "ready" | "unsaved" | "failed" };

const LOADING: Library = { list: [], state: "loading" };

let library: Library = LOADING;
let owner: string | null = null;
const listeners = new Set<() => void>();
const writes = new Map<string, Promise<void>>();
const opening = new Set<string>();
const leaving = new Map<string, number>();

function show(next: Library) {
  library = next;

  for (const listener of listeners) listener();
}

const failed = () => show({ ...library, state: library.state === "unsaved" ? "unsaved" : "failed" });

function titleOf(messages: ChatUIMessage[]): string {
  const first = messages.find((m) => m.role === "user");
  const text = (first?.parts ?? []).map((p) => (p.type === "text" ? p.text : "")).join(" ").trim();

  return text.length > TITLE_MAX_LENGTH ? `${text.slice(0, TITLE_MAX_LENGTH - 1).trimEnd()}…` : text;
}

const address = (id: string) => `/api/threads/${encodeURIComponent(id)}`;

function write(account: string, id: string, send: () => Promise<Response>) {
  const next = (writes.get(id) ?? Promise.resolve()).then(async () => {
    const res = await send().catch(() => null);

    if (owner === account && !res?.ok) failed();
  });

  writes.set(id, next);
}

async function load(account: string) {
  const stressed = stressConversations(dataMode(), Date.now());

  if (stressed) return show({ list: stressed, state: "unsaved" });

  const res = await fetch("/api/threads", { cache: "no-store" }).catch(() => null);
  const listed = Listed.safeParse(res?.ok ? await res.json().catch(() => null) : null);

  if (owner !== account) return;

  if (!listed.success) return failed();

  const known = new Set(listed.data.threads.map((t) => t.id));
  const stored = listed.data.threads.map((t): Conversation => ({ ...t, messages: null }));

  show({ list: [...library.list.filter((c) => !known.has(c.id)), ...stored].toSorted((a, b) => b.updatedAt - a.updatedAt), state: "ready" });
}

function forget(account: string, id: string) {
  leaving.delete(id);
  write(account, id, () => fetch(address(id), { method: "DELETE", keepalive: true }));
}

export const conversations = {
  subscribe(listener: () => void) {
    listeners.add(listener);

    return () => listeners.delete(listener);
  },
  snapshotOf: (account: string) => () => (owner === account ? library : LOADING),
  serverSnapshot: () => LOADING,
  enter(account: string) {
    if (owner === account) return;

    owner = account;
    writes.clear();
    opening.clear();
    leaving.clear();
    show(LOADING);
    void load(account);
  },
  flush() {
    const account = owner;

    if (!account) return;

    for (const [id, timer] of leaving) {
      window.clearTimeout(timer);
      forget(account, id);
    }
  },
  async open(id: string) {
    const account = owner;
    const wanted = library.list.find((c) => c.id === id);

    if (!account || !wanted || wanted.messages || opening.has(id)) return;

    opening.add(id);

    if (wanted.unopened) show({ ...library, list: library.list.map((c) => (c.id === id ? { id: c.id, title: c.title, updatedAt: c.updatedAt, messages: null } : c)) });

    const res = await fetch(address(id), { cache: "no-store" }).catch(() => null);
    const opened = Opened.safeParse(res?.ok ? await res.json().catch(() => null) : null);

    opening.delete(id);

    if (owner !== account) return;

    if (!opened.success) {
      show({ ...library, list: library.list.map((c) => (c.id === id ? { ...c, unopened: true as const } : c)) });

      return;
    }

    show({ ...library, list: library.list.map((c) => (c.id === id ? { ...c, messages: opened.data.thread.messages } : c)) });
  },
  save(id: string, messages: ChatUIMessage[]) {
    const account = owner;

    if (!account || messages.length === 0) return;

    show({ ...library, list: [{ id, title: titleOf(messages), updatedAt: Date.now(), messages }, ...library.list.filter((c) => c.id !== id)] });

    if (library.state === "unsaved") return;

    write(account, id, () => fetch(address(id), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages }) }));
  },
  remove(id: string): Conversation | null {
    const account = owner;
    const removed = library.list.find((c) => c.id === id) ?? null;

    show({ ...library, list: library.list.filter((c) => c.id !== id) });

    if (account && library.state !== "unsaved")
      leaving.set(
        id,
        window.setTimeout(() => forget(account, id), UNDO_MS),
      );

    return removed;
  },
  restore(conversation: Conversation) {
    window.clearTimeout(leaving.get(conversation.id));
    leaving.delete(conversation.id);
    show({ ...library, list: [conversation, ...library.list.filter((c) => c.id !== conversation.id)].toSorted((a, b) => b.updatedAt - a.updatedAt) });
  },
};
