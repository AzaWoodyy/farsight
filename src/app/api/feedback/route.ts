import { checkBotId } from "botid/server";
import { z } from "zod";
import { sendFeedback } from "@/lib/tracing/langfuse";

/** A thumbs up or down on one answer, addressed by the id of its trace (32 hex digits). */
const FeedbackRequest = z.object({
  traceId: z.string().regex(/^[0-9a-f]{32}$/),
  rating: z.enum(["up", "down"]),
});

/**
 * Body: { traceId, rating: "up" | "down" }. The rating becomes a boolean
 * Langfuse score on the trace; nothing about the visitor is sent with it.
 * 204 when recorded, 503 when tracing is off or Langfuse did not take it.
 */
export async function POST(req: Request) {
  const verification = await checkBotId({ developmentOptions: { isDevelopment: process.env.VERCEL !== "1" } });

  if (verification.isBot) return Response.json({ error: "access denied" }, { status: 403 });

  const body = FeedbackRequest.safeParse(await req.json().catch(() => null));

  if (!body.success) return Response.json({ error: "invalid feedback" }, { status: 400 });

  const recorded = await sendFeedback({ traceId: body.data.traceId, value: body.data.rating === "up" ? 1 : 0 });

  return recorded ? new Response(null, { status: 204 }) : Response.json({ error: "feedback not recorded" }, { status: 503 });
}
