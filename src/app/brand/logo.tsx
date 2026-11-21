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
      <path d="M7 28V6.75h21" stroke={fg} strokeWidth="5.5" />
      <rect x="14" y="14" width="8.5" height="8.5" rx="1.5" fill={accent} />
    </svg>
  );
}
