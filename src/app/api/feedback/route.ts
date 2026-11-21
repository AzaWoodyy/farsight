import { checkBotId } from "botid/server";
import { z } from "zod";
import { requestPolicy } from "@/lib/http/request-policy";
import { verifyFeedback } from "@/lib/tracing/feedback-token";
import { sendFeedback } from "@/lib/tracing/langfuse";

const FeedbackRequest = z.object({
  traceId: z.string().regex(/^[0-9a-f]{32}$/),
  token: z.string().regex(/^\d{13}\.[0-9a-f]{64}$/),
  rating: z.enum(["up", "down"]),
});

export async function POST(req: Request) {
  const denied = requestPolicy(req, "feedback");

  if (denied) return denied;
  const verification = await checkBotId({ developmentOptions: { isDevelopment: process.env.VERCEL !== "1" } });

  if (verification.isBot) return Response.json({ error: "access denied" }, { status: 403 });

  const body = FeedbackRequest.safeParse(await req.json().catch(() => null));

  if (!body.success) return Response.json({ error: "invalid feedback" }, { status: 400 });

  if (!verifyFeedback(body.data.traceId, body.data.token))
    return Response.json({ error: "invalid feedback signature" }, { status: 403 });

  const recorded = await sendFeedback({ traceId: body.data.traceId, value: body.data.rating === "up" ? 1 : 0 });

  return recorded ? new Response(null, { status: 204 }) : Response.json({ error: "feedback not recorded" }, { status: 503 });
}
