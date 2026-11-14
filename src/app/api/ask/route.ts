import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { checkBotId } from "botid/server";
import { after } from "next/server";
import { z } from "zod";
import { runAgent } from "@/lib/agent/run";
import { traceQuestion } from "@/lib/agent/trace";
import type { AgentUIMessage } from "@/lib/agent/types";
import { flushTracing, startTracing } from "@/lib/tracing/langfuse";

// Registered with the route: a registration made in instrumentation.ts did not reach
// the module instances this route runs the agent with.
startTracing();

/**
 * Worst case: five LLM calls (understand, query, two repairs, summary), each
 * capped at 15 s by LLM_CALL. 90 s covers them and stops a stuck request well
 * before Vercel's 300 s default.
 */
export const maxDuration = 90;

/** The part of the chat request the agent reads: the text parts of the messages. */
const ChatRequest = z.object({
  /** Anonymous id of the conversation, made up by the browser; it only groups the traces of one conversation. */
  sessionId: z.uuid().optional().catch(undefined),
  messages: z
    .array(
      z.object({
        role: z.string(),
        parts: z.array(z.object({ type: z.string(), text: z.string().optional() })).default([]),
      }),
    )
    .default([]),
});

/**
 * useChat endpoint. Body: the AI SDK chat request ({ messages, ... }); only
 * the text of the last user message is used. Response: a UI message stream
 * with one `data-step` part per step (updated in place, id = step name) and
 * a final `data-answer` part. Requests flagged as bots by BotID get a 403.
 *
 * When Langfuse is configured the question is one trace (question, steps,
 * LLM calls: never the IP, a cookie or a header), grouped with the other
 * questions of the conversation by the optional `sessionId` of the body. A
 * `data-trace` part gives the trace id to the thumbs up / down of the UI.
 */
export async function POST(req: Request) {
  // BotID Basic, before any model call. Outside Vercel (`bun run dev`, a local
  // `next start`) there is no BotID service: the check answers "human".
  const verification = await checkBotId({ developmentOptions: { isDevelopment: process.env.VERCEL !== "1" } });

  if (verification.isBot) return Response.json({ error: "access denied" }, { status: 403 });

  const body = ChatRequest.safeParse(await req.json().catch(() => null));

  if (!body.success) return Response.json({ error: "invalid chat request" }, { status: 400 });

  const last = body.data.messages.findLast((m) => m.role === "user");

  const question = (last?.parts ?? [])
    .map((p) => (p.type === "text" ? (p.text ?? "") : ""))
    .join(" ")
    .trim()
    .slice(0, 500);

  if (!question) return Response.json({ error: "question is required" }, { status: 400 });

  // The spans are sent once the answer is fully streamed, outside the response:
  // a slow or unreachable Langfuse costs the visitor nothing.
  const answered = Promise.withResolvers<void>();
  after(() => answered.promise.then(flushTracing));

  const stream = createUIMessageStream<AgentUIMessage>({
    execute: async ({ writer }) => {
      writer.write({ type: "start" });

      try {
        await traceQuestion(question, body.data.sessionId ?? null, (traceId) => {
          if (traceId) writer.write({ type: "data-trace", id: "trace", data: { traceId } });

          return runAgent(question, (event) => {
            if (event.type === "step") writer.write({ type: "data-step", id: event.part.step, data: event.part });
            else writer.write({ type: "data-answer", id: "answer", data: event.answer });
          });
        });
      } finally {
        answered.resolve();
      }

      writer.write({ type: "finish" });
    },
    onError: (err) => {
      console.error(err);

      return "Erreur interne de l'agent.";
    },
  });

  return createUIMessageStreamResponse({ stream, headers: { "Cache-Control": "no-store" } });
}
