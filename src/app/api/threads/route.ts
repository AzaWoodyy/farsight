import { chatUser } from "@/lib/auth/chat-access";
import { chatConfigured } from "@/lib/auth/chat-config";
import { listThreads } from "@/lib/threads/store";

export async function GET() {
  if (!chatConfigured()) return Response.json({ error: "not found" }, { status: 404 });

  const user = await chatUser();

  if (user instanceof Response) return user;

  return Response.json({ threads: await listThreads(user) }, { headers: { "Cache-Control": "no-store" } });
}
