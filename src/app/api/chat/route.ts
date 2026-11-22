import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { checkBotId } from "botid/server";
import { z } from "zod";
import { chatUser } from "@/lib/auth/chat-access";
import { ChatMessages, lastUserText, modelHistory, streamChat } from "@/lib/agent/chat";
import { CHAT_MESSAGE_MAX_LENGTH, type ChatUIMessage } from "@/lib/agent/chat-types";
import { llmStatus } from "@/lib/agent/llm";
import { messagesIn } from "@/lib/agent/messages";
import { requestPolicy } from "@/lib/http/request-policy";
import { DEFAULT_LOCALE, LOCALES } from "@/lib/locale";

export const maxDuration = 120;

const ChatRequest = z.object({ locale: z.enum(LOCALES).catch(DEFAULT_LOCALE), messages: ChatMessages });

export async function POST(req: Request) {
  if (process.env.VERCEL_ENV === "production") return Response.json({ error: "not found" }, { status: 404 });

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

  const stream = createUIMessageStream<ChatUIMessage>({
    execute: async ({ writer }) => {
      writer.write({ type: "start" });
      await streamChat(modelHistory(body.data.messages), writer, body.data.locale, req.signal);
    },
    onError: (err) => {
      console.error(err instanceof Error ? err.name : "ChatError");

      return messagesIn(body.data.locale).run.internalError;
    },
  });

  return createUIMessageStreamResponse({ stream, headers: { "Cache-Control": "no-store" } });
}
