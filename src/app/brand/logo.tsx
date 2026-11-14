/**
 * The mark: a terminal prompt, brackets around a cursor block, drawn on a 32 px
 * grid with 2.5 px strokes so it stays sharp at favicon size. The foreground
 * carries the brackets, the accent the cursor.
 */
export function Mark({ fg = "currentColor", accent = "var(--accent)", size = 28 }: { fg?: string; accent?: string; size?: number }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} fill="none" aria-hidden focusable="false">
      <path d="M11.5 4.5H6.25v23h5.25M20.5 4.5h5.25v23H20.5" stroke={fg} strokeWidth="2.5" />
      <rect x="12.5" y="17" width="7" height="7" fill={accent} />
    </svg>
  );
}
