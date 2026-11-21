import { ImageResponse } from "next/og";
import type { Locale } from "../i18n/locales";
import { SHELL } from "../i18n/shell";
import { cardFonts } from "./card-font";
import { Mark } from "./logo";
import { PALETTE, SITE } from "./site";

const ALT_SEPARATOR: Record<Locale, string> = { fr: " : ", en: ": " };

export const shareAlt = (locale: Locale) => `${SITE.name}${ALT_SEPARATOR[locale]}${SHELL[locale].tagline}`;

/** Share card of a language: the mark and name, the tagline, and three real questions, on the dark palette. */
export async function shareCard(locale: Locale, size: { width: number; height: number }) {
  const { background, foreground, muted, accent } = PALETTE.dark;
  const { tagline, share } = SHELL[locale];

  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: 72, background, color: foreground }}>
      <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
        <Mark fg={foreground} accent={accent} size={88} />
        <div style={{ fontSize: 64, letterSpacing: -1 }}>{SITE.name}</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
        <div style={{ display: "flex", fontSize: 56, lineHeight: 1.15, maxWidth: 940 }}>{`${tagline}.`}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 30, color: muted }}>
          {share.questions.map((q) => (
            <div key={q} style={{ display: "flex", gap: 16 }}>
              <span style={{ color: accent }}>&gt;</span>
              <span>{q}</span>
            </div>
          ))}
        </div>
      </div>
      <div style={{ display: "flex", fontSize: 24, color: muted }}>{share.credit}</div>
    </div>,
    { ...size, fonts: await cardFonts() },
  );
}
