import type { Metadata } from "next";
import { Suspense } from "react";
import { ChatFrame } from "../../chat/chat-frame";
import { ChatGate } from "../../chat/chat-gate";
import { ChatLoading } from "../../chat/chat-loading";
import { SHELL } from "../../i18n/shell";
import { chatConfigured } from "@/lib/auth/chat-config";

export const metadata: Metadata = { title: "Conversation", robots: { index: false, follow: false } };

export default function ChatPage() {
  if (!chatConfigured())
    return (
      <ChatFrame locale="en">
        <p className="mt-10 max-w-[68ch] text-sm leading-relaxed text-pretty text-muted sm:mt-16">{SHELL.en.chat.closed}</p>
      </ChatFrame>
    );

  return (
    <Suspense fallback={<ChatLoading locale="en" />}>
      <ChatGate locale="en" />
    </Suspense>
  );
}
