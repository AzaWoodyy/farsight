import { verifyWebhook } from "@clerk/nextjs/webhooks";
import type { NextRequest } from "next/server";
import { chatConfigured } from "@/lib/auth/chat-config";
import { forgetUser } from "@/lib/threads/store";

export async function POST(req: NextRequest) {
  if (!chatConfigured() || !process.env.CLERK_WEBHOOK_SIGNING_SECRET?.trim()) return Response.json({ error: "not found" }, { status: 404 });

  const event = await verifyWebhook(req).catch(() => null);

  if (!event) return Response.json({ error: "invalid signature" }, { status: 400 });

  if (event.type === "user.deleted" && event.data.id) await forgetUser(event.data.id);

  return Response.json({ received: true });
}
