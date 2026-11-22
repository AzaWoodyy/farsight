import { auth, clerkClient } from "@clerk/nextjs/server";
import { z } from "zod";

export type ChatAccess = { state: "anonymous" } | { state: "pending"; userId: string } | { state: "allowed"; userId: string };

const GRANTED_MS = 5 * 60_000;
const PENDING_MS = 10_000;
const MAX_REMEMBERED = 500;

const GrantClaim = z.object({ metadata: z.object({ chat: z.literal(true) }) });

const remembered = new Map<string, { allowed: boolean; until: number }>();

async function allowed(userId: string): Promise<boolean> {
  const known = remembered.get(userId);

  if (known && known.until > Date.now()) return known.allowed;

  const clerk = await clerkClient();
  const user = await clerk.users.getUser(userId);
  const granted = user.publicMetadata.chat === true;

  if (remembered.size >= MAX_REMEMBERED) remembered.clear();
  remembered.set(userId, { allowed: granted, until: Date.now() + (granted ? GRANTED_MS : PENDING_MS) });

  return granted;
}

export async function chatAccess(): Promise<ChatAccess> {
  const { userId, sessionClaims } = await auth();

  if (!userId) return { state: "anonymous" };

  if (GrantClaim.safeParse(sessionClaims).success) return { state: "allowed", userId };

  return (await allowed(userId)) ? { state: "allowed", userId } : { state: "pending", userId };
}

export async function chatUser(): Promise<string | Response> {
  const access = await chatAccess();

  if (access.state === "anonymous") return Response.json({ error: "sign in required" }, { status: 401 });

  if (access.state === "pending") return Response.json({ error: "access not granted" }, { status: 403 });

  return access.userId;
}
