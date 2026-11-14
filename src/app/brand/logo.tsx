/**
 * The mark: the L of League, drawn by the top and bottom lanes leaving the base in the corner, with the enemy
 * nexus in the accent in the opposite corner. Two shapes on a 32 px grid so it stays readable at favicon size.
 */
export function Mark({
  fg = "currentColor",
  accent = "var(--accent)",
  size = 28,
}: {
  fg?: string;
  accent?: string;
  size?: number;
}) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} fill="none" aria-hidden focusable="false">
      <path d="M7 4v21h21" stroke={fg} strokeWidth="5.5" />
      <rect x="18.5" y="4" width="9.5" height="9.5" rx="1.5" fill={accent} />
    </svg>
  );
}
