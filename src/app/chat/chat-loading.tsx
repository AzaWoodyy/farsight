import "./chat.css";
import type { Locale } from "@/lib/locale";
import { SHELL } from "../i18n/shell";
import { ChatFrame } from "./chat-frame";

export function ChatLoading({ locale }: { locale: Locale }) {
  const label = SHELL[locale].chat.opening;

  return (
    <ChatFrame locale={locale}>
      <p role="status" className="mt-10 text-sm sm:mt-16">
        <span className="t-shimmer" data-text={label}>
          {label}
        </span>
      </p>
    </ChatFrame>
  );
}
