import { ClerkProvider } from "@clerk/nextjs";
import { chatAccess } from "@/lib/auth/chat-access";
import type { Locale } from "@/lib/locale";
import { ChatDoor } from "./chat-door";
import { ChatFrame } from "./chat-frame";
import { FRENCH_AT_THE_DOOR, FRENCH_IN_THE_ROOM } from "./clerk-french";
import { ChatRoom } from "./chat-room";

const APPEARANCE = {
  variables: {
    colorPrimary: "var(--door-accent)",
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
  elements: {
    avatarBox: { borderRadius: 0 },
    userButtonAvatarBox: { borderRadius: 0, width: "2rem", height: "2rem" },
    userButtonTrigger: { padding: "6px", borderRadius: 0 },
    modalBackdrop: { alignItems: "center", backgroundColor: "color-mix(in srgb, var(--background) 82%, transparent)" },
    modalContent: { margin: "auto" },
    cardBox: { border: "1px solid var(--line)", boxShadow: "none" },
    card: { backgroundColor: "var(--background)", boxShadow: "none" },
    footer: { background: "var(--background)" },
    formFieldInput: { borderWidth: "1px !important", borderStyle: "solid", borderColor: "var(--line)", boxShadow: "none !important", minHeight: "2.75rem", fontSize: "16px", "&:focus": { borderColor: "var(--accent)" } },
    formButtonPrimary: {
      color: "var(--background)",
      boxShadow: "none !important",
      minHeight: "2.75rem",
      textTransform: "uppercase",
      letterSpacing: "0.05em",
      "&::after": { display: "none" },
    },
    socialButtonsBlockButton: { borderWidth: "1px !important", borderStyle: "solid", borderColor: "var(--line)", boxShadow: "none !important", minHeight: "2.75rem" },
    socialButtonsIconButton: { borderWidth: "1px !important", borderStyle: "solid", borderColor: "var(--line)", boxShadow: "none !important", minHeight: "2.75rem" },
  },
};

export async function ChatGate({ locale }: { locale: Locale }) {
  const access = await chatAccess();
  const french = access.state === "allowed" ? FRENCH_IN_THE_ROOM : FRENCH_AT_THE_DOOR;

  return (
    <ClerkProvider localization={locale === "fr" ? french : undefined} appearance={APPEARANCE}>
      {access.state === "allowed" ? (
        <ChatRoom key={access.userId} locale={locale} account={access.userId} />
      ) : (
        <ChatFrame locale={locale}>
          <ChatDoor locale={locale} pending={access.state === "pending"} />
        </ChatFrame>
      )}
    </ClerkProvider>
  );
}
