import { z } from "zod";
import type { Answer, TableCell } from "./agent/types";

/**
 * Reads a result table as a champion ranking, when it is one: a column of champion names that have an
 * icon, numeric columns, and no other text column. Works for the champion_ranking tool and for generated
 * tables ("champions les plus bannis"); anything else stays a plain table.
 */

/** Column names that hold a champion's name. */
export const CHAMPION_COLUMN = /^(champion|champion_name|champ|champions|nom_champion)$/i;

const RANK_COLUMN = /^(rank|rang|position|#)$/i;

export type ChampionMetric = { key: string; label: string; percent: boolean };

export type ChampionRankingLine = { rank: number; champion: string; icon: string | null; values: (number | null)[] };

export type ChampionRanking = {
  metrics: ChampionMetric[];
  /** Index of the metric the ranking is ordered by: it gets the bar. */
  primary: number;
  lines: ChampionRankingLine[];
};

const LABELS: [RegExp, string, boolean][] = [
  [/^(picks?|nb_picks|pick_count|times_picked)$/, "picks", false],
  [/^(bans?|nb_bans|ban_count|times_banned)$/, "bans", false],
  [/^(presence|presence_pct|presence_rate)$/, "présence", true],
  [/^(win_?rate|winrate_pct|win_pct)$/, "winrate", true],
  [/^(pick_?rate|pick_pct)$/, "pick rate", true],
  [/^(ban_?rate|ban_pct)$/, "ban rate", true],
  [/^kda$/, "KDA", false],
  [/^(games|parties|games_played)$/, "parties", false],
  [/^(wins|victoires)$/, "victoires", false],
  [/^(deaths|morts)$/, "morts", false],
  [/^gold$/, "or", false],
  [/^cs$/, "CS", false],
  [/^(damage|degats)$/, "dégâts", false],
  [/^dpm$/, "dégâts/min", false],
  [/^gpm$/, "or/min", false],
  [/^cspm$/, "CS/min", false],
  [/^gold_diff_15$/, "écart or @15", false],
  [/^cs_diff_15$/, "écart CS @15", false],
  [/^xp_diff_15$/, "écart XP @15", false],
  [/^first_blood$/, "first blood", true],
  [/^solo_kills$/, "solo kills", false],
  [/^(players|joueurs)$/, "joueurs", false],
];

function metricOf(column: string): ChampionMetric {
  const key = column.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const hit = LABELS.find(([re]) => re.test(key));

  return { key: column, label: hit?.[1] ?? column.replace(/_/g, " "), percent: hit?.[2] ?? /pct|percent|rate/.test(key) };
}

const Finite = z.number().finite();

const numberOf = (v: TableCell) => Finite.safeParse(v).data ?? null;

const textOf = (v: TableCell) => z.string().min(1).safeParse(v).data ?? null;

export function detectChampionRanking(table: Answer["table"], icons: Record<string, string>, sortKey?: string): ChampionRanking | null {
  if (!table || table.rows.length === 0) return null;

  const nameIndex = table.columns.findIndex((c) => CHAMPION_COLUMN.test(c));

  if (nameIndex < 0) return null;

  // Most names must be known champions: a column called "champion" holding something else is not a ranking.
  const names = table.rows.map((r) => textOf(r[nameIndex]));

  if (names.some((n) => n == null) || names.filter((n) => icons[n!]).length < Math.ceil(names.length / 2)) return null;

  const rankIndex = table.columns.findIndex((c) => RANK_COLUMN.test(c));
  const metricIndexes: number[] = [];

  for (const i of table.columns.keys()) {
    if (i === nameIndex || i === rankIndex) continue;

    const cells = table.rows.map((r) => r[i]);

    // Another text column (a player, a team...): the table is about something else than champions alone.
    if (cells.some((v) => v != null && numberOf(v) == null)) return null;

    if (cells.some((v) => v != null)) metricIndexes.push(i);
  }

  if (!metricIndexes.length) return null;

  const metrics = metricIndexes.map((i) => metricOf(table.columns[i]));

  const lines = table.rows.map((r, n) => ({
    rank: (rankIndex >= 0 ? numberOf(r[rankIndex]) : null) ?? n + 1,
    champion: names[n]!,
    icon: icons[names[n]!] ?? null,
    values: metricIndexes.map((i) => numberOf(r[i])),
  }));

  // The ordering metric: the one the tool says, else the first one that never increases down the table.
  const hinted = sortKey ? metrics.findIndex((m) => m.key === sortKey) : -1;

  const sorted = metrics.findIndex((_, m) =>
    lines.every((l, i) => i === 0 || (l.values[m] ?? Number.NEGATIVE_INFINITY) <= (lines[i - 1].values[m] ?? Number.NEGATIVE_INFINITY)),
  );

  return { metrics, primary: hinted >= 0 ? hinted : Math.max(0, sorted), lines };
}

const NUMBER = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 });

/** "1 233", "43,9 %", "n/d" */
export function formatChampionValue(v: number | null, percent: boolean): string {
  if (v == null) return "n/d";

  return percent ? `${NUMBER.format(Math.round(v * 10) / 10)} %` : NUMBER.format(v);
}
