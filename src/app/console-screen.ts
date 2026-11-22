import type { AgentUIMessage } from "@/lib/agent/types";
import type { ChatState } from "./chat-engine";

export type Question = { text: string; sessionId: string; restored?: AgentUIMessage[] };

export const IDLE: ChatState = { messages: [], status: "ready", error: undefined };

export type Screen =
  | { kind: "home" }
  | { kind: "question"; question: Question; chat: ChatState }
  | { kind: "load_failed"; question: Question };

export type ScreenEvent =
  | { type: "asked"; question: Question }
  | { type: "restored"; question: Question; messages: AgentUIMessage[] }
  | { type: "chat_changed"; chat: ChatState }
  | { type: "modules_loaded" }
  | { type: "modules_failed" }
  | { type: "home" };

export const HOME: Screen = { kind: "home" };

export function screenAfter(screen: Screen, event: ScreenEvent): Screen {
  switch (event.type) {
    case "asked":
      return { kind: "question", question: event.question, chat: IDLE };
    case "restored":
      return { kind: "question", question: { ...event.question, restored: event.messages }, chat: { messages: event.messages, status: "ready", error: undefined } };
    case "chat_changed":
      return screen.kind === "question" ? { ...screen, chat: event.chat } : screen;
    case "modules_loaded":
      return screen.kind === "load_failed" ? { kind: "question", question: screen.question, chat: IDLE } : screen;
    case "modules_failed":
      return screen.kind === "question" ? { kind: "load_failed", question: screen.question } : screen;
    case "home":
      return HOME;
  }
}

export function isRunning(screen: Screen): boolean {
  if (screen.kind !== "question") return false;
  const { messages, status, error } = screen.chat;

  return status === "submitted" || status === "streaming" || (messages.length === 0 && !error);
}
