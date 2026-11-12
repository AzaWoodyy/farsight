import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { runAgent } from "@/lib/agent/run";
import type { AgentUIMessage } from "@/lib/agent/types";

/**
 * useChat endpoint. Body: the AI SDK chat request ({ messages, ... }); only
 * the text of the last user message is used. Response: a UI message stream
 * with one `data-step` part per step (updated in place, id = step name) and
 * a final `data-answer` part.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { messages?: AgentUIMessage[] };
  const last = body.messages?.findLast((m) => m.role === "user");
  const question = (last?.parts ?? [])
    .map((p) => (p.type === "text" ? p.text : ""))
    .join(" ")
    .trim()
    .slice(0, 500);
  if (!question) return Response.json({ error: "question is required" }, { status: 400 });

  const stream = createUIMessageStream<AgentUIMessage>({
    execute: async ({ writer }) => {
      writer.write({ type: "start" });
      await runAgent(question, (event) => {
        if (event.type === "step")
          writer.write({ type: "data-step", id: event.part.step, data: event.part });
        else writer.write({ type: "data-answer", id: "answer", data: event.answer });
      });
      writer.write({ type: "finish" });
    },
    onError: (err) => {
      console.error(err);
      return "Erreur interne de l'agent.";
    },
  });
  return createUIMessageStreamResponse({ stream, headers: { "Cache-Control": "no-store" } });
}
