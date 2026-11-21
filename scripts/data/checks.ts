/**
 * What the derived rows must hold before they replace the live data: no row without its parent, no
 * league of the scope without a game, no file `data:fetch` did not save. `db:load` runs them on the rows themselves and
 * refuses a broken or partial ingestion before it writes.
 */
import type { Cell } from "./derive";
import { LEAGUES } from "./scope";

export type DerivedTables = Map<string, { columns: string[]; rows: Cell[][] }>;

/** Summaries the derivation left out or kept incomplete (`report.ingame` of the derivation). */
export type SummaryCounts = { stale_derive: number; older_derive: number };

/** Child rows that must have their parent: [what, child table, child columns, parent table, parent columns]. */
const PARENTS: [string, string, string[], string, string[]][] = [
  ["tournaments without league", "tournaments", ["league_id"], "leagues", ["id"]],
  ["games without tournament", "games", ["tournament_id"], "tournaments", ["id"]],
  ["player lines without game", "game_players", ["game_id"], "games", ["id"]],
  ["player lines without player", "game_players", ["player_id"], "players", ["id"]],
  ["draft rows without champion", "game_draft", ["champion_id"], "champions", ["id"]],
  ["item rows without item", "game_player_items", ["item_id"], "items", ["id"]],
  ["aliases without player", "player_aliases", ["player_id"], "players", ["id"]],
  ["photos without player", "player_images", ["player_id"], "players", ["id"]],
  ["in-game games without game", "game_riot", ["game_id"], "games", ["id"]],
  ["in-game player rows without player line", "game_player_stats", ["game_id", "player_id"], "game_players", ["game_id", "player_id"]],
  ["in-game team rows without game", "game_team_stats", ["game_id"], "game_riot", ["game_id"]],
];

/** What an ingestion that lost a file leaves empty: [table, column or null for "any row", what is missing]. */
const FILLED: [string, string | null, string][] = [
  ["game_riot", null, "no game with in-game stats: data:fetch did not write ingame.jsonl"],
  ["player_images", null, "no player photo: data:fetch did not save player_images.json"],
  ["teams", "short", "no team abbreviation: data:fetch did not save teams.json"],
  ["series_results", null, "no series without a scoreboard: data:fetch did not save schedule.json"],
  ["teams", "logo", "no team logo: data:fetch did not save team_logo_files.json"],
];

/**
 * Every reason not to load these rows. `allowOlder`: summaries of an older, still compatible derivation are accepted
 * (CI loads a pinned snapshot that cannot be recomputed); production recomputes them from R2 and refuses them.
 */
export function datasetProblems(tables: DerivedTables, summaries: SummaryCounts, opts: { allowOlder?: boolean; leagues?: number } = {}): string[] {
  const problems: string[] = [];

  const reader = (name: string, columns: string[]) => {
    const table = tables.get(name);

    if (!table) throw new Error(`The derivation has no table ${name}`);

    const at = columns.map((c) => {
      const i = table.columns.indexOf(c);

      if (i === -1) throw new Error(`The derivation has no column ${name}.${c}`);

      return i;
    });

    return { rows: table.rows, key: (row: Cell[]) => at.map((i) => String(row[i])).join("\u0000") };
  };

  for (const [label, child, childColumns, parent, parentColumns] of PARENTS) {
    const p = reader(parent, parentColumns);
    const known = new Set(p.rows.map(p.key));
    const c = reader(child, childColumns);
    const orphans = c.rows.filter((row) => !known.has(c.key(row))).length;

    if (orphans > 0) problems.push(`${orphans} ${label}`);
  }

  const leagues = reader("leagues", ["id"]);
  const names = reader("leagues", ["name"]);
  const tournaments = reader("tournaments", ["id"]);
  const leagueOf = reader("tournaments", ["league_id"]);
  const leagueOfTournament = new Map(tournaments.rows.map((row) => [tournaments.key(row), leagueOf.key(row)]));
  const games = reader("games", ["tournament_id"]);
  const played = new Set(games.rows.map((row) => leagueOfTournament.get(games.key(row))));
  const empty = leagues.rows.filter((row) => !played.has(leagues.key(row))).map(names.key);
  const expected = opts.leagues ?? LEAGUES.length;

  if (empty.length > 0) problems.push(`leagues without any game: ${empty.join(", ")}`);

  if (leagues.rows.length - empty.length !== expected) problems.push(`${leagues.rows.length - empty.length} leagues with games, scope has ${expected}`);

  // A column the derivation never wrote is not in its table: as empty as a column of NULLs.
  for (const [name, column, missing] of FILLED) {
    const table = tables.get(name);
    const at = column == null ? null : (table?.columns.indexOf(column) ?? -1);

    if (!table?.rows.some((row) => at == null || (at >= 0 && row[at] != null))) problems.push(missing);
  }

  if (summaries.stale_derive > 0) problems.push(`${summaries.stale_derive} summaries use an older DERIVE_VERSION: rerun data:fetch to recompute them from the raw cache`);

  if (summaries.older_derive > 0 && !opts.allowOlder)
    problems.push(`${summaries.older_derive} summaries lack what the current DERIVE_VERSION added: rerun data:fetch to recompute them (or load with --allow-older-summaries)`);

  return problems;
}

/**
 * The players with a photo the new data lacks, as a loss, when more than 2 % of the live ones are gone: a new load may
 * lose a few photos to wiki edits, and a partial PlayerImages fetch keeps every league's counts.
 */
export const photoLoss = (before: number, after: number): string[] => (after * 100 < before * 98 ? [`players with a photo ${before} → ${after}`] : []);
