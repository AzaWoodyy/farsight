import { ImageResponse } from "next/og";
import { Mark } from "./brand/logo";
import { SITE } from "./brand/site";

export const alt = `${SITE.name} : ${SITE.tagline}`;

export const size = { width: 1200, height: 630 };

export const contentType = "image/png";

const QUESTIONS = ["Faker contre Chovy", "Stats d'Azir aux Worlds 2025", "Champions les plus bannis en LCK 2025"];

/** Share card: the mark and name, the tagline, and three real questions, in the default direction's dark palette. */
export default function OpenGraphImage() {
  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: 72, background: "#0a1214", color: "#e2eaec" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
        <Mark name="minimap" fg="#e2eaec" accent="#2dd4bf" size={88} />
        <div style={{ fontSize: 64, fontWeight: 700, letterSpacing: -1 }}>{SITE.name}</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
        <div style={{ display: "flex", fontSize: 56, lineHeight: 1.15, maxWidth: 940 }}>{`${SITE.tagline}.`}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 30, color: "#93a4a9" }}>
          {QUESTIONS.map((q) => (
            <div key={q} style={{ display: "flex", gap: 16 }}>
              <span style={{ color: "#2dd4bf" }}>&gt;</span>
              <span>{q}</span>
            </div>
          ))}
        </div>
      </div>
      <div style={{ display: "flex", fontSize: 24, color: "#93a4a9" }}>Données Leaguepedia et Riot Data Dragon · lolesport.enzoneault.dev</div>
    </div>,
    size,
  );
}
