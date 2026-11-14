/** Leaguepedia competition history begins in 2011. Upper coverage uses the question clock. */
export const YEAR_MIN = 2011;

export function periodProblem(from: number | null, to: number | null, now: Date): string | null {
  if ([from, to].some((y) => y != null && y < YEAR_MIN)) return `La base commence en ${YEAR_MIN} : cette année est hors couverture.`;

  if ([from, to].some((y) => y != null && y > now.getUTCFullYear())) return `Cette année est future : la couverture s'arrête en ${now.getUTCFullYear()}.`;

  return null;
}
