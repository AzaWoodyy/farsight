import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { checkBotId } from "botid/server";
import { after } from "next/server";
import { z } from "zod";
import { messagesIn } from "@/lib/agent/messages";
import { runAgent } from "@/lib/agent/run";
import { traceQuestion } from "@/lib/agent/trace";
import { type AgentUIMessage, QUESTION_MAX_LENGTH } from "@/lib/agent/types";
import { requestPolicy } from "@/lib/http/request-policy";
import { DEFAULT_LOCALE, LOCALES } from "@/lib/locale";
import { signFeedback } from "@/lib/tracing/feedback-token";
import { flushTracing, startTracing } from "@/lib/tracing/langfuse";

startTracing();

export const maxDuration = 90;

const ChatRequest = z.object({
  sessionId: z.uuid().optional().catch(undefined),
  locale: z.enum(LOCALES).catch(DEFAULT_LOCALE),
  messages: z
    .array(
      z.object({
        role: z.string(),
        parts: z.array(z.object({ type: z.string(), text: z.string().optional() })).default([]),
      }),
    )
    .default([]),
});

export async function POST(req: Request) {
  const denied = requestPolicy(req, "ask");

  if (denied) return denied;
  const verification = await checkBotId({ developmentOptions: { isDevelopment: process.env.VERCEL !== "1" } });

  if (verification.isBot) return Response.json({ error: "access denied" }, { status: 403 });

  const body = ChatRequest.safeParse(await req.json().catch(() => null));

  if (!body.success) return Response.json({ error: "invalid chat request" }, { status: 400 });

  const last = body.data.messages.findLast((m) => m.role === "user");

  const question = (last?.parts ?? [])
    .map((p) => (p.type === "text" ? (p.text ?? "") : ""))
    .join(" ")
    .trim();

  if (question.length > QUESTION_MAX_LENGTH)
    return Response.json({ error: `question exceeds ${QUESTION_MAX_LENGTH} characters` }, { status: 400 });

  if (!question) return Response.json({ error: "question is required" }, { status: 400 });

  const answered = Promise.withResolvers<void>();
  after(() => answered.promise.then(flushTracing));

  const stream = createUIMessageStream<AgentUIMessage>({
    execute: async ({ writer }) => {
      writer.write({ type: "start" });

      try {
        await traceQuestion(question, body.data.sessionId ?? null, body.data.locale, (traceId) => {
          const token = traceId ? signFeedback(traceId) : null;

          if (traceId && token) writer.write({ type: "data-trace", id: "trace", data: { traceId, token } });

          return runAgent(question, (event) => {
            if (event.type === "step") writer.write({ type: "data-step", id: event.part.step, data: event.part });
            else writer.write({ type: "data-answer", id: "answer", data: event.answer });
          }, undefined, req.signal, body.data.locale);
        });
      } finally {
        answered.resolve();
      }

      writer.write({ type: "finish" });
    },
    onError: (err) => {
      console.error(err instanceof Error ? err.name : "AgentError");

      return messagesIn(body.data.locale).run.internalError;
    },
  });

  return createUIMessageStreamResponse({ stream, headers: { "Cache-Control": "no-store" } });
}
