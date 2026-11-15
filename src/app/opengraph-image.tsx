import { ImageResponse } from "next/og";
import { Mark } from "./brand/logo";
import { PALETTE, SITE } from "./brand/site";

export const alt = `${SITE.name} : ${SITE.tagline}`;

export const size = { width: 1200, height: 630 };

export const contentType = "image/png";

const QUESTIONS = ["Faker contre Chovy", "Stats d'Azir aux Worlds 2025", "Champions les plus bannis en LCK 2025"];

/** Share card: the mark and name, the tagline, and three real questions, on the dark palette. */
export default function OpenGraphImage() {
  const { background, foreground, muted, accent } = PALETTE.dark;

  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: 72, background, color: foreground }}>
      <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
        <Mark fg={foreground} accent={accent} size={88} />
        <div style={{ fontSize: 64, letterSpacing: -1 }}>{SITE.name}</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
        <div style={{ display: "flex", fontSize: 56, lineHeight: 1.15, maxWidth: 940 }}>{`${SITE.tagline}.`}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 30, color: muted }}>
          {QUESTIONS.map((q) => (
            <div key={q} style={{ display: "flex", gap: 16 }}>
              <span style={{ color: accent }}>&gt;</span>
              <span>{q}</span>
            </div>
          ))}
        </div>
      </div>
      <div style={{ display: "flex", fontSize: 24, color: muted }}>Données Leaguepedia et Riot Data Dragon · farsight.enzoneault.dev</div>
    </div>,
    size,
  );
}
