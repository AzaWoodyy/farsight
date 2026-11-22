import { z } from "zod";
import { chatUser } from "@/lib/auth/chat-access";
import { chatConfigured } from "@/lib/auth/chat-config";
import { deleteThread, readThread, saveThread, ThreadMessages } from "@/lib/threads/store";

const ThreadId = z.uuid();
const Body = z.object({ messages: ThreadMessages });

async function request(params: Promise<{ id: string }>): Promise<{ user: string; id: string } | Response> {
  if (!chatConfigured()) return Response.json({ error: "not found" }, { status: 404 });

  const user = await chatUser();

  if (user instanceof Response) return user;

  const id = ThreadId.safeParse((await params).id);

  if (!id.success) return Response.json({ error: "invalid thread" }, { status: 400 });

  return { user, id: id.data };
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const target = await request(params);

  if (target instanceof Response) return target;

  const thread = await readThread(target.user, target.id);

  return thread ? Response.json({ thread }, { headers: { "Cache-Control": "no-store" } }) : Response.json({ error: "not found" }, { status: 404 });
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const target = await request(params);

  if (target instanceof Response) return target;

  const body = Body.safeParse(await req.json().catch(() => null));

  if (!body.success) return Response.json({ error: "invalid thread" }, { status: 400 });

  const outcome = await saveThread(target.user, target.id, body.data.messages);

  if (outcome === "too_large") return Response.json({ error: "thread too large" }, { status: 413 });

  if (outcome === "not_yours") return Response.json({ error: "not found" }, { status: 404 });

  return Response.json({ saved: true });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const target = await request(params);

  if (target instanceof Response) return target;

  await deleteThread(target.user, target.id);

  return Response.json({ deleted: true });
}
