import { msg } from "../agent/messages";

export const YEAR_MIN = 2011;

export function periodProblem(from: number | null, to: number | null, now: Date): string | null {
  if ([from, to].some((y) => y != null && y < YEAR_MIN)) return msg().period.before(YEAR_MIN);

  if ([from, to].some((y) => y != null && y > now.getUTCFullYear())) return msg().period.future(now.getUTCFullYear());

  return null;
}
