import type { ThemeName } from "./site";

/**
 * The three candidate marks, drawn on a 32 px grid with 2.5 px strokes so they
 * stay sharp at favicon size. The foreground carries the outline, the accent
 * one detail.
 *   minimap  the Rift seen from above: the map frame, the mid lane, both bases
 *   ambre    a terminal prompt: brackets around a cursor block
 *   baron    the Baron pit as an octagon around a prompt chevron
 */
export function Mark({ name, fg = "currentColor", accent = "var(--accent)", size = 28 }: { name: ThemeName; fg?: string; accent?: string; size?: number }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} fill="none" aria-hidden focusable="false">
      {name === "minimap" && (
        <>
          <rect x="3.25" y="3.25" width="25.5" height="25.5" rx="3" stroke={fg} strokeWidth="2.5" />
          <path d="M10 22 22 10" stroke={accent} strokeWidth="2.5" strokeLinecap="square" />
          <rect x="6.5" y="20.5" width="5" height="5" fill={accent} />
          <rect x="20.5" y="6.5" width="5" height="5" fill={fg} />
        </>
      )}
      {name === "ambre" && (
        <>
          <path d="M11.5 4.5H6.25v23h5.25M20.5 4.5h5.25v23H20.5" stroke={fg} strokeWidth="2.5" />
          <rect x="12.5" y="17" width="7" height="7" fill={accent} />
        </>
      )}
      {name === "baron" && (
        <>
          <path d="M11 3.25h10L28.75 11v10L21 28.75H11L3.25 21V11Z" stroke={fg} strokeWidth="2.5" strokeLinejoin="round" />
          <path d="m10.5 11 5.5 5-5.5 5" stroke={accent} strokeWidth="2.5" />
          <path d="M17.5 22h5" stroke={accent} strokeWidth="2.5" />
        </>
      )}
    </svg>
  );
}
