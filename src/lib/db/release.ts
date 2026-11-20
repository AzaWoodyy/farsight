
/** The UTC day (`YYYY-MM-DD`) of a recorded time, null when it is missing or unreadable. */
export function utcDay(recorded: string | null): string | null {
  const time = recorded ? Date.parse(recorded) : Number.NaN;

  return Number.isNaN(time) ? null : new Date(time).toISOString().slice(0, 10);
}
