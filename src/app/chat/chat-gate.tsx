import { ClerkProvider } from "@clerk/nextjs";
import { chatAccess } from "@/lib/auth/chat-access";
import type { Locale } from "@/lib/locale";
import { ChatDoor } from "./chat-door";
import { ChatFrame } from "./chat-frame";
import { FRENCH_AT_THE_DOOR, FRENCH_IN_THE_ROOM } from "./clerk-french";
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
  elements: { avatarBox: { borderRadius: 0 }, userButtonAvatarBox: { borderRadius: 0 } },
};

export async function ChatGate({ locale }: { locale: Locale }) {
  const access = await chatAccess();
  const french = access.state === "allowed" ? FRENCH_IN_THE_ROOM : FRENCH_AT_THE_DOOR;

  return (
    <ClerkProvider localization={locale === "fr" ? french : undefined} appearance={APPEARANCE}>
      {access.state === "allowed" ? (
        <ChatRoom locale={locale} />
      ) : (
        <ChatFrame locale={locale}>
          <ChatDoor locale={locale} pending={access.state === "pending"} />
        </ChatFrame>
      )}
    </ClerkProvider>
  );
}
