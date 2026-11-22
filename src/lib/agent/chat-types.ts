import type { UIMessage } from "ai";
import type { Source, TableCell } from "./types";

export const CHAT_MESSAGE_MAX_LENGTH = 500;

export const CHAT_HISTORY_MESSAGES = 12;

export type ChatCardTable = { columns: string[]; rows: TableCell[][]; numeric: boolean[]; total: number };

export type ChatCardImage = { src: string; tone?: "dark" | "light"; photo?: boolean };

export type ChatCardSubject = { name: string; line: string | null; image: ChatCardImage | null };

export type ChatCard = {
  title: string;
  subjects?: ChatCardSubject[];
  icons?: Record<string, ChatCardImage>;
  stats: { label: string; value: string }[];
  bars: { label: string; value: number; text: string }[] | null;
  table: ChatCardTable | null;
};

export type ShownAnswer = {
  asked: string;
  via: "pipeline" | "sql";
  pending: boolean;
  card: ChatCard | null;
  sources: Source[];
  digest: string | null;
};

export type ShownHtml = { title: string; html: string };

export type ChatUIMessage = UIMessage<never, { answer: ShownAnswer; html: ShownHtml }>;
