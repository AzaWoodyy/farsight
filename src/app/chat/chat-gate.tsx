import { frFR } from "@clerk/localizations";
import { ClerkProvider } from "@clerk/nextjs";
import { chatAccess } from "@/lib/auth/chat-access";
import type { Locale } from "@/lib/locale";
import { ChatDoor } from "./chat-door";
import { ChatRoom } from "./chat-room";

const APPEARANCE = {
  variables: {
    colorPrimary: "var(--accent)",
    colorBackground: "var(--background)",
    colorForeground: "var(--foreground)",
    colorMutedForeground: "var(--muted)",
    colorBorder: "var(--line)",
    colorInput: "var(--background)",
    colorInputForeground: "var(--foreground)",
    colorDanger: "var(--error)",
    colorSuccess: "var(--ok)",
    borderRadius: "0",
    fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
  },
};

export async function ChatGate({ locale }: { locale: Locale }) {
  const access = await chatAccess();

  return (
    <ClerkProvider localization={locale === "fr" ? frFR : undefined} appearance={APPEARANCE}>
      {access.state === "allowed" ? <ChatRoom locale={locale} /> : <ChatDoor locale={locale} pending={access.state === "pending"} />}
    </ClerkProvider>
  );
}
