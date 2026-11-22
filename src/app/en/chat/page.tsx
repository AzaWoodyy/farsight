import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ChatGate } from "../../chat/chat-gate";

export const metadata: Metadata = { title: "Conversation", robots: { index: false, follow: false } };

export default function ChatPage() {
  if (process.env.VERCEL_ENV === "production") notFound();

  return (
    <Suspense fallback={null}>
      <ChatGate locale="en" />
    </Suspense>
  );
}
