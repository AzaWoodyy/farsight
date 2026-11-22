import { z } from "zod";
import type { ChatUIMessage } from "@/lib/agent/chat-types";
import { dataMode, stressConversations } from "./worst-case";

export type Conversation = { id: string; title: string; updatedAt: number; messages: ChatUIMessage[] };

const TITLE_MAX_LENGTH = 60;

const Listed = z.object({
  saved: z.boolean(),
  threads: z.array(
    z.object({
      id: z.string().min(1),
      title: z.string(),
      updatedAt: z.number(),
      messages: z.array(z.looseObject({ id: z.string(), role: z.enum(["user", "assistant"]), parts: z.array(z.looseObject({ type: z.string() })) })),
    }),
  ),
});

export type Library = { list: Conversation[]; state: "loading" | "ready" | "unsaved" | "failed" };

const LOADING: Library = { list: [], state: "loading" };

let library: Library = LOADING;
let asked = false;
const listeners = new Set<() => void>();

function show(next: Library) {
  library = next;

  for (const listener of listeners) listener();
}

function titleOf(messages: ChatUIMessage[]): string {
  const first = messages.find((m) => m.role === "user");
  const text = (first?.parts ?? []).map((p) => (p.type === "text" ? p.text : "")).join(" ").trim();

  return text.length > TITLE_MAX_LENGTH ? `${text.slice(0, TITLE_MAX_LENGTH - 1).trimEnd()}…` : text;
}

const address = (id: string) => `/api/threads/${encodeURIComponent(id)}`;

async function load() {
  const stressed = stressConversations(dataMode(), Date.now());

  if (stressed) return show({ list: stressed, state: "unsaved" });

  try {
    const res = await fetch("/api/threads", { cache: "no-store" });
    const listed = Listed.safeParse(res.ok ? await res.json() : null);

    if (!listed.success) return show({ list: library.list, state: "failed" });

    const known = new Set(listed.data.threads.map((t) => t.id));

    // SAFETY: the page itself wrote these messages; the schema checks the fields the views read first (id, role, parts[].type).
    const stored = listed.data.threads as Conversation[];

    show({ list: [...library.list.filter((c) => !known.has(c.id)), ...stored].toSorted((a, b) => b.updatedAt - a.updatedAt), state: listed.data.saved ? "ready" : "unsaved" });
  } catch {
    show({ list: library.list, state: "failed" });
  }
}

export const conversations = {
  subscribe(listener: () => void) {
    listeners.add(listener);

    if (!asked) {
      asked = true;
      void load();
    }

    return () => listeners.delete(listener);
  },
  snapshot: () => library,
  serverSnapshot: () => LOADING,
  save(id: string, messages: ChatUIMessage[]) {
    if (messages.length === 0) return;

    show({ ...library, list: [{ id, title: titleOf(messages), updatedAt: Date.now(), messages }, ...library.list.filter((c) => c.id !== id)] });

    if (library.state === "unsaved") return;

    void fetch(address(id), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages }) }).catch(() => {});
  },
  remove(id: string): Conversation | null {
    const removed = library.list.find((c) => c.id === id) ?? null;

    show({ ...library, list: library.list.filter((c) => c.id !== id) });

    if (library.state !== "unsaved") void fetch(address(id), { method: "DELETE" }).catch(() => {});

    return removed;
  },
  restore(conversation: Conversation) {
    conversations.save(conversation.id, conversation.messages);
  },
};
