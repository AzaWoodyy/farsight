import { z } from "zod";

const Cell = z.union([z.string(), z.number(), z.null()]);

const Image = z.object({ src: z.string(), tone: z.enum(["dark", "light"]).optional(), photo: z.boolean().optional() });

const Card = z.object({
  title: z.string(),
  subjects: z.array(z.object({ name: z.string(), line: z.string().nullable(), image: Image.nullable() })).optional(),
  icons: z.record(z.string(), Image).optional(),
  stats: z.array(z.object({ label: z.string(), value: z.string() })),
  bars: z.array(z.object({ label: z.string(), value: z.number(), text: z.string() })).nullable(),
  table: z.object({ columns: z.array(z.string()), rows: z.array(z.array(Cell)), numeric: z.array(z.boolean()), total: z.number() }).nullable(),
});

const TextPart = z.object({ type: z.literal("text"), text: z.string() });

const AnswerPart = z.object({
  type: z.literal("data-answer"),
  id: z.string().optional(),
  data: z.object({
    asked: z.string(),
    via: z.enum(["pipeline", "sql"]),
    pending: z.boolean(),
    card: Card.nullable(),
    sources: z.array(z.object({ label: z.string(), url: z.string() })),
    digest: z.string().nullable(),
  }),
});

const HtmlPart = z.object({ type: z.literal("data-html"), id: z.string().optional(), data: z.object({ title: z.string(), html: z.string() }) });

const KeptPart = z.discriminatedUnion("type", [TextPart, AnswerPart, HtmlPart]);

export const StoredMessage = z
  .object({ id: z.string(), role: z.enum(["user", "assistant"]), parts: z.array(z.unknown()).max(60) })
  .transform((message) => ({ ...message, parts: message.parts.flatMap((part) => KeptPart.safeParse(part).data ?? []) }));

export const StoredMessages = z.array(StoredMessage).min(1).max(200);

export type StoredMessages = z.infer<typeof StoredMessages>;

export const ThreadSummary = z.object({ id: z.string().min(1), title: z.string(), updatedAt: z.number() });

export type ThreadSummary = z.infer<typeof ThreadSummary>;
