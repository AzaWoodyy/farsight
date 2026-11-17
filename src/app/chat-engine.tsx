"use client";

import "./zod-client";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { type Ref, useEffect, useImperativeHandle } from "react";
import type { AgentUIMessage } from "@/lib/agent/types";
import { type Locale, LOCALES } from "@/lib/locale";
import { useLocale } from "./i18n/locale-context";
import { UI, type Ui } from "./i18n/ui";

/** What the console reads from the chat. */
export type ChatState = {
  messages: AgentUIMessage[];
  status: "submitted" | "streaming" | "ready" | "error";
  error: Error | undefined;
};

/** What the console drives. */
export type ChatControls = {
  ask: (text: string, sessionId: string) => void;
  reset: () => void;
};

/** What the chat shows for a failed POST /api/ask, by HTTP status. */
function httpErrorMessage(status: number, errors: Ui["errors"]): string {
  if (status === 429) return errors.tooMany;

  if (status === 403) return errors.refused;

  if (status === 400) return errors.invalid;

  if (status === 504) return errors.timeout;

  if (status >= 500) return errors.server(status);

  return errors.other(status);
}

/**
 * fetch for the chat transport: a non-2xx answer (a 429 from the firewall
 * rate limit, a 403 from BotID…) becomes a readable error instead of the
 * raw response body the transport would show, in the language of the page.
 */
const askFetchIn = (locale: Locale) => async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const { errors } = UI[locale];
  let res: Response;

  try {
    res = await fetch(input, init);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new Error(errors.offline);
  }

  if (!res.ok) throw new Error(httpErrorMessage(res.status, errors));

  return res;
};

// One transport per language, made once: useChat keeps the one it was first given.
// The transport wants `typeof fetch`, which also carries `preconnect`.
const transports = new Map(
  LOCALES.map((locale) => [
    locale,
    new DefaultChatTransport<AgentUIMessage>({ api: "/api/ask", fetch: Object.assign(askFetchIn(locale), { preconnect: fetch.preconnect }) }),
  ]),
);

/**
 * The chat itself (AI SDK and its stream parsing), without any markup. The console loads it apart from the
 * home page, which then ships about half its JavaScript; `first` is the question asked before it was there.
 */
export function ChatEngine({
  controls,
  onChange,
  first,
}: {
  controls: Ref<ChatControls>;
  onChange: (state: ChatState) => void;
  first: { text: string; sessionId: string } | null;
}) {
  const { messages, sendMessage, setMessages, status, error, stop } = useChat<AgentUIMessage>({ transport: transports.get(useLocale()) });
  const running = status === "submitted" || status === "streaming";

  useImperativeHandle(
    controls,
    () => ({
      ask(text, sessionId) {
        if (running) void stop();
        // One question at a time: the agent does not use the chat history.
        setMessages([]);
        void sendMessage({ text }, { body: { sessionId } });
      },
      reset() {
        if (running) void stop();
        setMessages([]);
      },
    }),
    [running, stop, setMessages, sendMessage],
  );

  useEffect(() => onChange({ messages, status, error }), [messages, status, error, onChange]);

  // The question that made the console load the chat: asked once, when it mounts.
  useEffect(() => {
    if (first) void sendMessage({ text: first.text }, { body: { sessionId: first.sessionId } });
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
