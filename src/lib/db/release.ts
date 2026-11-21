export function utcDay(recorded: string | null): string | null {
  const time = recorded ? Date.parse(recorded) : Number.NaN;

  return Number.isNaN(time) ? null : new Date(time).toISOString().slice(0, 10);
}
