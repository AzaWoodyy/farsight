import type { DatabaseSync } from "node:sqlite";
import { type StaticToolCall, tool } from "ai";
import { z } from "zod";
import { selectAll, selectOne, type SqlRow } from "../db";
import { DDRAGON_BASE } from "../sources/ddragon";
import { wikiUrl } from "../sources/leaguepedia";
import { clock, type ParsedTimeline, type RiotTeam } from "../sources/timeline";
import { loadTimeline } from "../storage/timelines";
import {
  type Entities,
  LEAGUE_NAMES,
  type ResultRow,
  type Side,
  type Source,
  type TableCell,
  type TimelineView,
  type ToolName,
  type TraceStatus,
} from "./types";
import { resolveChampion, resolvePlayer, resolveTeam } from "./understand";
import {
  PLAYER_METRIC_DEFS,
  PLAYER_METRICS,
  type PlayerMetric,
  TEAM_METRIC_DEFS,
  TEAM_METRICS,
  type TeamMetric,
  metricColumn,
  metricLabel,
} from "./metrics";

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

const MinuteInput = z
  .union([z.literal(10), z.literal(15), z.literal(20)])
  .nullable()
  .describe("Minute of the snapshot for gold/CS/XP metrics (10, 15 or 20), null for 15");

const ROLES = ["Top", "Jungle", "Mid", "Bot", "Support"] as const;

export const PlayerIngameInput = z.object({
  player: z.string().min(1).describe("Player handle or Leaguepedia page"),
  league: League.nullable().describe("Restrict to one competition, null for every competition with in-game data"),
  ...Period,
  metric: z.enum(PLAYER_METRICS).nullable().describe("The metric the question is about, shown first; null for the overview"),
  minute: MinuteInput,
});

export const LeaderboardInput = z.object({
  subject: z.enum(["player", "team"]),
  metric: z.enum([...new Set([...PLAYER_METRICS, ...TEAM_METRICS])]).describe(
    "Player metrics: solo_kills, penta_kills, quadra_kills, triple_kills, double_kills, first_bloods, kills_before_10, gold_diff, cs_diff, xp_diff, gold, cs, xp, wards_placed, wards_killed, control_wards, plates. " +
      "Team metrics: first_blood, first_tower, first_dragon, first_herald, first_baron, gold_diff, kills_before_10, plates.",
  ),
  minute: MinuteInput,
  league: League.nullable(),
  ...Period,
  role: z.enum(ROLES).nullable().describe("Players of one role only"),
  minGames: z.number().int().min(1).max(200).nullable().describe("Minimum games for averages and rates, null for the default"),
});

export const TeamIngameInput = z.object({
  team: z.string().min(1).describe("Team name or shorthand (T1, Gen.G, G2...)"),
  league: League.nullable(),
  ...Period,
  minute: MinuteInput,
});

export const GAME_PHASES = ["final", "semifinal", "quarterfinal", "third_place", "groups", "play_in"] as const;

export type GamePhase = (typeof GAME_PHASES)[number];

export const GameTimelineInput = z.object({
  teamA: z.string().min(1).nullable().describe("One team of the game (T1, Gen.G...), null when the question names none"),
  teamB: z.string().min(1).nullable().describe("The other team, null when the question names one team or none"),
  league: League.nullable(),
  year: Year.describe("Season of the game, null when not given"),
  phase: z.enum(GAME_PHASES).nullable().describe("Stage of the series (final, semifinal...), null when not given"),
  game: z.number().int().min(1).max(5).nullable().describe("Game number in the series (\"game 3\" = 3), null when not given"),
});

export type GameTimelineInput = z.infer<typeof GameTimelineInput>;

export type PlayerIngameInput = z.infer<typeof PlayerIngameInput>;

export type LeaderboardInput = z.infer<typeof LeaderboardInput>;

export type TeamIngameInput = z.infer<typeof TeamIngameInput>;

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
  | { tool: "tournament_standings"; input: StandingsInput }
  | { tool: "player_ingame_stats"; input: PlayerIngameInput }
  | { tool: "ingame_leaderboard"; input: LeaderboardInput }
  | { tool: "team_ingame_stats"; input: TeamIngameInput }
  | { tool: "game_timeline"; input: GameTimelineInput };

export type ToolInput = ToolCall["input"];

type Params = Record<string, string | number>;

type Plan = { sql: string; params: Params };

type Relaxation<I> = { key: string; input: I; note: string; reason: string };

/** A line a tool adds to the trace while formatting (a timeline read from storage...). */
export type ToolTrace = { status: TraceStatus; title: string; detail?: string };

export type ToolOutput = {
  title: string;
  rows?: ResultRow[];
  table?: { columns: string[]; rows: TableCell[][] };
  timeline?: TimelineView;
  trace?: ToolTrace[];
  /** Notes shown under the answer (the game shown when several match...). */
  notes?: string[];
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
  format: (db: DatabaseSync, input: I, rows: SqlRow[]) => ToolOutput | Promise<ToolOutput>;
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
  format: (db: DatabaseSync, rows: SqlRow[]) => ToolOutput | Promise<ToolOutput>;
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

// In-game stats (Riot JSON on Leaguepedia, not the LPL) ------------------------------

/** Where the in-game numbers come from, cited with every in-game answer. */
const RIOT_DATA_SOURCE: Source = {
  label: "Leaguepedia — données Riot des parties (PostgameJsonMetadata)",
  url: wikiUrl("Special:CargoTables/PostgameJsonMetadata"),
};

/** "2024", or "2019–2024". */
const yearSpan = (years: number[]) => (years.length && Math.min(...years) === Math.max(...years) ? String(years[0]) : span(years));

const signed = (n: number | null) => (n == null ? "n/d" : `${n > 0 ? "+" : ""}${n}`);
const round1 = (n: number | null) => (n == null ? null : Math.round(n * 10) / 10);

/** SQL aggregate of a metric column: totals for counts, averages, percentages for 0/1 flags. */
function aggregateSql(aggregate: "sum" | "avg" | "rate", column: string): string {
  if (aggregate === "sum") return `SUM(${column})`;

  if (aggregate === "rate") return `ROUND(100.0 * AVG(${column}), 1)`;

  // Gold and XP in whole units, the rest (CS, wards, plates) to one decimal.
  return `ROUND(AVG(${column}), ${/gold|xp/.test(column) ? 0 : 1})`;
}

/** Shared WHERE clause of the in-game tools (`s` is the stats view). */
function ingameScope(input: { league: string | null } & Period, params: Params): string {
  const parts = [`s.stage IN (${COMPETITION_STAGES})`];

  if (input.league) {
    parts.push("s.league = :league");
    params.league = input.league;
  }

  return `${parts.join(" AND ")} ${periodFilter("s.year", input, params)}`;
}

/** Games of the scope, and how many of them have Riot data. */
function coverage(db: DatabaseSync, sql: string, params: Params) {
  return selectOne(db, z.object({ games: z.number(), ingame: z.number() }), sql, params) ?? { games: 0, ingame: 0 };
}

const coverageNote = (c: { games: number; ingame: number }) =>
  c.ingame < c.games
    ? ` Données in-game disponibles pour ${c.ingame} parties sur ${c.games} (Leaguepedia ne publie pas les données Riot de toutes les parties, aucune en LPL).`
    : "";

/** Pages listed in a json_group_array column. */
const pageList = z.string().nullable().transform((v) => (v ? z.array(z.string()).parse(JSON.parse(v)) : []));

/** Metrics of the player overview, then the one the question asks about. */
const PLAYER_OVERVIEW: PlayerMetric[] = ["solo_kills", "penta_kills", "first_bloods", "kills_before_10", "gold_diff", "cs_diff", "wards_placed"];

const PLAYER_COLUMN_LABELS: Record<PlayerMetric, string> = {
  solo_kills: "Solo kills",
  penta_kills: "Pentakills",
  quadra_kills: "Quadrakills",
  triple_kills: "Triple kills",
  double_kills: "Double kills",
  first_bloods: "First bloods",
  kills_before_10: "Kills < 10 min",
  gold_diff: "Écart or",
  cs_diff: "Écart CS",
  xp_diff: "Écart XP",
  gold: "Or",
  cs: "CS",
  xp: "XP",
  wards_placed: "Wards / partie",
  wards_killed: "Wards détruites / partie",
  control_wards: "Control wards / partie",
  plates: "Plaques",
};

/** The metric the question asks about first, then the overview. */
const playerMetricsOf = (input: PlayerIngameInput): PlayerMetric[] =>
  input.metric ? [input.metric, ...PLAYER_OVERVIEW.filter((m) => m !== input.metric)] : PLAYER_OVERVIEW;

const IngameRow = z
  .object({ year: z.number().nullable(), league_short: z.string().nullable(), games: z.number(), wins: z.number(), pages: pageList, stats_page: z.string().nullable() })
  .catchall(z.number().nullable());

// 6. A player's in-game stats -----------------------------------------------------------

const playerIngameStats: ToolDef<PlayerIngameInput> = {
  name: "player_ingame_stats",
  label: "stats in-game d'un joueur",
  description:
    "A player's in-game stats from the Riot game data, season by season: solo kills, multi-kills, first bloods, kills before 10 min, " +
    "gold/CS/XP and their difference with the lane opponent at 10/15/20 min, wards, plates. Not available for the LPL.",
  plan: (_db, input) => {
    const params: Params = {};

    Object.assign(params, { player: input.player });

    const cols = playerMetricsOf(input)
      .map((m) => `${aggregateSql(PLAYER_METRIC_DEFS[m].aggregate, `s.${metricColumn(PLAYER_METRIC_DEFS[m], input.minute)}`)} AS ${m}`)
      .join(",\n         ");

    const scope = ingameScope(input, params);

    return {
      params,
      sql: tidy(`WITH base AS (
  SELECT * FROM v_game_player_stats s
  WHERE s.player = :player AND ${scope}
)
SELECT 0 AS is_total, s.year, s.league_short, MIN(s.played_at) AS first_game, COUNT(*) AS games, SUM(s.win) AS wins,
       ${cols},
       json_group_array(DISTINCT s.event_page) AS pages, MAX(s.stats_page) AS stats_page
FROM base s GROUP BY s.year, s.league_short
UNION ALL
SELECT 1, NULL, NULL, NULL, COUNT(*), SUM(s.win),
       ${cols},
       NULL, NULL
FROM base s
HAVING COUNT(*) > 0
ORDER BY is_total, first_game`),
    };
  },
  relaxations: (input, entities) => {
    const out: Relaxation<typeof input>[] = [];

    if (hasPeriod(input)) out.push(noPeriod(input, "toutes les saisons"));

    if (input.league)
      out.push({
        key: "league",
        input: { ...input, league: null },
        note: "Aucune partie avec données in-game dans cette compétition : affichage de toutes les compétitions.",
        reason: "filtre de compétition retiré",
      });
    const resolved = entities.players.find((p) => p.player === input.player || p.otherCandidates.includes(input.player));

    for (const other of resolved ? [resolved.player, ...resolved.otherCandidates] : [])
      if (other !== input.player)
        out.push({ key: `player:${other}`, input: { ...input, player: other }, note: `« ${resolved!.mention} » désigne aussi ${other} : stats de ${other}.`, reason: `alias homonyme essayé : ${other}` });

    return out;
  },
  format: (db, input, sqlRows): ToolOutput => {
    const all = z.array(IngameRow).parse(sqlRows);
    const total = all[all.length - 1];
    const rows = all.slice(0, -1);
    const metrics = playerMetricsOf(input);
    const league = leagueShortName(db, input.league);
    const num = (r: z.infer<typeof IngameRow>, m: PlayerMetric) => (r[m] == null ? null : Number(r[m]));
    const params: Params = {};

    Object.assign(params, { player: input.player });

    const cov = coverage(db, `SELECT COUNT(*) AS games, SUM(has_ingame) AS ingame FROM v_game_players s JOIN v_games g USING (game_id) WHERE s.player = :player AND ${ingameScope(input, params)}`, params);
    const minute = input.minute ?? 15;
    const val = (m: PlayerMetric) => num(total, m);
    const fb = val("first_bloods");

    const parts: Record<PlayerMetric, string> = {
      solo_kills: `${val("solo_kills") ?? "n/d"} solo kills`,
      penta_kills: `${val("penta_kills") ?? "n/d"} pentakill${(val("penta_kills") ?? 0) > 1 ? "s" : ""}`,
      quadra_kills: `${val("quadra_kills") ?? "n/d"} quadrakills`,
      triple_kills: `${val("triple_kills") ?? "n/d"} triple kills`,
      double_kills: `${val("double_kills") ?? "n/d"} double kills`,
      first_bloods: fb == null ? "first bloods n/d" : `${fb} first blood${fb > 1 ? "s" : ""} (${pct(fb, total.games)} % des parties)`,
      kills_before_10: `${val("kills_before_10") ?? "n/d"} kills avant 10 min`,
      gold_diff: `un écart d'or moyen de ${signed(val("gold_diff"))} à ${minute} min face à son adversaire direct`,
      cs_diff: `un écart de CS moyen de ${signed(val("cs_diff"))} à ${minute} min`,
      xp_diff: `un écart d'XP moyen de ${signed(val("xp_diff"))} à ${minute} min`,
      gold: `${val("gold") ?? "n/d"} d'or en moyenne à ${minute} min`,
      cs: `${val("cs") ?? "n/d"} CS en moyenne à ${minute} min`,
      xp: `${val("xp") ?? "n/d"} XP en moyenne à ${minute} min`,
      wards_placed: `${val("wards_placed") ?? "n/d"} wards posées par partie`,
      wards_killed: `${val("wards_killed") ?? "n/d"} wards détruites par partie`,
      control_wards: `${val("control_wards") ?? "n/d"} control wards achetées par partie`,
      plates: `${val("plates") ?? "n/d"} plaques de tourelle`,
    };

    const facts =
      `${input.player}${league === "toutes compétitions" ? "" : ` ${inLeague(league)}`} (${yearSpan(rows.flatMap((r) => (r.year == null ? [] : [r.year])))}), ` +
      `sur ${total.games} parties avec données in-game : ${metrics.map((m) => parts[m]).join(", ")}.` +
      coverageNote(cov);

    const pages = rows.flatMap((r) => r.pages);
    const statsPages = rows.flatMap((r) => r.stats_page ?? []).slice(-3);

    return {
      title: `${input.player} — stats in-game${league === "toutes compétitions" ? "" : ` (${league})`}`,
      table: {
        columns: ["Année", "Compétition", "Parties", "V-D", ...metrics.map((m) => (PLAYER_METRIC_DEFS[m].snapshot ? `${PLAYER_COLUMN_LABELS[m]} @${minute}` : PLAYER_COLUMN_LABELS[m]))],
        rows: rows.map((r) => [r.year, r.league_short, r.games, `${r.wins}-${r.games - r.wins}`, ...metrics.map((m) => num(r, m))]),
      },
      facts,
      sources: [
        { label: `Leaguepedia — ${input.player}`, url: wikiUrl(input.player) },
        ...eventSources(pages, 10),
        ...statsPages.map((p) => ({ label: `Leaguepedia — ${p}`, url: wikiUrl(p) })),
        RIOT_DATA_SOURCE,
      ],
      followUps: [
        input.league ? `Joueurs avec le plus de solo kills ${inLeague(league)}` : "Joueurs avec le plus de solo kills aux Worlds",
        `Résultats de ${input.player} ${input.league ? inLeague(league) : "aux Worlds"}`,
      ],
      totals: {
        games: total.games,
        coverage_games: cov.games,
        // n/d: no game of the scope has this metric (no timeline, or no plate events before match-v5).
        ...Object.fromEntries(metrics.map((m) => [m, val(m) ?? "n/d"])),
      },
    };
  },
  normalize: (db, input) => {
    const p = resolvePlayer(db, input.player, { league: input.league, yearFrom: input.yearFrom, yearTo: input.yearTo });

    return p ? { ...input, player: p.player } : null;
  },
};

// 7. Leaderboard on an in-game metric --------------------------------------------------

const LeaderRow = z.object({ name: z.string(), team: z.string().nullable(), games: z.number(), counted: z.number(), total: z.number().nullable(), average: z.number().nullable() });

function leaderboardMetric(input: LeaderboardInput) {
  if (input.subject === "team") {
    const key = TEAM_METRICS.find((m) => m === input.metric) ?? "first_blood";

    return { def: TEAM_METRIC_DEFS[key], key };
  }

  const key = PLAYER_METRICS.find((m) => m === input.metric) ?? "solo_kills";

  return { def: PLAYER_METRIC_DEFS[key], key };
}

/** Averages and rates need enough games to mean something. */
function minGamesOf(input: LeaderboardInput): number {
  if (input.minGames != null) return input.minGames;

  if (leaderboardMetric(input).def.aggregate === "sum") return 1;

  const oneSeason = input.yearFrom != null && input.yearFrom === input.yearTo;

  return input.league && oneSeason ? 5 : 15;
}

const ingameLeaderboard: ToolDef<LeaderboardInput> = {
  name: "ingame_leaderboard",
  label: "classement sur une stat in-game",
  description:
    "Ranks players (or teams) of a competition and period on one in-game metric from the Riot game data: solo kills, pentakills, first bloods, " +
    "kills before 10 min, gold/CS/XP difference at 10/15/20 min, wards, plates; teams: first blood/tower/dragon/herald/baron rate, gold difference. Not available for the LPL.",
  plan: (_db, input) => {
    const params: Params = {};

    Object.assign(params, { minGames: minGamesOf(input) });

    const { def } = leaderboardMetric(input);
    const column = `s.${metricColumn(def, input.minute)}`;
    const view = input.subject === "team" ? "v_game_team_stats" : "v_game_player_stats";
    const name = input.subject === "team" ? "s.team" : "s.player";
    const filters = [ingameScope(input, params)];

    if (input.subject === "player" && input.role) {
      filters.push("AND s.role = :role");
      params.role = input.role;
    }

    const value = def.aggregate === "sum" ? "total" : "average";
    const average = def.aggregate === "rate" ? `100.0 * AVG(${column})` : `AVG(${column})`;

    return {
      params,
      sql: tidy(`SELECT ${name} AS name, ${input.subject === "team" ? "NULL" : "s.team"} AS team, MAX(s.played_at) AS last_game,
       COUNT(*) AS games, COUNT(${column}) AS counted, SUM(${column}) AS total, ROUND(${average}, 2) AS average
FROM ${view} s
WHERE ${filters.join(" ")}
GROUP BY ${name}
HAVING COUNT(${column}) >= :minGames${def.aggregate === "sum" ? ` AND SUM(${column}) > 0` : ""}
ORDER BY ${value} DESC, games ASC, name
LIMIT 20`),
    };
  },
  relaxations: (input) => {
    const out: Relaxation<typeof input>[] = [];

    if (input.minGames == null && minGamesOf(input) > 3)
      out.push({ key: "minGames", input: { ...input, minGames: 3 }, note: "Peu de parties par joueur dans ce périmètre : seuil abaissé à 3 parties.", reason: "seuil de parties abaissé" });

    if (hasPeriod(input)) out.push(noPeriod(input, "toutes les saisons"));

    return out;
  },
  format: (db, input, sqlRows): ToolOutput => {
    const rows = z.array(LeaderRow).parse(sqlRows);
    const { def } = leaderboardMetric(input);
    const label = metricLabel(def, input.minute);
    const league = leagueShortName(db, input.league);
    const params: Params = {};
    const scope = ingameScope(input, params);
    const cov = coverage(db, `SELECT COUNT(*) AS games, SUM(has_ingame) AS ingame FROM v_games s WHERE ${scope}`, params);
    const pages = selectAll(db, z.object({ event_page: z.string() }), `SELECT DISTINCT s.event_page FROM v_games s WHERE ${scope} AND s.has_ingame ORDER BY s.played_at DESC LIMIT 12`, params).map((r) => r.event_page);
    const value = (r: z.infer<typeof LeaderRow>) => (def.aggregate === "sum" ? (r.total ?? 0) : round1(r.average));
    const unit = def.aggregate === "rate" ? " %" : "";
    const who = input.subject === "team" ? "Équipe" : "Joueur";
    const minGames = minGamesOf(input);
    const years = selectAll(db, z.object({ year: z.number().nullable() }), `SELECT DISTINCT s.year FROM v_games s WHERE ${scope} AND s.has_ingame`, params).flatMap((r) => (r.year == null ? [] : [r.year]));
    const scopeLabel = [inLeague(league), years.length ? `(${yearSpan(years)})` : ""].filter(Boolean).join(" ");
    const roleLabel = input.role ? ` (rôle ${input.role})` : "";

    const facts =
      `${def.aggregate === "sum" ? "Total de" : def.aggregate === "rate" ? "Part des parties avec" : "Moyenne par partie de"} ${label}${roleLabel} ${scopeLabel} : ` +
      rows.slice(0, 3).map((r, i) => `${i + 1}. ${displayTeam(r.name)} (${value(r)}${unit}, ${r.games} parties)`).join(", ") +
      `. ${cov.ingame} parties avec données in-game${def.aggregate === "sum" ? "" : `, minimum ${minGames} parties par ${input.subject === "team" ? "équipe" : "joueur"}`}.` +
      coverageNote(cov);

    return {
      title: `Classement — ${label}${roleLabel}${league === "toutes compétitions" ? "" : ` (${league})`}`,
      table: {
        columns: ["Rang", who, ...(input.subject === "player" ? ["Équipe (dernière)"] : []), "Parties", def.aggregate === "sum" ? "Total" : def.aggregate === "rate" ? "%" : "Moyenne", ...(def.aggregate === "sum" ? ["Par partie"] : [])],
        rows: rows.map((r, i) => [
          i + 1,
          displayTeam(r.name),
          ...(input.subject === "player" ? [r.team ? displayTeam(r.team) : null] : []),
          r.games,
          value(r),
          ...(def.aggregate === "sum" ? [Math.round((100 * (r.total ?? 0)) / Math.max(1, r.counted)) / 100] : []),
        ]),
      },
      facts,
      sources: [
        ...rows.slice(0, 3).map((r) => ({ label: `Leaguepedia — ${r.name}`, url: wikiUrl(r.name) })),
        ...eventSources(pages, 12),
        RIOT_DATA_SOURCE,
      ],
      followUps: rows.slice(0, 2).map((r) => (input.subject === "team" ? `Stats in-game de ${displayTeam(r.name)}` : `Stats in-game de ${r.name}`)),
      totals: { leader: rows[0] ? displayTeam(rows[0].name) : "", leader_value: rows[0] ? (value(rows[0]) ?? 0) : 0, rows: rows.length, ingame_games: cov.ingame },
    };
  },
  normalize: (_db, input) => {
    const valid = input.subject === "team" ? TEAM_METRICS.some((m) => m === input.metric) : PLAYER_METRICS.some((m) => m === input.metric);

    return valid ? input : null;
  },
};

// 8. A team's in-game stats --------------------------------------------------------------

const TEAM_OVERVIEW: TeamMetric[] = ["first_blood", "first_tower", "first_dragon", "first_herald", "first_baron", "gold_diff", "kills_before_10", "plates"];

const TEAM_COLUMN_LABELS: Record<TeamMetric, string> = {
  first_blood: "First blood %",
  first_tower: "1re tour %",
  first_dragon: "1er dragon %",
  first_herald: "1er héraut %",
  first_baron: "1er baron %",
  gold_diff: "Écart or",
  kills_before_10: "Kills < 10 min",
  plates: "Plaques / partie",
};

const teamIngameStats: ToolDef<TeamIngameInput> = {
  name: "team_ingame_stats",
  label: "stats in-game d'une équipe",
  description:
    "A team's in-game profile from the Riot game data, season by season: first blood, first tower, dragon, herald and baron rates, " +
    "team gold difference at 10/15/20 min, turret plates. Renamed teams are merged. Not available for the LPL.",
  plan: (db, input) => {
    const params: Params = {};
    const t = inList("t", teamMembers(db, input.team).members, params);
    const cols = TEAM_OVERVIEW.map((m) => `${aggregateSql(TEAM_METRIC_DEFS[m].aggregate, `s.${metricColumn(TEAM_METRIC_DEFS[m], input.minute)}`)} AS ${m}`).join(",\n         ");
    const scope = ingameScope(input, params);

    return {
      params,
      sql: tidy(`WITH base AS (
  SELECT * FROM v_game_team_stats s WHERE s.team IN (${t}) AND ${scope}
)
SELECT 0 AS is_total, s.year, s.league_short, MIN(s.played_at) AS first_game, COUNT(*) AS games, SUM(s.win) AS wins,
       ${cols},
       json_group_array(DISTINCT s.event_page) AS pages, MAX(s.stats_page) AS stats_page
FROM base s GROUP BY s.year, s.league_short
UNION ALL
SELECT 1, NULL, NULL, NULL, COUNT(*), SUM(s.win),
       ${cols},
       NULL, NULL
FROM base s
HAVING COUNT(*) > 0
ORDER BY is_total, first_game`),
    };
  },
  relaxations: (input) => {
    const out: Relaxation<typeof input>[] = [];

    if (hasPeriod(input)) out.push(noPeriod(input, "toutes les saisons"));

    if (input.league)
      out.push({ key: "league", input: { ...input, league: null }, note: "Aucune partie avec données in-game dans cette compétition : affichage de toutes les compétitions.", reason: "filtre de compétition retiré" });

    return out;
  },
  format: (db, input, sqlRows): ToolOutput => {
    const all = z.array(IngameRow).parse(sqlRows);
    const total = all[all.length - 1];
    const rows = all.slice(0, -1);
    const { team, members } = teamMembers(db, input.team);
    const league = leagueShortName(db, input.league);
    const minute = input.minute ?? 15;
    const val = (m: TeamMetric) => (total[m] == null ? null : Number(total[m]));
    const params: Params = {};
    const t = inList("t", members, params);
    const cov = coverage(db, `SELECT COUNT(*) AS games, SUM(has_ingame) AS ingame FROM v_games s WHERE (s.blue_team IN (${t}) OR s.red_team IN (${t})) AND ${ingameScope(input, params)}`, params);

    const facts =
      `${team}${league === "toutes compétitions" ? "" : ` ${inLeague(league)}`} (${yearSpan(rows.flatMap((r) => (r.year == null ? [] : [r.year])))}), sur ${total.games} parties avec données in-game ` +
      `(${total.wins} victoires) : first blood dans ${val("first_blood") ?? "n/d"} % des parties, première tourelle ${val("first_tower") ?? "n/d"} %, ` +
      `premier dragon ${val("first_dragon") ?? "n/d"} %, premier héraut ${val("first_herald") ?? "n/d"} %, premier baron ${val("first_baron") ?? "n/d"} %, ` +
      `écart d'or moyen de ${signed(val("gold_diff"))} à ${minute} min, ${val("kills_before_10") ?? "n/d"} kills avant 10 min et ${val("plates") ?? "n/d"} plaques de tourelle prises par partie.` +
      coverageNote(cov);

    return {
      title: `${team} — stats in-game${league === "toutes compétitions" ? "" : ` (${league})`}`,
      table: {
        columns: ["Année", "Compétition", "Parties", "V-D", ...TEAM_OVERVIEW.map((m) => (m === "gold_diff" ? `Écart or @${minute}` : TEAM_COLUMN_LABELS[m]))],
        rows: rows.map((r) => [r.year, r.league_short, r.games, `${r.wins}-${r.games - r.wins}`, ...TEAM_OVERVIEW.map((m) => (r[m] == null ? null : Number(r[m])))]),
      },
      facts,
      sources: [
        ...members.map((m) => ({ label: `Leaguepedia — ${m}`, url: wikiUrl(m) })),
        ...eventSources(rows.flatMap((r) => r.pages), 10),
        RIOT_DATA_SOURCE,
      ],
      followUps: [`Historique de ${team}`, `Équipes qui prennent le plus souvent le first blood ${input.league ? inLeague(league) : "aux Worlds"}`],
      totals: { games: total.games, wins: total.wins, ...Object.fromEntries(TEAM_OVERVIEW.map((m) => [m, val(m) ?? "n/d"])) },
    };
  },
  normalize: (db, input) => (resolveTeam(db, input.team) ? input : null),
};


// 9. One game's timeline (Riot JSON in R2, read server-side) ---------------------------------

const PHASE_SQL: Record<GamePhase, string> = {
  final: "g.tab IN ('Finals', 'Final', 'Grand Finals', 'Grand Final')",
  semifinal: "g.tab IN ('Semifinals', 'Semifinal')",
  quarterfinal: "g.tab IN ('Quarterfinals', 'Quarterfinal')",
  third_place: "g.tab LIKE 'Third-Place%'",
  groups: "(g.tab LIKE 'Group%' OR g.tab LIKE 'Swiss%' OR (g.stage = 'main_event' AND g.tab LIKE 'Day %'))",
  play_in: "(g.stage = 'play_in' OR g.tab LIKE 'Play-In%')",
};

const PHASE_LABEL: Record<GamePhase, string> = {
  final: "finale",
  semifinal: "demi-finale",
  quarterfinal: "quart de finale",
  third_place: "match pour la 3e place",
  groups: "phase de groupes",
  play_in: "play-in",
};

const TAB_LABELS = new Map([
  ["Finals", "finale"],
  ["Final", "finale"],
  ["Grand Finals", "grande finale"],
  ["Grand Final", "grande finale"],
  ["Semifinals", "demi-finale"],
  ["Semifinal", "demi-finale"],
  ["Quarterfinals", "quart de finale"],
  ["Quarterfinal", "quart de finale"],
  ["Third-Place Match", "match pour la 3e place"],
  ["Tiebreakers", "départage"],
]);

/** French name of a Leaguepedia tab: "Finals" → "finale", "Week 3" → "semaine 3". */
export function tabLabel(tab: string | null): string {
  if (!tab) return "";

  const fixed = TAB_LABELS.get(tab);

  if (fixed) return fixed;

  return tab
    .replace(/^Week (\d+)/, "semaine $1")
    .replace(/^Day (\d+)/, "jour $1")
    .replace(/^Round (\d+)/, "tour $1")
    .replace(/^Groups? /, "groupes ")
    .replace(/^Group ([A-Z])$/, "groupe $1");
}

const TimelineGameRow = z.object({
  game_id: z.number(),
  tournament_page: Text,
  event_page: Text,
  tournament: NullableText,
  league_short: Text,
  year: z.number().nullable(),
  tab: NullableText,
  match_n: z.number().nullable(),
  game_n: z.number().nullable(),
  played_at: z.number().nullable(),
  blue_team: NullableText,
  red_team: NullableText,
  winner: NullableText,
  length_s: z.number().nullable(),
  riot_key: NullableText,
  stats_page: NullableText,
  has_timeline: z.number().nullable(),
  side_swapped: z.number().nullable(),
});

type TimelineGameRow = z.infer<typeof TimelineGameRow>;

/** The series a game belongs to: one tab's match of one tournament page. */
const seriesKey = (r: TimelineGameRow) => `${r.tournament_page}|${r.tab}|${r.match_n}`;

/** "Worlds 2024 · finale" */
const seriesLabel = (r: TimelineGameRow) => [`${r.league_short}${r.year ? ` ${r.year}` : ""}`, tabLabel(r.tab)].filter(Boolean).join(" · ");

/** "la finale des Worlds 2024" */
function seriesPhrase(r: TimelineGameRow): string {
  const event = `${r.league_short}${r.year ? ` ${r.year}` : ""}`;
  const of = r.league_short === "Worlds" || r.league_short.endsWith("Masters") ? `des ${event}` : r.league_short === "MSI" ? `du ${event}` : `de la ${event}`;
  const tab = tabLabel(r.tab);

  return tab ? `${/^(semaine|journée|jour|tour)/.test(tab) ? "" : "la "}${tab} ${of}` : r.tournament ?? event;
}

const thousands = (n: number) => Math.abs(n).toLocaleString("fr-FR").replace(/ | /g, " ");

const signedGold = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${thousands(n)}`;

const KIND_COUNT: { kind: ParsedTimeline["events"][number]["kind"]; one: string; many: string }[] = [
  { kind: "tower", one: "tour", many: "tours" },
  // Elder dragons count as dragons, as in Leaguepedia's scoreboards.
  { kind: "dragon", one: "dragon", many: "dragons" },
  { kind: "baron", one: "baron", many: "barons" },
  { kind: "inhibitor", one: "inhibiteur", many: "inhibiteurs" },
];

/** Riot team → Leaguepedia side (blue = Team1), as the build matched them. */
const sideOf = (team: RiotTeam, swapped: boolean): Side => ((team === 100) !== swapped ? "blue" : "red");

function timelineView(r: TimelineGameRow, t: ParsedTimeline): TimelineView {
  const swapped = r.side_swapped === 1;
  const sign = swapped ? -1 : 1;

  return {
    label: `${seriesLabel(r)}${r.game_n ? ` · game ${r.game_n}` : ""}`,
    blue: displayTeam(r.blue_team ?? "Bleu"),
    red: displayTeam(r.red_team ?? "Rouge"),
    winner: t.winner ? sideOf(t.winner, swapped) : null,
    durationS: t.durationS,
    version: t.version,
    gold: t.gold.map((g) => ({ s: g.s, diff: sign * g.diff })),
    events: t.events.map((e) => ({ s: e.s, kind: e.kind, side: sideOf(e.team, swapped), detail: e.detail })),
  };
}

/** The one-sentence story of the game, from the parsed timeline only. */
function timelineFacts(r: TimelineGameRow, v: TimelineView): string {
  const name = (side: Side) => (side === "blue" ? v.blue : v.red);
  const winner = v.winner ? name(v.winner) : null;
  const at15 = v.gold.find((g) => g.s >= 15 * 60 - 30 && g.s <= 15 * 60 + 30);
  const peak = v.gold.reduce((best, g) => (Math.abs(g.diff) > Math.abs(best.diff) ? g : best), v.gold[0]);
  const fb = v.events.find((e) => e.kind === "first_blood");
  const lead = (diff: number) => (diff === 0 ? "égalité" : `${signedGold(Math.abs(diff))} pour ${name(diff > 0 ? "blue" : "red")}`);

  const counts = (["blue", "red"] as const).map(
    (side) =>
      `${name(side)} ${KIND_COUNT.map((k) => {
        const n = v.events.filter((e) => e.side === side && (e.kind === k.kind || (k.kind === "dragon" && e.kind === "elder"))).length;

        return `${n} ${n > 1 ? k.many : k.one}`;
      }).join(", ")}`,
  );

  return (
    `Game ${r.game_n ?? "?"} de ${seriesPhrase(r)}, ${v.blue} (bleu) contre ${v.red} (rouge) : ` +
    `${winner ? `victoire de ${winner}` : "vainqueur inconnu"}${v.durationS ? ` en ${clock(v.durationS)}` : ""}` +
    `${fb ? `, first blood pour ${name(fb.side)} à ${clock(fb.s)}` : ""}` +
    `${at15 ? `, écart d'or à 15 min : ${lead(at15.diff)}` : ""}` +
    `${peak && peak.diff !== 0 ? `, écart maximal ${lead(peak.diff)} à ${clock(peak.s)}` : ""}. ` +
    `Objectifs : ${counts.join(" ; ")}.`
  );
}

const gameSources = (r: TimelineGameRow): Source[] => [
  ...(r.stats_page
    ? [
        { label: `Leaguepedia — page de la partie (${r.stats_page})`, url: wikiUrl(r.stats_page) },
        { label: `Leaguepedia — timeline de la partie (${r.stats_page}/Timeline)`, url: wikiUrl(`${r.stats_page}/Timeline`) },
      ]
    : []),
  { label: `Leaguepedia — ${r.tournament_page}`, url: wikiUrl(r.tournament_page) },
];

const SOURCE_LABEL = { cache: "Runtime Cache", r2: "R2", local: "cache local (data/raw/riot)" } as const;

const gameTimeline: ToolDef<GameTimelineInput> = {
  name: "game_timeline",
  label: "timeline d'une partie",
  description:
    "The minute-by-minute story of one game: gold difference at every minute and the key events (first blood, towers, dragons, heralds, " +
    "barons, inhibitors, aces) with their time and team. The game is found by its teams, competition, season, stage of the series " +
    "(final, semifinal...) and game number. Not available for the LPL (no Riot data).",
  plan: (db, input) => {
    const params: Params = {};
    const where = [`g.stage IN (${COMPETITION_STAGES})`];
    const a = input.teamA ? inList("a", teamMembers(db, input.teamA).members, params) : null;
    const b = input.teamB ? inList("b", teamMembers(db, input.teamB).members, params) : null;

    if (a && b) where.push(`((g.blue_team IN (${a}) AND g.red_team IN (${b})) OR (g.blue_team IN (${b}) AND g.red_team IN (${a})))`);
    else if (a) where.push(`(g.blue_team IN (${a}) OR g.red_team IN (${a}))`);

    if (input.league) {
      where.push("g.league = :league");
      params.league = input.league;
    }

    if (input.year != null) {
      where.push("g.year = :year");
      params.year = input.year;
    }

    if (input.phase) where.push(PHASE_SQL[input.phase]);

    // Every game of the matching series, so the answer can say a series had no game 5.
    return {
      params,
      sql: `SELECT g.game_id, g.tournament_page, g.event_page, g.tournament, g.league_short, g.year, g.tab, g.match_n, g.game_n,
       g.played_at, g.blue_team, g.red_team, g.winner, g.length_s,
       r.riot_key, r.stats_page, r.has_timeline, r.side_swapped
FROM v_games g LEFT JOIN game_riot r ON r.game_id = g.game_id
WHERE ${where.join("\n  AND ")}
ORDER BY g.played_at DESC, g.game_n`,
    };
  },
  relaxations: (input) => {
    const out: Relaxation<typeof input>[] = [];
    const teams = [input.teamA, input.teamB].filter(Boolean).join(" – ");

    // Without a team, dropping a filter would show an unrelated game.
    if (!input.teamA) return out;

    if (input.phase)
      out.push({
        key: "phase",
        input: { ...input, phase: null },
        note: `Aucune ${PHASE_LABEL[input.phase]} ${teams} dans ce périmètre : recherche sur toute la compétition.`,
        reason: `phase « ${PHASE_LABEL[input.phase]} » retirée`,
      });

    if (input.year != null)
      out.push({ key: "year", input: { ...input, phase: null, year: null }, note: `Aucune partie ${teams} en ${input.year} : recherche sur toutes les saisons.`, reason: "saison retirée" });

    return out;
  },
  format: async (_db, input, sqlRows): Promise<ToolOutput> => {
    const rows = z.array(TimelineGameRow).parse(sqlRows);
    const series = new Map<string, TimelineGameRow[]>();

    for (const r of rows) series.set(seriesKey(r), [...(series.get(seriesKey(r)) ?? []), r]);
    // Rows come newest first: the first series is the most recent match.
    const [shownKey, games] = [...series][0];
    games.sort((x, y) => (x.game_n ?? 0) - (y.game_n ?? 0));
    const first = games[0];
    const notes: string[] = [];
    const others = [...series.values()].slice(1, 4).map((g) => g[0]);

    if (series.size > 1)
      notes.push(
        `${series.size} séries correspondent ; affichage de la plus récente (${seriesLabel(first)}, ${displayTeam(first.blue_team ?? "?")} – ${displayTeam(first.red_team ?? "?")}). ` +
          "Précise la compétition, la saison ou la phase pour une autre.",
      );

    const gameNumbers = games.flatMap((g) => (g.game_n == null ? [] : [g.game_n]));
    const pick = input.game == null ? first : games.find((g) => g.game_n === input.game);
    const vs = `${displayTeam(first.blue_team ?? "?")} – ${displayTeam(first.red_team ?? "?")}`;

    const followUpsFor = (except: number | null) =>
      [
        ...gameNumbers.filter((n) => n !== except).slice(0, 3).map((n) => `Timeline de la game ${n} de ${vs}, ${seriesLabel(first).replace(" · ", " ")}`),
        ...others.map((o) => `Timeline de ${displayTeam(o.blue_team ?? "?")} – ${displayTeam(o.red_team ?? "?")}, ${seriesLabel(o).replace(" · ", " ")}`),
      ].slice(0, 4);

    const base = { game_id: pick?.game_id ?? 0, series_games: games.length, series: shownKey };

    if (!pick)
      return {
        title: `${vs} — ${seriesLabel(first)}`,
        facts:
          `${seriesPhrase(first).replace(/^./, (c) => c.toUpperCase())} (${vs}) s'est jouée en ${games.length} partie${games.length > 1 ? "s" : ""} ` +
          `(victoire${games.length > 1 ? "s" : ""} : ${games.map((g) => displayTeam(g.winner ?? "?")).join(", ")}) : il n'y a pas de game ${input.game}.`,
        sources: [{ label: `Leaguepedia — ${first.tournament_page}`, url: wikiUrl(first.tournament_page) }],
        followUps: followUpsFor(null),
        totals: { ...base, timeline: "no_such_game" },
        notes,
      };

    if (input.game == null && games.length > 1) notes.push(`Numéro de game non précisé : game ${pick.game_n} affichée (la série en compte ${games.length}).`);

    const title = `${displayTeam(pick.blue_team ?? "?")} – ${displayTeam(pick.red_team ?? "?")} — ${seriesLabel(pick)}${pick.game_n ? ` · game ${pick.game_n}` : ""}`;
    const result = `${displayTeam(pick.winner ?? "?")} gagne${pick.length_s ? ` en ${clock(pick.length_s)}` : ""}`;

    if (!pick.riot_key || pick.has_timeline !== 1)
      return {
        title,
        facts:
          `Game ${pick.game_n ?? "?"} de ${seriesPhrase(pick)} : ${result}. Pas de timeline pour cette partie : ` +
          (pick.riot_key ? "les données Riot publiées par Leaguepedia n'en contiennent pas." : "Leaguepedia ne publie pas ses données Riot (aucune pour la LPL)."),
        sources: gameSources(pick),
        followUps: followUpsFor(pick.game_n),
        totals: { ...base, timeline: "absent" },
        notes,
      };

    const load = await loadTimeline(pick.riot_key);

    if (load.status !== "ok") {
      const why = {
        missing: "le fichier Riot de la partie est introuvable dans le stockage",
        unconfigured: "le stockage des timelines n'est pas configuré sur ce serveur",
        error: "la lecture du stockage a échoué",
      }[load.status];

      return {
        title,
        facts: `Game ${pick.game_n ?? "?"} de ${seriesPhrase(pick)} : ${result}. Timeline indisponible pour le moment (${why}).`,
        sources: gameSources(pick),
        followUps: followUpsFor(pick.game_n),
        totals: { ...base, timeline: load.status },
        trace: [{ status: "error", title: `Timeline ${pick.riot_key} : ${why}`, detail: load.status === "error" ? load.message : undefined }],
        notes,
      };
    }

    const view = timelineView(pick, load.timeline);
    const at = (min: number) => view.gold.find((g) => Math.abs(g.s - min * 60) <= 30)?.diff ?? "n/d";
    const fb = view.events.find((e) => e.kind === "first_blood");

    return {
      title,
      timeline: view,
      facts: timelineFacts(pick, view),
      sources: [...gameSources(pick), RIOT_DATA_SOURCE],
      followUps: followUpsFor(pick.game_n),
      totals: {
        ...base,
        timeline: "ok",
        blue: view.blue,
        red: view.red,
        winner: view.winner ? (view.winner === "blue" ? view.blue : view.red) : "n/d",
        version: view.version,
        duration_s: view.durationS ?? "n/d",
        gold_diff_10: at(10),
        gold_diff_15: at(15),
        first_blood: fb ? (fb.side === "blue" ? view.blue : view.red) : "n/d",
        events: view.events.length,
      },
      trace: [
        {
          status: "ok",
          title: `Timeline ${pick.riot_key} (match-v${view.version}) lue depuis ${SOURCE_LABEL[load.source]} en ${load.ms} ms`,
          detail: `${view.gold.length} points d'or, ${view.events.length} événements clés. Lecture serveur, en lecture seule : aucune clé n'est envoyée au navigateur.`,
        },
      ],
      notes,
    };
  },
  normalize: (db, input) => {
    const a = input.teamA ? resolveTeam(db, input.teamA) : null;
    const b = input.teamB ? resolveTeam(db, input.teamB) : null;

    if ((input.teamA && !a) || (input.teamB && !b)) return null;

    // A single team in teamB only is the same question.
    return { ...input, teamA: a?.team ?? b?.team ?? null, teamB: a ? (b?.team ?? null) : null };
  },
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
    case "player_ingame_stats":
      return bind(playerIngameStats, db, PlayerIngameInput.parse(call.input), (input) => ({ tool: call.tool, input }));
    case "ingame_leaderboard":
      return bind(ingameLeaderboard, db, LeaderboardInput.parse(call.input), (input) => ({ tool: call.tool, input }));
    case "team_ingame_stats":
      return bind(teamIngameStats, db, TeamIngameInput.parse(call.input), (input) => ({ tool: call.tool, input }));
    case "game_timeline":
      return bind(gameTimeline, db, GameTimelineInput.parse(call.input), (input) => ({ tool: call.tool, input }));
  }
}

/** The same tools, as AI SDK tools for the LLM router (no `execute`: the agent runs them behind the guard). */
export const aiTools = {
  player_event_history: tool({ description: playerEventHistory.description, inputSchema: PlayerHistoryInput }),
  team_history: tool({ description: teamHistory.description, inputSchema: TeamHistoryInput }),
  head_to_head: tool({ description: headToHead.description, inputSchema: HeadToHeadInput }),
  champion_event_stats: tool({ description: championEventStats.description, inputSchema: ChampionStatsInput }),
  tournament_standings: tool({ description: tournamentStandings.description, inputSchema: StandingsInput }),
  player_ingame_stats: tool({ description: playerIngameStats.description, inputSchema: PlayerIngameInput }),
  ingame_leaderboard: tool({ description: ingameLeaderboard.description, inputSchema: LeaderboardInput }),
  team_ingame_stats: tool({ description: teamIngameStats.description, inputSchema: TeamIngameInput }),
  game_timeline: tool({ description: gameTimeline.description, inputSchema: GameTimelineInput }),
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

    case "player_ingame_stats": {
      const input = playerIngameStats.normalize(db, call.input);

      return input && { tool: call.toolName, input };
    }

    case "ingame_leaderboard": {
      const input = ingameLeaderboard.normalize(db, call.input);

      return input && { tool: call.toolName, input };
    }

    case "team_ingame_stats": {
      const input = teamIngameStats.normalize(db, call.input);

      return input && { tool: call.toolName, input };
    }

    case "game_timeline": {
      const input = gameTimeline.normalize(db, call.input);

      return input && { tool: call.toolName, input };
    }
  }
}
