import { type CargoValue, FILES_PER_REQUEST, wikiFiles } from "../../src/lib/sources/leaguepedia";
import { teamIdentity } from "./identity";

type Row = Readonly<Record<string, CargoValue | undefined>>;

const text = (v: CargoValue | undefined) => (v == null || v === "" ? null : String(v).trim() || null);

export function fileTitle(name: string): string {
  const spaced = name.replace(/_/g, " ").replace(/\s+/g, " ").trim();

  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function logoCandidates(name: string, page: string | null): string[] {
  return [...new Set([name, ...(page ? [page] : [])].map((n) => fileTitle(`${n}logo square.png`)))];
}

export function teamPageOf(teams: Row[], redirects: Row[]): (name: string) => string | null {
  const pages = new Set(teams.flatMap((r) => text(r.Page) ?? []));
  const byCase = new Map<string, Set<string>>();
  const byRedirect = new Map<string, Set<string>>();
  const add = (index: Map<string, Set<string>>, key: string, page: string) => index.set(key, (index.get(key) ?? new Set()).add(page));

  for (const page of pages) add(byCase, page.toLowerCase(), page);

  for (const r of redirects) {
    const name = text(r.AllName);
    const page = text(r.Page);

    if (name && page) add(byRedirect, name.toLowerCase(), page);
  }

  const only = (found: Set<string> | undefined) => (found?.size === 1 ? [...found][0] : null);

  return (name) => {
    if (pages.has(name)) return name;
    const key = name.toLowerCase();

    return byCase.has(key) ? only(byCase.get(key)) : only(byRedirect.get(key));
  };
}

export function logoCandidatesOf(teams: Row[], redirects: Row[]): (name: string) => string[] {
  const pageOf = teamPageOf(teams, redirects);

  return (name) => logoCandidates(name, pageOf(name));
}

export function chooseLogo(candidates: string[], files: ReadonlyMap<string, string>): string | null {
  for (const c of candidates) {
    const file = files.get(c);

    if (file) return file;
  }

  return null;
}

const TEAM_FIELDS = ["Team", "Team1", "Team2"] as const;

export async function fetchTeamLogoFiles(
  rows: Row[],
  teams: { teams: Row[]; redirects: Row[] },
  files: (names: string[]) => Promise<Map<string, string | null>> = wikiFiles,
): Promise<{ Asked: string; File: string }[]> {
  const stored = teamIdentity(teams.teams.flatMap((r) => text(r.Page) ?? []));
  const candidates = logoCandidatesOf(teams.teams, teams.redirects);
  const names = new Set(rows.flatMap((r) => TEAM_FIELDS.flatMap((f) => text(r[f]) ?? [])).flatMap((n) => [n, stored(n)]));
  const todo = [...new Set([...names].flatMap(candidates))].toSorted();
  const found: { Asked: string; File: string }[] = [];
  let unanswered = 0;

  for (let i = 0; i < todo.length; i += FILES_PER_REQUEST) {
    const batch = todo.slice(i, i + FILES_PER_REQUEST);
    let answers = await files(batch);
    const again = batch.filter((n) => !answers.has(n));

    if (again.length) answers = new Map([...answers, ...(await files(again))]);

    for (const asked of batch) {
      const file = answers.get(asked);

      if (file) found.push({ Asked: asked, File: file });
      else if (file === undefined) unanswered++;
    }
  }

  console.log(`team logo files: ${todo.length} files asked for ${names.size} team names, ${found.length} found${unanswered ? `, ${unanswered} never answered (no logo)` : ""}`);

  return found;
}
