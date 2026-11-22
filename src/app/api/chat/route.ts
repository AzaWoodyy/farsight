import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { checkBotId } from "botid/server";
import { after } from "next/server";
import { z } from "zod";
import { chatUser } from "@/lib/auth/chat-access";
import { chatConfigured } from "@/lib/auth/chat-config";
import { ChatMessages, lastUserText, modelHistory, streamChat } from "@/lib/agent/chat";
import { CHAT_MESSAGE_MAX_LENGTH, type ChatUIMessage, DAILY_LIMIT_ERROR } from "@/lib/agent/chat-types";
import { traceQuestion } from "@/lib/agent/trace";
import { DAILY_MESSAGES, spendMessage } from "@/lib/threads/store";
import { flushTracing, startTracing } from "@/lib/tracing/langfuse";
import { llmStatus } from "@/lib/agent/llm";
import { messagesIn } from "@/lib/agent/messages";
import { requestPolicy } from "@/lib/http/request-policy";
import { DEFAULT_LOCALE, LOCALES } from "@/lib/locale";

export const maxDuration = 120;

const ChatRequest = z.object({ conversationId: z.uuid().optional().catch(undefined), locale: z.enum(LOCALES).catch(DEFAULT_LOCALE), messages: ChatMessages });

startTracing();

export async function POST(req: Request) {
  if (!chatConfigured()) return Response.json({ error: "not found" }, { status: 404 });

  const denied = requestPolicy(req, "ask");

  if (denied) return denied;

  const user = await chatUser();

  if (user instanceof Response) return user;
  const verification = await checkBotId({ developmentOptions: { isDevelopment: process.env.VERCEL !== "1" } });

  if (verification.isBot) return Response.json({ error: "access denied" }, { status: 403 });

  const body = ChatRequest.safeParse(await req.json().catch(() => null));

  if (!body.success) return Response.json({ error: "invalid chat request" }, { status: 400 });

  const question = lastUserText(body.data.messages);

  if (!question || question.length > CHAT_MESSAGE_MAX_LENGTH) return Response.json({ error: "invalid message" }, { status: 400 });

  if (llmStatus() !== "ready") return Response.json({ error: "model unavailable" }, { status: 503 });

  if (!(await spendMessage(user))) return Response.json({ error: DAILY_LIMIT_ERROR, limit: DAILY_MESSAGES }, { status: 429 });

  const answered = Promise.withResolvers<void>();
  after(() => answered.promise.then(flushTracing));

  const stream = createUIMessageStream<ChatUIMessage>({
    execute: async ({ writer }) => {
      writer.write({ type: "start" });

      try {
        await traceQuestion(question, body.data.conversationId ?? null, body.data.locale, () => streamChat(modelHistory(body.data.messages), writer, body.data.locale, req.signal), true);
      } finally {
        answered.resolve();
      }
    },
    onError: (err) => {
      console.error(err instanceof Error ? err.name : "ChatError");

      return messagesIn(body.data.locale).run.internalError;
    },
  });

  return createUIMessageStreamResponse({ stream, headers: { "Cache-Control": "no-store" } });
}
