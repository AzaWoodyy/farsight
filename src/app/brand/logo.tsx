/**
 * The mark: the Rift as a minimap between terminal brackets. Top and bottom lanes run along the map's edges,
 * the mid lane crosses it in the accent, the two bases sit in opposite corners. Drawn on a 32 px grid so it
 * stays readable at favicon size.
 */
export function Mark({
  fg = "currentColor",
  accent = "var(--accent)",
  lane = "var(--muted)",
  size = 28,
}: {
  fg?: string;
  accent?: string;
  lane?: string;
  size?: number;
}) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} fill="none" aria-hidden focusable="false">
      <path d="M8.5 4.5H4.25v23H8.5M23.5 4.5h4.25v23H23.5" stroke={fg} strokeWidth="2.5" />
      <path d="M10.5 21.5V10.5h11M10.5 21.5h11V10.5" stroke={lane} strokeWidth="1.75" />
      <path d="M10.5 21.5 21.5 10.5" stroke={accent} strokeWidth="2" />
      <rect x="8.5" y="19.5" width="4" height="4" fill={accent} />
      <rect x="19.5" y="8.5" width="4" height="4" fill={fg} />
    </svg>
  );
}
