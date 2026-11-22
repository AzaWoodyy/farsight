import { clerkMiddleware } from "@clerk/nextjs/server";
import { type NextFetchEvent, type NextRequest, NextResponse } from "next/server";
import { chatConfigured } from "@/lib/auth/chat-config";

const signedIn = clerkMiddleware();

export default function proxy(request: NextRequest, event: NextFetchEvent) {
  return chatConfigured() ? signedIn(request, event) : NextResponse.next();
}

export const config = { matcher: ["/chat", "/en/chat", "/api/chat", "/api/threads/:path*"] };
