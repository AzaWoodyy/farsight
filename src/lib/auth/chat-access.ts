import { auth, clerkClient } from "@clerk/nextjs/server";

export type ChatAccess = { state: "anonymous" } | { state: "pending"; userId: string } | { state: "allowed"; userId: string };

const REMEMBERED_MS = 60_000;
const MAX_REMEMBERED = 500;

const remembered = new Map<string, { allowed: boolean; until: number }>();

async function allowed(userId: string): Promise<boolean> {
  const known = remembered.get(userId);

  if (known && known.until > Date.now()) return known.allowed;

  const clerk = await clerkClient();
  const user = await clerk.users.getUser(userId);
  const granted = user.publicMetadata.chat === true;

  if (remembered.size >= MAX_REMEMBERED) remembered.clear();
  remembered.set(userId, { allowed: granted, until: Date.now() + REMEMBERED_MS });

  return granted;
}

export async function chatAccess(): Promise<ChatAccess> {
  const { userId } = await auth();

  if (!userId) return { state: "anonymous" };

  return (await allowed(userId)) ? { state: "allowed", userId } : { state: "pending", userId };
}

export async function chatUser(): Promise<string | Response> {
  const access = await chatAccess();

  if (access.state === "anonymous") return Response.json({ error: "sign in required" }, { status: 401 });

  if (access.state === "pending") return Response.json({ error: "access not granted" }, { status: 403 });

  return access.userId;
}
