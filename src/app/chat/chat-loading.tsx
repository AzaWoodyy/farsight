import "./chat.css";
import type { Locale } from "@/lib/locale";

const TEXT: Record<Locale, string> = { fr: "Ouverture de la conversation…", en: "Opening the conversation…" };

export function ChatLoading({ locale }: { locale: Locale }) {
  return (
    <div className="chat-shell mx-auto flex min-h-dvh w-full max-w-6xl flex-col justify-center px-4 sm:px-6">
      <p role="status" className="text-sm">
        <span className="t-shimmer" data-text={TEXT[locale]}>
          {TEXT[locale]}
        </span>
      </p>
    </div>
  );
}
