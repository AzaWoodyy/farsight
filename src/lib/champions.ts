import { z } from "zod";
import type { Answer, TableCell } from "./agent/types";
import { DEFAULT_LOCALE, type Locale, NO_DATA, numberFormat, percent, sameLabel } from "./locale";

export const CHAMPION_COLUMN = /^(champion|champion_name|champ|champions|nom_champion)$/i;

export const RANK_COLUMN = /^(rank|rang|position|#)$/i;

export type ChampionMetric = { key: string; label: string; percent: boolean };

export type ChampionRankingLine = { rank: number; champion: string; icon: string | null; values: (number | null)[] };

export type ChampionRanking = {
  metrics: ChampionMetric[];
  primary: number;
  lines: ChampionRankingLine[];
};

const LABELS: [RegExp, Record<Locale, string>, boolean][] = [
  [/^(picks?|nb_picks|pick_count|times_picked)$/, sameLabel("picks"), false],
  [/^(bans?|nb_bans|ban_count|times_banned)$/, sameLabel("bans"), false],
  [/^(presence|presence_pct|presence_rate)$/, { fr: "présence", en: "presence" }, true],
  [/^(win_?rate|winrate_pct|win_pct)$/, sameLabel("winrate"), true],
  [/^(pick_?rate|pick_pct)$/, sameLabel("pick rate"), true],
  [/^(ban_?rate|ban_pct)$/, sameLabel("ban rate"), true],
  [/^kda$/, sameLabel("KDA"), false],
  [/^(games|parties|games_played)$/, { fr: "parties", en: "games" }, false],
  [/^(wins|victoires)$/, { fr: "victoires", en: "wins" }, false],
  [/^(deaths|morts)$/, { fr: "morts", en: "deaths" }, false],
  [/^gold$/, { fr: "or", en: "gold" }, false],
  [/^cs$/, sameLabel("CS"), false],
  [/^(damage|degats)$/, { fr: "dégâts", en: "damage" }, false],
  [/^dpm$/, { fr: "dégâts/min", en: "damage/min" }, false],
  [/^gpm$/, { fr: "or/min", en: "gold/min" }, false],
  [/^cspm$/, sameLabel("CS/min"), false],
  [/^gold_diff_15$/, { fr: "écart or @15", en: "gold diff @15" }, false],
  [/^cs_diff_15$/, { fr: "écart CS @15", en: "CS diff @15" }, false],
  [/^xp_diff_15$/, { fr: "écart XP @15", en: "XP diff @15" }, false],
  [/^first_blood$/, sameLabel("first blood"), true],
  [/^solo_kills$/, sameLabel("solo kills"), false],
  [/^(players|joueurs)$/, { fr: "joueurs", en: "players" }, false],
  [/^kills$/, sameLabel("kills"), false],
  [/^assists$/, sameLabel("assists"), false],
  [/^vision$/, sameLabel("vision"), false],
  [/^penta_kills$/, sameLabel("pentakills"), false],
  [/^quadra_kills$/, sameLabel("quadrakills"), false],
  [/^triple_kills$/, sameLabel("triple kills"), false],
  [/^double_kills$/, sameLabel("double kills"), false],
];

function metricOf(column: string, locale: Locale): ChampionMetric {
  const labelOf = (name: string) => LABELS.find(([re]) => re.test(name))?.[1][locale];

  const key = column.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

  if (key.startsWith("total_")) {
    const base = labelOf(key.slice(6)) ?? key.slice(6).replace(/_/g, " ");

    return { key: column, label: `${base} (total)`, percent: false };
  }

  const hit = LABELS.find(([re]) => re.test(key));

  return { key: column, label: labelOf(key) ?? column.replace(/_/g, " "), percent: hit?.[2] ?? /pct|percent|rate/.test(key) };
}

const Finite = z.number().finite();

const numberOf = (v: TableCell) => Finite.safeParse(v).data ?? null;

const textOf = (v: TableCell) => z.string().min(1).safeParse(v).data ?? null;

export function championSortKey(input: Answer["meta"]["input"]): string | undefined {
  if (!input || !("sort" in input)) return undefined;

  return "total" in input && input.total ? `total_${input.sort}` : input.sort;
}

export function detectChampionRanking(table: Answer["table"], icons: Record<string, string>, sortKey?: string, locale: Locale = DEFAULT_LOCALE): ChampionRanking | null {
  if (!table || table.rows.length === 0) return null;

  const nameIndex = table.columns.findIndex((c) => CHAMPION_COLUMN.test(c));

  if (nameIndex < 0) return null;

  const names = table.rows.map((r) => textOf(r[nameIndex]));

  if (names.some((n) => n == null) || names.filter((n) => icons[n!]).length < Math.ceil(names.length / 2)) return null;

  const rankIndex = table.columns.findIndex((c) => RANK_COLUMN.test(c));
  const metricIndexes: number[] = [];

  for (const i of table.columns.keys()) {
    if (i === nameIndex || i === rankIndex) continue;

    const cells = table.rows.map((r) => r[i]);

    if (cells.some((v) => v != null && numberOf(v) == null)) return null;

    if (cells.some((v) => v != null)) metricIndexes.push(i);
  }

  if (!metricIndexes.length) return null;

  const metrics = metricIndexes.map((i) => metricOf(table.columns[i], locale));

  const lines = table.rows.map((r, n) => ({
    rank: (rankIndex >= 0 ? numberOf(r[rankIndex]) : null) ?? n + 1,
    champion: names[n]!,
    icon: icons[names[n]!] ?? null,
    values: metricIndexes.map((i) => numberOf(r[i])),
  }));

  const hinted = sortKey ? metrics.findIndex((m) => m.key === sortKey) : -1;

  const sorted = metrics.findIndex((_, m) =>
    lines.every((l, i) => i === 0 || (l.values[m] ?? Number.NEGATIVE_INFINITY) <= (lines[i - 1].values[m] ?? Number.NEGATIVE_INFINITY)),
  );

  return { metrics, primary: hinted >= 0 ? hinted : Math.max(0, sorted), lines };
}

export function formatChampionValue(v: number | null, isPercent: boolean, locale: Locale = DEFAULT_LOCALE): string {
  if (v == null) return NO_DATA[locale];
  const number = numberFormat(locale, 2);

  return isPercent ? percent(locale, number.format(Math.round(v * 10) / 10)) : number.format(v);
}
