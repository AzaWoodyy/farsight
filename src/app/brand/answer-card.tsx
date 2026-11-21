import { ImageResponse } from "next/og";
import type { ShareCard } from "@/lib/agent/share";
import type { Locale } from "../i18n/locales";
import { SHELL } from "../i18n/shell";
import { cardFonts } from "./card-font";
import { Mark } from "./logo";
import { PALETTE, SITE } from "./site";

export const CARD_SIZE = { width: 1200, height: 630 };

const RULE = "#292524";

export async function answerCard(card: ShareCard, locale: Locale) {
  const { background, foreground, muted, accent } = PALETTE.dark;
  const figures = card.duel != null || card.top.length > 0 || card.figures.length > 0;
  const lead = (a: number, b: number) => (a >= b ? accent : foreground);

  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: 64, background, color: foreground }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <Mark fg={foreground} accent={accent} size={48} />
          <div style={{ fontSize: 36, letterSpacing: -0.5 }}>{SITE.name}</div>
        </div>
        <div style={{ display: "flex", fontSize: 24, color: muted }}>{new URL(SITE.url).host}</div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
        <div style={{ display: "flex", gap: 16, fontSize: figures ? 34 : 52, lineHeight: 1.15, color: figures ? muted : foreground }}>
          <span style={{ color: accent }}>&gt;</span>
          <span>{card.heading}</span>
        </div>

        {card.duel && (
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
              <div style={{ display: "flex", flex: 1, fontSize: 48, lineHeight: 1.05 }}>{card.duel.a}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 24, fontSize: 120, letterSpacing: -3 }}>
                <span style={{ color: lead(card.duel.scoreA, card.duel.scoreB) }}>{card.duel.scoreA}</span>
                <span style={{ color: muted, fontSize: 64 }}>–</span>
                <span style={{ color: lead(card.duel.scoreB, card.duel.scoreA) }}>{card.duel.scoreB}</span>
              </div>
              <div style={{ display: "flex", flex: 1, justifyContent: "flex-end", fontSize: 48, lineHeight: 1.05, textAlign: "right" }}>{card.duel.b}</div>
            </div>
            <div style={{ display: "flex", justifyContent: "center", fontSize: 28, color: muted }}>{card.duel.caption}</div>
          </div>
        )}

        {card.top.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {card.top.map((row, i) => (
              <div key={row.name} style={{ display: "flex", alignItems: "center", gap: 24, fontSize: i === 0 ? 60 : 40, color: i === 0 ? foreground : muted, borderBottom: `1px solid ${RULE}`, paddingBottom: 12 }}>
                <span style={{ color: accent, width: 56 }}>{row.rank}</span>
                {/* oxlint-disable-next-line nextjs/no-img-element */}
                {row.icon && <img src={row.icon} width={i === 0 ? 72 : 52} height={i === 0 ? 72 : 52} alt="" style={{ borderRadius: 8 }} />}
                <div style={{ display: "block", flex: 1, lineClamp: 1 }}>{row.name}</div>
                <span>{row.value}</span>
                <span style={{ fontSize: i === 0 ? 34 : 26, color: muted }}>{card.metric}</span>
              </div>
            ))}
          </div>
        )}

        {card.figures.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", columnGap: 56, rowGap: 20 }}>
            {card.figures.map((f) => (
              <div key={f.label} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={{ fontSize: 56, letterSpacing: -1 }}>{f.value}</span>
                <span style={{ fontSize: 26, color: muted }}>{f.label}</span>
              </div>
            ))}
          </div>
        )}

        {!figures && <div style={{ display: "flex", fontSize: 32, lineHeight: 1.3, color: muted }}>{card.line}</div>}
      </div>

      <div style={{ display: "flex", fontSize: 22, color: muted }}>{SHELL[locale].share.credit}</div>
    </div>,
    { ...CARD_SIZE, fonts: await cardFonts() },
  );
}
