/**
 * Team logos at ingestion: the logo file of each team name, the file name only (fair use, see
 * src/lib/domain/wiki-images.ts). Leaguepedia names a team's square logo "<page>logo square.png", and an older name
 * keeps the file of its time under its own name ("Afreeca Freecslogo square.png"). Cargo `Teams.Image` is the
 * infobox image, often the wide "logo profile" one: never used.
 *
 * `data:fetch` asks the wiki which of these files exist (`wikiFiles`, 50 names per request) and saves the exact name of
 * each one found in `team_logo_files.json`; `data:build` gives each team the first one found (`teams.logo`).
 */
import { type CargoValue, FILES_PER_REQUEST, wikiFiles } from "../../src/lib/sources/leaguepedia";
import { teamIdentity } from "./identity";

/** A row of a Cargo table, fetched or read back from the raw cache. */
type Row = Readonly<Record<string, CargoValue | undefined>>;

const text = (v: CargoValue | undefined) => (v == null || v === "" ? null : String(v).trim() || null);

/** A wiki file name as the wiki writes its titles: spaces for underscores, a capital first letter. */
export function fileTitle(name: string): string {
  const spaced = name.replace(/_/g, " ").replace(/\s+/g, " ").trim();

  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** The files that may be a team name's logo, best first: its own square logo, then its page's. */
export function logoCandidates(name: string, page: string | null): string[] {
  return [...new Set([name, ...(page ? [page] : [])].map((n) => fileTitle(`${n}logo square.png`)))];
}

/**
 * The team page of a name, from the Cargo tables `Teams` (Page) and `TeamRedirects` (AllName, Page): the page of that
 * name, else the one page at another case, else the one page the name redirects to. A name that leads to two pages
 * ("Nova Esports" for the Thai and the Taiwanese team) has none: no logo rather than another team's.
 */
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

    // A name at another case than two pages is ambiguous: it does not fall through to a redirect.
    return byCase.has(key) ? only(byCase.get(key)) : only(byRedirect.get(key));
  };
}

/** The candidates of every team name, from the Cargo tables `Teams` and `TeamRedirects`. */
export function logoCandidatesOf(teams: Row[], redirects: Row[]): (name: string) => string[] {
  const pageOf = teamPageOf(teams, redirects);

  return (name) => logoCandidates(name, pageOf(name));
}

/**
 * The first candidate the wiki has, under the exact name it stores it (the CDN path is built from that name); null when
 * it has none. `files`: each file name asked -> its exact name, for the files found.
 */
export function chooseLogo(candidates: string[], files: ReadonlyMap<string, string>): string | null {
  for (const c of candidates) {
    const file = files.get(c);

    if (file) return file;
  }

  return null;
}

/** The fields of the fetched rows that hold a team name (results, games, player lines, schedule). */
const TEAM_FIELDS = ["Team", "Team1", "Team2"] as const;

/**
 * Asks the wiki which logo files of the teams these rows name exist: every candidate of every name, as written and as
 * `data:build` will store it (the case of its page), FILES_PER_REQUEST per request. Nothing is kept between runs: about
 * 2 000 names, some forty requests. Returns the rows of `team_logo_files.json`: each file found, as asked (`Asked`) and
 * under its exact name (`File`).
 */
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
    // A name left unanswered (an API size limit) is asked once more on its own request.
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
