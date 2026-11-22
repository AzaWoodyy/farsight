"use client";

import "./zod-client";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { type Ref, useCallback, useEffect, useImperativeHandle, useRef } from "react";
import type { AgentUIMessage } from "@/lib/agent/types";
import type { Question } from "./console-screen";
import { type Locale, LOCALES } from "@/lib/locale";
import { useLocale } from "./i18n/locale-context";
import { UI, type Ui } from "./i18n/ui";

export type ChatState = {
  messages: AgentUIMessage[];
  status: "submitted" | "streaming" | "ready" | "error";
  error: Error | undefined;
};

export type ChatControls = {
  ask: (text: string, sessionId: string) => void;
  show: (messages: AgentUIMessage[]) => void;
  reset: () => void;
};

function httpErrorMessage(status: number, errors: Ui["errors"]): string {
  if (status === 429) return errors.tooMany;

  if (status === 403) return errors.refused;

  if (status === 400) return errors.invalid;

  if (status === 504) return errors.timeout;

  if (status >= 500) return errors.server(status);

  return errors.other(status);
}

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

const transports = new Map(
  LOCALES.map((locale) => [
    locale,
    new DefaultChatTransport<AgentUIMessage>({ api: "/api/ask", fetch: Object.assign(askFetchIn(locale), { preconnect: fetch.preconnect }) }),
  ]),
);

export function ChatEngine({
  controls,
  onChange,
  first,
}: {
  controls: Ref<ChatControls>;
  onChange: (state: ChatState) => void;
  first: Question | null;
}) {
  const locale = useLocale();

  const { messages, sendMessage, setMessages, status, error, stop } = useChat<AgentUIMessage>({
    transport: transports.get(locale),
    messages: first?.restored,
  });

  const running = status === "submitted" || status === "streaming";

  const current = useRef<{ text: string; sessionId: string } | null>(null);
  const phase = useRef<"new" | "shown" | "left">("new");

  const send = useCallback(
    (question: { text: string; sessionId: string }) => {
      current.current = question;
      void sendMessage({ text: question.text }, { body: { sessionId: question.sessionId, locale } });
    },
    [sendMessage, locale],
  );

  useImperativeHandle(
    controls,
    () => ({
      ask(text, sessionId) {
        if (running) void stop();
        phase.current = "shown";
        setMessages([]);
        send({ text, sessionId });
      },
      show(restored) {
        if (running) void stop();
        phase.current = "shown";
        current.current = null;
        setMessages(restored);
      },
      reset() {
        if (running) void stop();
        phase.current = "shown";
        current.current = null;
        setMessages([]);
      },
    }),
    [running, stop, setMessages, send],
  );

  useEffect(() => onChange({ messages, status, error }), [messages, status, error, onChange]);

  useEffect(() => {
    if (phase.current === "new") {
      phase.current = "shown";

      if (first && !first.restored) send(first);
    }

    return () => {
      phase.current = "left";
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const answered = messages.some((m) => m.role === "assistant" && m.parts.some((p) => p.type === "data-answer"));

  useEffect(() => {
    if (phase.current !== "left" || running) return;

    phase.current = "shown";

    if (!current.current || error || answered) return;

    setMessages([]);
    send(current.current);
  }, [running, error, answered, setMessages, send]);

  return null;
}
