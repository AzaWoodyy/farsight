import type { DatabaseSync } from "node:sqlite";
import { type StaticToolCall, tool } from "ai";
import { z } from "zod";
import { selectAll, selectOne, type SqlRow } from "../db";
import { DDRAGON_BASE } from "../sources/ddragon";
import { wikiUrl } from "../sources/leaguepedia";
import { type Entities, LEAGUE_NAMES, type ResultRow, type Source, type TableCell, type ToolName } from "./types";
import { resolveChampion, resolvePlayer, resolveTeam } from "./understand";

/**
 * Typed tools: one parameterized query per frequent intent, each with a zod
 * input schema (shared with the LLM router through AI SDK `tool()`), its own
 * deterministic corrections and its own formatting. Every query still goes
 * through the schema guard before it runs.
 */

/**
 * Stages that belong to the competition itself. Regional qualifiers share the
 * `World Championship` / `Mid-Season Invitational` league label on
 * Leaguepedia, and `event` pages only hold standings, so both are excluded.
 */
const COMPETITION_STAGES = "'main_event', 'play_in', 'season', 'playoffs'";

/** Pages that carry final standings. */
const STANDINGS_STAGES = "'event', 'main_event', 'season', 'playoffs'";

const League = z.enum(LEAGUE_NAMES).describe("Leaguepedia League value. Worlds = World Championship, LCK = LoL Champions Korea.");
const Year = z.number().int().min(2011).max(2030).nullable();
const Period = { yearFrom: Year.describe("First season (inclusive), null for all"), yearTo: Year.describe("Last season (inclusive), null for all") };

export const PlayerHistoryInput = z.object({
  player: z.string().min(1).describe("Player handle or Leaguepedia page (Chovy, Faker, 정지훈...)"),
  league: League,
  ...Period,
});

export const TeamHistoryInput = z.object({
  team: z.string().min(1).describe("Team name or shorthand (T1, Gen.G, G2...)"),
  league: League.nullable().describe("Restrict to one competition, null for all"),
  ...Period,
});

export const HeadToHeadInput = z.object({
  kind: z.enum(["team", "player"]),
  sideA: z.string().min(1),
  sideB: z.string().min(1),
  league: League.nullable(),
  ...Period,
});

export const ChampionStatsInput = z.object({
  champion: z.string().min(1).describe("Champion name (Ahri, Lee Sin, Kai'Sa...)"),
  league: League,
  ...Period,
});

export const StandingsInput = z.object({
  league: League,
  ...Period,
  split: z.enum(["Spring", "Summer", "Winter"]).nullable(),
  full: z.boolean().describe("true: every placement of the event(s); false: champion and finalist of each event"),
});

export type PlayerHistoryInput = z.infer<typeof PlayerHistoryInput>;

export type TeamHistoryInput = z.infer<typeof TeamHistoryInput>;

export type HeadToHeadInput = z.infer<typeof HeadToHeadInput>;

export type ChampionStatsInput = z.infer<typeof ChampionStatsInput>;

export type StandingsInput = z.infer<typeof StandingsInput>;

/** A typed tool with its input, as decided by the router (rules or LLM). */
export type ToolCall =
  | { tool: "player_event_history"; input: PlayerHistoryInput }
  | { tool: "team_history"; input: TeamHistoryInput }
  | { tool: "head_to_head"; input: HeadToHeadInput }
  | { tool: "champion_event_stats"; input: ChampionStatsInput }
  | { tool: "tournament_standings"; input: StandingsInput };

export type ToolInput = ToolCall["input"];

type Params = Record<string, string | number>;

type Plan = { sql: string; params: Params };

type Relaxation<I> = { key: string; input: I; note: string; reason: string };

export type ToolOutput = {
  title: string;
  rows?: ResultRow[];
  table?: { columns: string[]; rows: TableCell[][] };
  facts: string;
  sources: Source[];
  followUps: string[];
  totals: Record<string, string | number>;
};

type ToolDef<I extends ToolInput> = {
  name: ToolName;
  /** French label, shown in the trace. */
  label: string;
  description: string;
  plan: (db: DatabaseSync, input: I) => Plan;
  /** Deterministic corrections when the result is empty, most conservative first. */
  relaxations: (input: I, entities: Entities) => Relaxation<I>[];
  format: (db: DatabaseSync, input: I, rows: SqlRow[]) => ToolOutput;
  /** Maps names written by the LLM onto database names. */
  normalize: (db: DatabaseSync, input: I) => I | null;
};

/** A tool bound to its input: the plan to run, its corrections and its formatting. */
export type BoundTool = {
  call: ToolCall;
  label: string;
  sql: string;
  params: Params;
  relaxations: (entities: Entities) => { key: string; note: string; reason: string; next: () => BoundTool }[];
  format: (db: DatabaseSync, rows: SqlRow[]) => ToolOutput;
};

// Helpers -------------------------------------------------------------------------

function inList(prefix: string, values: string[], params: Params): string {
  return values
    .map((v, i) => {
      params[`${prefix}${i}`] = v;

      return `:${prefix}${i}`;
    })
    .join(", ");
}

type Period = { yearFrom: number | null; yearTo: number | null };

function periodFilter(col: string, input: Period, params: Params): string {
  const parts: string[] = [];

  if (input.yearFrom != null) {
    parts.push(`AND ${col} >= :yearFrom`);
    params.yearFrom = input.yearFrom;
  }

  if (input.yearTo != null) {
    parts.push(`AND ${col} <= :yearTo`);
    params.yearTo = input.yearTo;
  }

  return parts.join(" ");
}

/** A JSON text column (json_group_array...) parsed with its own schema. */
const jsonColumn = <S extends z.ZodType>(schema: S) => z.string().transform((text) => schema.parse(JSON.parse(text)));

/** SQLite integers come back as numbers; a missing year sorts first. */
const YearColumn = z.number().catch(0);

const PlayerCounts = z.array(z.object({ player: z.string(), games: z.number() }));

const tidy = (sql: string) => sql.replace(/\n\s*\n/g, "\n");
const hasPeriod = (i: Period) => i.yearFrom != null || i.yearTo != null;

const noPeriod = <I extends Period>(input: I, what: string): Relaxation<I> => ({
  key: "period",
  input: { ...input, yearFrom: null, yearTo: null },
  note: `Rien entre ${input.yearFrom ?? "…"} et ${input.yearTo ?? "…"} : affichage de ${what}.`,
  reason: "filtre de période retiré",
});

export const displayTeam = (team: string) => team.replace(/\s*\(.*?\)\s*$/, "");
const pct = (w: number, n: number) => Math.round((100 * w) / Math.max(1, n));
const span = (years: number[]) => (years.length ? `${Math.min(...years)}–${Math.max(...years)}` : "");

export function placeLabel(place: string | null, stage?: string | null): string {
  if (!place) return "Classement non publié";

  // Regular-season standings are not a title.
  if (stage === "season") return place === "1" ? "1er de la saison régulière" : `${place}e de la saison régulière`;

  if (place === "1") return "Champion";

  if (place === "2") return "Finaliste";

  if (place === "3-4") return "Demi-finale";

  if (place === "5-8") return "Quart de finale";

  return `Éliminé (${place}e)`;
}

function leagueShortName(db: DatabaseSync, league: string | null): string {
  if (!league) return "toutes compétitions";

  return selectOne(db, z.object({ short_name: z.string() }), "SELECT short_name FROM leagues WHERE name = ?", [league])?.short_name ?? league;
}

const inLeague = (short: string) => (short === "Worlds" ? "aux Worlds" : short === "toutes compétitions" ? "" : `en ${short}`);

function eventSources(pages: string[], max = 12): Source[] {
  const unique = [...new Set(pages)];

  return unique.slice(-max).map((page) => ({ label: `Leaguepedia — ${page}`, url: wikiUrl(page) }));
}

function teamMembers(db: DatabaseSync, team: string): { team: string; members: string[] } {
  const t = resolveTeam(db, team);

  return t ? { team: t.team, members: t.members } : { team, members: [team] };
}

// Result rows, as each tool's query returns them ----------------------------------------

const Text = z.string();
const NullableText = z.string().nullable();

const PlayerHistoryRow = z.object({
  year: YearColumn,
  event_page: Text,
  team: Text,
  stage: NullableText,
  wins: z.number(),
  losses: z.number(),
  place: NullableText,
  place_number: z.number().nullable(),
  champions: jsonColumn(
    z.array(z.object({ name: z.string(), games: z.number(), wins: z.number(), icon: z.string().nullable() })),
  ),
});

const TeamHistoryRow = z.object({
  year: YearColumn,
  league_short: Text,
  event_page: Text,
  stage: NullableText,
  tournament: NullableText,
  team: Text,
  wins: z.number(),
  losses: z.number(),
  place: NullableText,
  place_number: z.number().nullable(),
});

const HeadToHeadRow = z.object({
  year: YearColumn,
  league_short: Text,
  event_page: Text,
  tournament: NullableText,
  wins_a: z.number(),
  wins_b: z.number(),
});

const ChampionStatsRow = z.object({
  year: YearColumn,
  league_short: Text,
  event_page: Text,
  tournament: NullableText,
  games: z.number(),
  picks: z.number(),
  wins: z.number(),
  bans: z.number(),
  players: jsonColumn(PlayerCounts),
});

const StandingsRow = z.object({
  year: YearColumn,
  event_page: Text,
  tournament: NullableText,
  stage: NullableText,
  place: NullableText,
  place_number: z.number().nullable(),
  team: Text,
  prize_usd: z.number().nullable(),
});

// 1. Player history in a competition ------------------------------------------------

const playerEventHistory: ToolDef<PlayerHistoryInput> = {
  name: "player_event_history",
  label: "historique joueur × compétition",
  description:
    "A player's results in one competition, edition by edition: team, final place, game record (W-L) and champions played.",
  plan: (_db, input) => {
    const params: Params = {};

    Object.assign(params, { player: input.player, league: input.league });

    const period = periodFilter("gp.year", input, params);

    return {
      params,
      sql: tidy(`WITH player_games AS (
  SELECT gp.year, gp.event_page, gp.stage, gp.team, gp.champion, gp.win
  FROM v_game_players gp
  WHERE gp.player = :player
    AND gp.league = :league
    AND gp.stage IN (${COMPETITION_STAGES})
    ${period}
),
champ_counts AS (
  SELECT event_page, team, champion, COUNT(*) AS games, SUM(win) AS wins
  FROM player_games
  GROUP BY event_page, team, champion
)
SELECT pg.year, pg.event_page, pg.team, MIN(pg.stage) AS stage,
       SUM(pg.win) AS wins,
       COUNT(*) - SUM(pg.win) AS losses,
       tr.place, tr.place_number,
       (SELECT json_group_array(json_object('name', c.champion, 'games', c.games, 'wins', c.wins,
                                            'icon', ch.icon_url)
                ORDER BY c.games DESC, c.wins DESC, c.champion)
          FROM champ_counts c LEFT JOIN champions ch ON ch.name = c.champion
         WHERE c.event_page = pg.event_page AND c.team = pg.team) AS champions
FROM player_games pg
LEFT JOIN v_tournament_results tr
  ON tr.event_page = pg.event_page AND tr.team = pg.team
GROUP BY pg.year, pg.event_page, pg.team
ORDER BY pg.year, MIN(pg.event_page)`),
    };
  },
  relaxations: (input, entities) => {
    const out: Relaxation<typeof input>[] = [];

    if (hasPeriod(input)) out.push(noPeriod(input, "toutes les éditions"));
    const resolved = entities.players.find((p) => p.player === input.player || p.otherCandidates.includes(input.player));

    for (const other of resolved ? [resolved.player, ...resolved.otherCandidates] : [])
      if (other !== input.player)
        out.push({
          key: `player:${other}`,
          input: { ...input, player: other },
          note: `« ${resolved!.mention} » désigne aussi ${other} : résultats de ${other}.`,
          reason: `alias homonyme essayé : ${other}`,
        });

    return out;
  },
  format: (db, input, raw): ToolOutput => {
    const league = leagueShortName(db, input.league);

    const rows: ResultRow[] = z.array(PlayerHistoryRow).parse(raw).map((r) => ({
      year: r.year,
      event: r.event_page,
      team: r.team,
      place: r.place,
      placeLabel: placeLabel(r.place, r.stage),
      // Regular-season ranks do not compete with final placements.
      placeNumber: r.stage === "season" ? null : r.place_number,
      wins: r.wins,
      losses: r.losses,
      champions: r.champions.map(({ icon, ...c }) => ({ ...c, imageUrl: icon })),
    }));

    const wins = rows.reduce((n, r) => n + r.wins, 0);
    const losses = rows.reduce((n, r) => n + r.losses, 0);
    const teams = [...new Set(rows.map((r) => displayTeam(r.team)))];
    const ranked = rows.filter((r) => r.placeNumber != null);
    const best = ranked.length ? Math.min(...ranked.map((r) => r.placeNumber!)) : null;
    const bestRows = ranked.filter((r) => r.placeNumber === best);
    const unranked = rows.filter((r) => r.place == null);
    const titles = rows.filter((r) => r.placeNumber === 1).length;
    const events = new Set(rows.map((r) => r.event)).size;

    let facts =
      `${input.player} a disputé ${events} éditions ${league === "Worlds" ? "des Worlds" : `de ${league}`} (${span(rows.map((r) => r.year))}) ` +
      `avec ${teams.length} équipe${teams.length > 1 ? "s" : ""} (${teams.join(", ")}), ` +
      `pour un bilan de ${wins} victoires et ${losses} défaites en parties (${pct(wins, wins + losses)} %).`;

    if (bestRows.length)
      facts += ` Meilleur résultat : ${placeLabel(bestRows[0].place).toLowerCase()} en ${bestRows
        .map((r) => `${r.year} (${displayTeam(r.team)})`)
        .join(", ")}.`;

    if (unranked.length) facts += ` Classement final ${unranked.map((r) => r.year).join(", ")} pas encore publié sur Leaguepedia.`;

    // Follow-ups stay within what the agent supports: teammates of the latest run.
    const latest = rows[rows.length - 1];

    const teammates = selectAll(
      db,
      z.object({ player: z.string() }),
      `SELECT player, COUNT(*) AS n FROM v_game_players
       WHERE event_page = ? AND team = ? AND player <> ? AND stage <> 'qualifier'
       GROUP BY player ORDER BY n DESC LIMIT 2`,
      [latest.event, latest.team, input.player],
    ).map((r) => r.player);

    return {
      title: `${input.player} — ${league}`,
      rows,
      facts,
      sources: [
        { label: `Leaguepedia — ${input.player}`, url: wikiUrl(input.player) },
        ...eventSources(rows.map((r) => r.event), 30),
        { label: "Riot Data Dragon — champions", url: `${DDRAGON_BASE}/api/versions.json` },
      ],
      followUps: [
        `${input.player} ${inLeague(league)} ${bestRows[0]?.year ?? latest.year}`,
        ...teammates.map((m) => `Résultats de ${m} ${league === "Worlds" ? "à tous les Worlds" : inLeague(league)}`),
      ],
      totals: { events, wins, losses, titles, best_place: bestRows[0]?.place ?? "" },
    };
  },
  normalize: (db, input) => {
    const p = resolvePlayer(db, input.player, { league: input.league, yearFrom: input.yearFrom, yearTo: input.yearTo });

    return p ? { ...input, player: p.player } : null;
  },
};

// 2. Team history -------------------------------------------------------------------

const teamHistory: ToolDef<TeamHistoryInput> = {
  name: "team_history",
  label: "historique d'équipe",
  description:
    "A team's history tournament by tournament (all competitions or one): final place and game record. Renamed teams are merged (SK Telecom T1 → T1).",
  plan: (db, input) => {
    const { members } = teamMembers(db, input.team);
    const params: Params = {};
    const t = inList("t", members, params);
    let league = "";

    if (input.league) {
      league = "AND g.league = :league";
      params.league = input.league;
    }

    return {
      params,
      sql: tidy(`WITH team_games AS (
  SELECT g.year, g.league_short, g.event_page, g.stage, g.tournament, g.played_at,
         CASE WHEN g.blue_team IN (${t}) THEN g.blue_team ELSE g.red_team END AS team,
         CASE WHEN g.winner IN (${t}) THEN 1 ELSE 0 END AS win
  FROM v_games g
  WHERE (g.blue_team IN (${t}) OR g.red_team IN (${t}))
    AND g.stage IN (${COMPETITION_STAGES})
    ${league}
    ${periodFilter("g.year", input, params)}
)
SELECT tg.year, tg.league_short, tg.event_page, MIN(tg.stage) AS stage,
       COALESCE(tr.tournament, MIN(tg.tournament)) AS tournament, tg.team,
       SUM(tg.win) AS wins, COUNT(*) - SUM(tg.win) AS losses,
       tr.place, tr.place_number
FROM team_games tg
LEFT JOIN v_tournament_results tr ON tr.event_page = tg.event_page AND tr.team = tg.team
GROUP BY tg.year, tg.event_page, tg.team
ORDER BY tg.year, MIN(tg.played_at), tg.event_page`),
    };
  },
  relaxations: (input) => {
    const out: Relaxation<typeof input>[] = [];

    if (hasPeriod(input)) out.push(noPeriod(input, "toute son histoire"));

    if (input.league)
      out.push({
        key: "league",
        input: { ...input, league: null, yearFrom: null, yearTo: null },
        note: `Aucune partie de ${input.team} dans cette compétition : affichage de toutes les compétitions.`,
        reason: "filtre de compétition retiré",
      });

    return out;
  },
  format: (db, input, sqlRows): ToolOutput => {
    const raw = z.array(TeamHistoryRow).parse(sqlRows);
    const { team, members } = teamMembers(db, input.team);
    const league = leagueShortName(db, input.league);
    const wins = raw.reduce((n, r) => n + Number(r.wins), 0);
    const losses = raw.reduce((n, r) => n + Number(r.losses), 0);
    const titles = raw.filter((r) => r.place === "1" && r.stage !== "season");
    const leagues = [...new Set(raw.map((r) => String(r.league_short)))];
    const names = [...new Set(raw.map((r) => String(r.team)))];
    const intl = titles.filter((r) => r.league_short === "Worlds" || r.league_short === "MSI");

    let facts =
      `${team} : ${raw.length} tournois ${inLeague(league) || `(${leagues.join(", ")})`} entre ${span(raw.map((r) => Number(r.year))).replace("–", " et ")}, ` +
      `${wins} victoires et ${losses} défaites en parties (${pct(wins, wins + losses)} %). ` +
      `${titles.length} titre${titles.length > 1 ? "s" : ""}`;

    if (intl.length) facts += `, dont ${intl.map((r) => r.tournament ?? r.event_page).join(", ")}`;
    facts += ".";

    if (names.length > 1) facts += ` Noms pris en compte : ${names.map(displayTeam).join(", ")}.`;

    return {
      title: `${team} — ${league === "toutes compétitions" ? "historique" : league}`,
      table: {
        columns: ["Année", "Compétition", "Tournoi", ...(names.length > 1 ? ["Équipe"] : []), "Place", "V-D", "%"],
        rows: raw.map((r) => [
          r.year,
          r.league_short,
          r.tournament ?? r.event_page,
          ...(names.length > 1 ? [displayTeam(r.team)] : []),
          r.place ? `${placeLabel(r.place, r.stage)} (${r.place})` : placeLabel(null),
          `${r.wins}-${r.losses}`,
          pct(r.wins, r.wins + r.losses),
        ]),
      },
      facts,
      sources: [
        ...members.map((m) => ({ label: `Leaguepedia — ${m}`, url: wikiUrl(m) })),
        ...eventSources([...titles.map((r) => String(r.event_page)), ...raw.slice(-8).map((r) => String(r.event_page))], 20),
      ],
      followUps: [
        input.league ? `Historique de ${team}` : `${team} aux Worlds`,
        `Palmarès ${league === "toutes compétitions" ? "des Worlds" : league}`,
      ],
      totals: { events: raw.length, wins, losses, titles: titles.length },
    };
  },
  normalize: (db, input) => (resolveTeam(db, input.team) ? input : null),
};

// 3. Head-to-head -------------------------------------------------------------------

const headToHead: ToolDef<HeadToHeadInput> = {
  name: "head_to_head",
  label: "confrontations",
  description:
    "Games between two teams, or between two players on opposing teams, tournament by tournament (wins of each side).",
  plan: (db, input) => {
    const params: Params = {};
    const filters: string[] = [];

    if (input.kind === "player") {
      params.a = input.sideA;
      params.b = input.sideB;

      if (input.league) {
        filters.push("AND a.league = :league");
        params.league = input.league;
      }

      return {
        params,
        sql: tidy(`SELECT a.year, a.league_short, a.event_page, MIN(a.tournament) AS tournament,
       SUM(a.win) AS wins_a, COUNT(*) - SUM(a.win) AS wins_b
FROM v_game_players a
JOIN v_game_players b ON b.game_id = a.game_id AND b.team <> a.team
WHERE a.player = :a AND b.player = :b
  AND a.stage IN (${COMPETITION_STAGES})
  ${filters.join(" ")}
  ${periodFilter("a.year", input, params)}
GROUP BY a.year, a.event_page
ORDER BY a.year, MIN(a.played_at), a.event_page`),
      };
    }

    const A = inList("a", teamMembers(db, input.sideA).members, params);
    const B = inList("b", teamMembers(db, input.sideB).members, params);

    if (input.league) {
      filters.push("AND g.league = :league");
      params.league = input.league;
    }

    return {
      params,
      sql: tidy(`SELECT g.year, g.league_short, g.event_page, MIN(g.tournament) AS tournament,
       SUM(CASE WHEN g.winner IN (${A}) THEN 1 ELSE 0 END) AS wins_a,
       SUM(CASE WHEN g.winner IN (${B}) THEN 1 ELSE 0 END) AS wins_b
FROM v_games g
WHERE ((g.blue_team IN (${A}) AND g.red_team IN (${B})) OR (g.blue_team IN (${B}) AND g.red_team IN (${A})))
  AND g.stage IN (${COMPETITION_STAGES})
  ${filters.join(" ")}
  ${periodFilter("g.year", input, params)}
GROUP BY g.year, g.event_page
ORDER BY g.year, MIN(g.played_at), g.event_page`),
    };
  },
  relaxations: (input) => {
    const out: Relaxation<typeof input>[] = [];

    if (hasPeriod(input)) out.push(noPeriod(input, "toutes les années"));

    if (input.league)
      out.push({
        key: "league",
        input: { ...input, league: null, yearFrom: null, yearTo: null },
        note: "Aucune confrontation dans cette compétition : affichage de toutes les compétitions.",
        reason: "filtre de compétition retiré",
      });

    return out;
  },
  format: (db, input, sqlRows): ToolOutput => {
    const raw = z.array(HeadToHeadRow).parse(sqlRows);
    const a = input.kind === "team" ? teamMembers(db, input.sideA) : { team: input.sideA, members: [input.sideA] };
    const b = input.kind === "team" ? teamMembers(db, input.sideB) : { team: input.sideB, members: [input.sideB] };
    const winsA = raw.reduce((n, r) => n + Number(r.wins_a), 0);
    const winsB = raw.reduce((n, r) => n + Number(r.wins_b), 0);
    const league = leagueShortName(db, input.league);
    const last = raw[raw.length - 1];
    const leader = winsA === winsB ? "à égalité" : `avantage ${winsA > winsB ? a.team : b.team}`;

    const facts =
      `${[`${a.team} – ${b.team}${input.kind === "player" ? " (équipes adverses)" : ""}`, inLeague(league)].filter(Boolean).join(" ")} : ` +
      `${winsA} victoires à ${winsB} en parties sur ${raw.length} tournois (${span(raw.map((r) => Number(r.year)))}), ${leader}. ` +
      `Dernière confrontation : ${last.tournament ?? last.event_page} (${last.wins_a}-${last.wins_b}).`;

    return {
      title: `${a.team} vs ${b.team}${league === "toutes compétitions" ? "" : ` — ${league}`}`,
      table: {
        columns: ["Année", "Compétition", "Tournoi", a.team, b.team],
        rows: raw.map((r) => [r.year, r.league_short, r.tournament ?? r.event_page, r.wins_a, r.wins_b]),
      },
      facts,
      sources: [
        ...[...a.members, ...b.members].map((m) => ({ label: `Leaguepedia — ${m}`, url: wikiUrl(m) })),
        ...eventSources(raw.map((r) => String(r.event_page)), 15),
      ],
      followUps:
        input.kind === "team"
          ? [`Historique de ${a.team}`, `Historique de ${b.team}`]
          : [`Résultats de ${a.team} à tous les Worlds`, `Résultats de ${b.team} à tous les Worlds`],
      totals: { wins_a: winsA, wins_b: winsB, events: raw.length },
    };
  },
  normalize: (db, input) => {
    if (input.kind === "team") return resolveTeam(db, input.sideA) && resolveTeam(db, input.sideB) ? input : null;
    const a = resolvePlayer(db, input.sideA);
    const b = resolvePlayer(db, input.sideB);

    return a && b ? { ...input, sideA: a.player, sideB: b.player } : null;
  },
};

// 4. Champion in an event -----------------------------------------------------------

const championEventStats: ToolDef<ChampionStatsInput> = {
  name: "champion_event_stats",
  label: "stats d'un champion × compétition",
  description:
    "A champion's picks, bans, presence and win rate in one competition, edition by edition, with the players who picked it most.",
  plan: (_db, input) => {
    const params: Params = {};

    Object.assign(params, { champion: input.champion, league: input.league });

    return {
      params,
      sql: tidy(`WITH ev AS (
  SELECT g.game_id, g.year, g.league_short, g.event_page, g.tournament, g.played_at
  FROM v_games g
  WHERE g.league = :league AND g.stage IN (${COMPETITION_STAGES})
    ${periodFilter("g.year", input, params)}
),
picks AS (
  SELECT gp.game_id, gp.win, gp.player
  FROM v_game_players gp
  WHERE gp.champion = :champion AND gp.league = :league AND gp.stage IN (${COMPETITION_STAGES})
),
bans AS (
  SELECT DISTINCT d.game_id FROM v_draft d WHERE d.champion = :champion AND d.kind = 'ban'
),
player_counts AS (
  SELECT ev.event_page, p.player, COUNT(*) AS n
  FROM picks p JOIN ev ON ev.game_id = p.game_id
  GROUP BY ev.event_page, p.player
)
SELECT ev.year, ev.league_short, ev.event_page, MIN(ev.tournament) AS tournament,
       COUNT(*) AS games, COUNT(p.game_id) AS picks, COALESCE(SUM(p.win), 0) AS wins, COUNT(b.game_id) AS bans,
       (SELECT json_group_array(json_object('player', pc.player, 'games', pc.n) ORDER BY pc.n DESC, pc.player)
          FROM player_counts pc WHERE pc.event_page = ev.event_page) AS players
FROM ev
LEFT JOIN picks p ON p.game_id = ev.game_id
LEFT JOIN bans b ON b.game_id = ev.game_id
GROUP BY ev.year, ev.event_page
HAVING COUNT(p.game_id) + COUNT(b.game_id) > 0
ORDER BY ev.year, MIN(ev.played_at), ev.event_page`),
    };
  },
  relaxations: (input) => (hasPeriod(input) ? [noPeriod(input, "toutes les éditions")] : []),
  format: (db, input, sqlRows): ToolOutput => {
    const raw = z.array(ChampionStatsRow).parse(sqlRows);
    const league = leagueShortName(db, input.league);
    const sum = (k: "picks" | "bans" | "wins" | "games") => raw.reduce((n, r) => n + r[k], 0);
    const picks = sum("picks");
    const bans = sum("bans");
    const wins = sum("wins");
    const games = sum("games");
    const players = new Map<string, number>();

    for (const r of raw) for (const p of r.players) players.set(p.player, (players.get(p.player) ?? 0) + p.games);
    const top = [...players].sort((x, y) => y[1] - x[1]).slice(0, 3);

    const facts =
      `${input.champion} ${inLeague(league)} (${span(raw.map((r) => Number(r.year)))}) : ${picks} picks et ${bans} bans ` +
      `sur ${games} parties (présence ${pct(picks + bans, games)} %), ${wins} victoires pour ${picks - wins} défaites ` +
      `(${pct(wins, picks)} % de victoires).` +
      (top.length ? ` Joueurs les plus fréquents : ${top.map(([p, n]) => `${p} (${n})`).join(", ")}.` : "");

    const icon = selectOne(db, z.object({ icon_url: z.string().nullable() }), "SELECT icon_url FROM champions WHERE name = ?", [
      input.champion,
    ])?.icon_url;

    return {
      title: `${input.champion} — ${league}`,
      table: {
        columns: ["Année", "Tournoi", "Parties", "Picks", "Bans", "Présence %", "V-D", "% victoire", "Joueurs"],
        rows: raw.map((r) => [
          r.year,
          r.tournament ?? r.event_page,
          r.games,
          r.picks,
          r.bans,
          pct(r.picks + r.bans, r.games),
          `${r.wins}-${r.picks - r.wins}`,
          r.picks ? pct(r.wins, r.picks) : null,
          r.players.slice(0, 3).map((p) => `${p.player} ×${p.games}`).join(", "),
        ]),
      },
      facts,
      sources: [
        { label: `Leaguepedia — ${input.champion}`, url: wikiUrl(input.champion) },
        ...eventSources(raw.map((r) => String(r.event_page)), 15),
        { label: "Riot Data Dragon — champions", url: icon ?? `${DDRAGON_BASE}/api/versions.json` },
      ],
      followUps: top.slice(0, 2).map(([p]) => `Résultats de ${p} ${league === "Worlds" ? "à tous les Worlds" : inLeague(league)}`),
      totals: { picks, bans, wins, games, events: raw.length },
    };
  },
  normalize: (db, input) => {
    const c = resolveChampion(db, input.champion);

    return c ? { ...input, champion: c.champion } : null;
  },
};

// 5. Standings / roll of honour -------------------------------------------------------

const tournamentStandings: ToolDef<StandingsInput> = {
  name: "tournament_standings",
  label: "palmarès / classement",
  description:
    "Final standings of a competition: every placement of one edition (full), or the champion and finalist of each edition (roll of honour).",
  plan: (_db, input) => {
    const params: Params = {};

    Object.assign(params, { league: input.league });

    const filters: string[] = [];

    if (input.split) {
      filters.push("AND t.split = :split");
      params.split = input.split;
    }

    if (!input.full) {
      filters.push("AND tr.place_number <= 2");
      // A regular season with its own playoffs: the title is the playoffs one.
      filters.push(
        "AND NOT (t.stage = 'season' AND EXISTS (SELECT 1 FROM v_tournaments p WHERE p.league = t.league AND p.year = t.year AND p.stage = 'playoffs' AND COALESCE(p.split, '') = COALESCE(t.split, '')))",
      );
    }

    return {
      params,
      sql: tidy(`SELECT tr.year, tr.event_page, tr.tournament, t.stage, t.split, t.date_start,
       tr.place, tr.place_number, tr.team, tr.prize_usd
FROM v_tournament_results tr
JOIN v_tournaments t ON t.tournament_page = tr.event_page
WHERE tr.league = :league
  AND t.stage IN (${STANDINGS_STAGES})
  ${periodFilter("tr.year", input, params)}
  ${filters.join("\n  ")}
ORDER BY t.date_start, tr.event_page, tr.place_number IS NULL, tr.place_number, tr.team`),
    };
  },
  relaxations: (input) =>
    input.split
      ? [{ key: "split", input: { ...input, split: null }, note: `Aucun classement pour le split ${input.split} : affichage de toute l'année.`, reason: "filtre de split retiré" }]
      : [],
  format: (db, input, sqlRows): ToolOutput => {
    const raw = z.array(StandingsRow).parse(sqlRows);
    const league = leagueShortName(db, input.league);
    const pages = [...new Set(raw.map((r) => String(r.event_page)))];
    const winnerOf = (page: string) => raw.find((r) => r.event_page === page && r.place_number === 1);
    const nameOf = (page: string) => raw.find((r) => r.event_page === page)?.tournament ?? page;

    const sources = [
      ...eventSources(pages, 30),
    ];

    if (input.full) {
      const multi = pages.length > 1;
      const champions = pages.flatMap((p) => winnerOf(p) ?? []);

      const facts =
        pages
          .map((p) => {
            const w = winnerOf(p);
            const f = raw.find((r) => r.event_page === p && r.place_number === 2);
            const name = nameOf(p);

            return w
              ? `${name} : ${displayTeam(String(w.team))} champion${f ? `, ${displayTeam(String(f.team))} finaliste` : ""}.`
              : `${name} : finale pas encore publiée sur Leaguepedia.`;
          })
          .join(" ") + ` ${raw.length} équipes classées.`;

      return {
        title: `Classement — ${pages.length === 1 ? nameOf(pages[0]) : `${league} ${span(raw.map((r) => r.year))}`}`,
        table: {
          columns: [...(multi ? ["Tournoi"] : []), "Place", "Équipe", "Gains (USD)"],
          rows: raw.map((r) => [
            ...(multi ? [nameOf(r.event_page)] : []),
            r.place ? `${placeLabel(r.place)} (${r.place})` : "—",
            displayTeam(r.team),
            r.prize_usd == null ? null : Math.round(r.prize_usd),
          ]),
        },
        facts,
        sources,
        followUps: champions.slice(0, 2).map((w) => `Historique de ${displayTeam(w.team)}`),
        totals: { champion: champions[0] ? displayTeam(champions[0].team) : "", teams: raw.length, events: pages.length },
      };
    }

    const editions = pages.map((p) => {
      const w = winnerOf(p);
      const f = raw.find((r) => r.event_page === p && r.place_number === 2);

      return {
        year: raw.find((r) => r.event_page === p)?.year ?? 0,
        tournament: nameOf(p),
        winner: w ? displayTeam(w.team) : null,
        finalist: f ? displayTeam(f.team) : null,
      };
    });

    const rows = editions.map((e) => [e.year, e.tournament, e.winner ?? "—", e.finalist ?? "—"]);
    const count = new Map<string, number>();

    for (const e of editions) if (e.winner) count.set(e.winner, (count.get(e.winner) ?? 0) + 1);
    const ranking = [...count].sort((x, y) => y[1] - x[1]);
    const latest = editions.findLast((e) => e.winner)?.winner ?? "";

    const facts =
      `Palmarès ${league === "Worlds" ? "des Worlds" : `de ${league}`}${input.split ? ` (${input.split})` : ""} : ${rows.length} tournois (${span(editions.map((e) => e.year))}). ` +
      (ranking.length
        ? `Plus titrés : ${ranking.slice(0, 3).map(([t, n]) => `${t} (${n})`).join(", ")}. Dernier vainqueur : ${latest}.`
        : "Aucun vainqueur publié.");

    return {
      title: `Palmarès — ${league}${input.yearFrom != null ? ` ${span([input.yearFrom, input.yearTo ?? input.yearFrom])}` : ""}`,
      table: { columns: ["Année", "Tournoi", "Vainqueur", "Finaliste"], rows },
      facts,
      sources,
      followUps: ranking.slice(0, 2).map(([t]) => `Historique de ${t}`),
      totals: { events: rows.length, most_titles: ranking[0]?.[0] ?? "", most_titles_count: ranking[0]?.[1] ?? 0, latest_champion: latest },
    };
  },
  normalize: (_db, input) => input,
};

// Registry ----------------------------------------------------------------------------

function bind<I extends ToolInput>(def: ToolDef<I>, db: DatabaseSync, input: I, call: (input: I) => ToolCall): BoundTool {
  const { sql, params } = def.plan(db, input);

  return {
    call: call(input),
    label: def.label,
    sql,
    params,
    relaxations: (entities) =>
      def.relaxations(input, entities).map((r) => ({
        key: r.key,
        note: r.note,
        reason: r.reason,
        next: () => bind(def, db, r.input, call),
      })),
    format: (formatDb, rows) => def.format(formatDb, input, rows),
  };
}

/** Validates the input with the tool's zod schema and binds the tool to it. */
export function bindTool(db: DatabaseSync, call: ToolCall): BoundTool {
  switch (call.tool) {
    case "player_event_history":
      return bind(playerEventHistory, db, PlayerHistoryInput.parse(call.input), (input) => ({ tool: call.tool, input }));
    case "team_history":
      return bind(teamHistory, db, TeamHistoryInput.parse(call.input), (input) => ({ tool: call.tool, input }));
    case "head_to_head":
      return bind(headToHead, db, HeadToHeadInput.parse(call.input), (input) => ({ tool: call.tool, input }));
    case "champion_event_stats":
      return bind(championEventStats, db, ChampionStatsInput.parse(call.input), (input) => ({ tool: call.tool, input }));
    case "tournament_standings":
      return bind(tournamentStandings, db, StandingsInput.parse(call.input), (input) => ({ tool: call.tool, input }));
  }
}

/** The same tools, as AI SDK tools for the LLM router (no `execute`: the agent runs them behind the guard). */
export const aiTools = {
  player_event_history: tool({ description: playerEventHistory.description, inputSchema: PlayerHistoryInput }),
  team_history: tool({ description: teamHistory.description, inputSchema: TeamHistoryInput }),
  head_to_head: tool({ description: headToHead.description, inputSchema: HeadToHeadInput }),
  champion_event_stats: tool({ description: championEventStats.description, inputSchema: ChampionStatsInput }),
  tournament_standings: tool({ description: tournamentStandings.description, inputSchema: StandingsInput }),
};

/** Maps an LLM tool call onto database names (aliases, team shorthands...); null when a name is unknown. */
export function normalizeToolCall(db: DatabaseSync, call: StaticToolCall<typeof aiTools>): ToolCall | null {
  switch (call.toolName) {
    case "player_event_history": {
      const input = playerEventHistory.normalize(db, call.input);

      return input && { tool: call.toolName, input };
    }

    case "team_history": {
      const input = teamHistory.normalize(db, call.input);

      return input && { tool: call.toolName, input };
    }

    case "head_to_head": {
      const input = headToHead.normalize(db, call.input);

      return input && { tool: call.toolName, input };
    }

    case "champion_event_stats": {
      const input = championEventStats.normalize(db, call.input);

      return input && { tool: call.toolName, input };
    }

    case "tournament_standings": {
      const input = tournamentStandings.normalize(db, call.input);

      return input && { tool: call.toolName, input };
    }
  }
}
