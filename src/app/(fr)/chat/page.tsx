import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ChatGate } from "../../chat/chat-gate";
import { ChatLoading } from "../../chat/chat-loading";

export const metadata: Metadata = { title: "Conversation", robots: { index: false, follow: false } };

export default function ChatPage() {
  if (process.env.VERCEL_ENV === "production") notFound();

  return (
    <Suspense fallback={<ChatLoading locale="fr" />}>
      <ChatGate locale="fr" />
    </Suspense>
  );
}
