import { runAgent } from "@/lib/agent/graph";

/**
 * POST { question } -> NDJSON stream, one line per executed graph node:
 *   {"node":"understand","trace":[...],"answer":null}
 *   ...
 *   {"node":"format","trace":[...],"answer":{...}}
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { question?: unknown };
  const question = typeof body.question === "string" ? body.question.trim().slice(0, 500) : "";
  if (!question) return Response.json({ error: "question is required" }, { status: 400 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const update of runAgent(question)) {
          controller.enqueue(encoder.encode(`${JSON.stringify(update)}\n`));
        }
      } catch (err) {
        console.error(err);
        controller.enqueue(
          encoder.encode(
            `${JSON.stringify({ node: "error", trace: [{ node: "format", status: "error", title: "Erreur interne de l'agent", at: new Date().toISOString() }], answer: null })}\n`,
          ),
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}
