import { z } from "zod";
import type { Answer, PlayerProfile, TableCell } from "./agent/types";
import { DEFAULT_LOCALE, type Locale, NO_DATA, numberFormat, percent, sameLabel } from "./locale";

/**
 * Reads a generic result table as a two-player comparison, when it is one: two rows, one column naming
 * the players, numeric stat columns. Derived figures (winrate, KDA) are computed here from the returned
 * columns only; a figure whose inputs are missing is not shown.
 */

export type Better = "higher" | "lower" | null;

export type ComparedStat = {
  key: string;
  label: string;
  values: Pair<number | null>;
  /** Which value wins the row; null for context figures (games) and unknown columns. */
  better: Better;
  /** Shown as a percentage (winrate, rates). */
  percent: boolean;
  /** Signed metric (differences with the lane opponent): shown with + or −. */
  signed: boolean;
  /** Computed by the page from other columns. */
  derived: boolean;
};

export type ComparedPlayer = { name: string; profile: PlayerProfile | null };

export type Comparison = {
  players: Pair<ComparedPlayer>;
  stats: ComparedStat[];
  /** Index of the player who wins more rows, null on a tie. */
  leader: 0 | 1 | null;
  wins: Pair<number>;
};

const PLAYER_COLUMN = /^(player|joueur|player_name|name|ign|handle|pseudo)$/i;

/** `count`: a sum over the player's games when not averaged, so not comparable across different game counts. */
type Meaning = { label: Record<Locale, string>; better: Better; percent?: boolean; signed?: boolean; count?: boolean };

/** Column name (without avg_/total_ prefixes) → what it means. Order matters: first match wins. */
const MEANINGS: [RegExp, Meaning][] = [
  [/^(games|games_played|parties|nb_games|game_count)$/, { label: { fr: "parties", en: "games" }, better: null }],
  [/^ingame_games$/, { label: { fr: "parties Riot", en: "Riot games" }, better: null }],
  [/^(wins|victoires|won)$/, { label: { fr: "victoires", en: "wins" }, better: "higher", count: true }],
  [/^(losses|defaites|lost)$/, { label: { fr: "défaites", en: "losses" }, better: "lower", count: true }],
  [/^(win_?rate|winrate_pct|win_pct|pct_wins)$/, { label: sameLabel("winrate"), better: "higher", percent: true }],
  [/^kda$/, { label: sameLabel("KDA"), better: "higher" }],
  [/^(kills|deaths|assists)_(\d+)$/, { label: sameLabel("$1 @$2"), better: "higher" }],
  [/^kills(_per_game)?$/, { label: sameLabel("kills"), better: "higher", count: true }],
  [/^deaths(_per_game)?$/, { label: { fr: "morts", en: "deaths" }, better: "lower", count: true }],
  [/^assists(_per_game)?$/, { label: sameLabel("assists"), better: "higher", count: true }],
  [/^gold_diff_?(\d+)$/, { label: { fr: "écart d'or @$1", en: "gold diff @$1" }, better: "higher", signed: true }],
  [/^cs_diff_?(\d+)$/, { label: { fr: "écart CS @$1", en: "CS diff @$1" }, better: "higher", signed: true }],
  [/^xp_diff_?(\d+)$/, { label: { fr: "écart XP @$1", en: "XP diff @$1" }, better: "higher", signed: true }],
  [/^gold_?(\d+)$/, { label: { fr: "or @$1", en: "gold @$1" }, better: "higher" }],
  [/^cs_?(\d+)$/, { label: sameLabel("CS @$1"), better: "higher" }],
  [/^xp_?(\d+)$/, { label: sameLabel("XP @$1"), better: "higher" }],
  [/^gold(_earned)?$/, { label: { fr: "or", en: "gold" }, better: "higher" }],
  [/^(cs|creep_score|minions)$/, { label: sameLabel("CS"), better: "higher" }],
  [/^(damage|damage_dealt|dmg)$/, { label: { fr: "dégâts", en: "damage" }, better: "higher" }],
  [/^damage_taken$/, { label: { fr: "dégâts subis", en: "damage taken" }, better: null }],
  [/^(vision|vision_score)$/, { label: sameLabel("vision"), better: "higher" }],
  [/^wards_placed$/, { label: { fr: "wards posées", en: "wards placed" }, better: "higher" }],
  [/^wards_killed$/, { label: { fr: "wards détruites", en: "wards killed" }, better: "higher" }],
  [/^control_wards$/, { label: sameLabel("control wards"), better: "higher" }],
  [/^solo_kills$/, { label: sameLabel("solo kills"), better: "higher", count: true }],
  [/^first_blood(_kill)?s?$/, { label: sameLabel("first bloods"), better: "higher", count: true }],
  [/^(penta|quadra|triple|double)_kills$/, { label: sameLabel("$1 kills"), better: "higher", count: true }],
  [/^kills_before_10$/, { label: sameLabel("kills < 10 min"), better: "higher", count: true }],
  [/^plates$/, { label: { fr: "plaques", en: "plates" }, better: "higher", count: true }],
];

/** "avg_gold_diff_10" → { base: "gold_diff_10", average: true } */
function baseName(column: string) {
  const lower = column.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const average = /^(avg|average|moy|mean)_|_(avg|average|per_game|pg)$/.test(lower);

  return { base: lower.replace(/^(avg|average|moy|mean|total|sum|nb)_/, "").replace(/_(avg|average|per_game|pg|total)$/, ""), average };
}

function meaningOf(column: string, locale: Locale): Omit<Meaning, "label"> & { label: string; average: boolean } {
  const { base, average } = baseName(column);

  for (const [re, meaning] of MEANINGS) {
    const m = re.exec(base);

    if (m) {
      const deaths = m[1] === "deaths";
      const label = meaning.label[locale].replace("$1", deaths && locale === "fr" ? "morts" : (m[1] ?? "")).replace("$2", m[2] ?? "");

      // "deaths @10" is the one row of its pattern where the lower value wins.
      return { ...meaning, label, better: deaths ? "lower" : meaning.better, average };
    }
  }

  return { label: column.replace(/_/g, " "), better: null, average };
}

const Finite = z.number().finite();

/** A table cell as a stat value: a finite number, else null. */
const numberOf = (v: TableCell) => Finite.safeParse(v).data ?? null;

/** A table cell as a player name: a non-empty text, else null. */
const nameOf = (v: TableCell) => z.string().min(1).safeParse(v).data ?? null;

type Pair<T> = [T, T];

const both = <T>(f: (i: 0 | 1) => T): Pair<T> => [f(0), f(1)];

/** `keep`: a column shown even when both values are n/d (the statistic the question names, without data in the scope). */
export function detectComparison(table: Answer["table"], profiles: PlayerProfile[], keep: string | null = null, locale: Locale = DEFAULT_LOCALE): Comparison | null {
  if (!table || table.rows.length !== 2) return null;

  const named = new Set(profiles.map((p) => p.player.toLowerCase()));

  // The player column: by its name, else the text column whose two values are the named players.
  const nameIndex = table.columns.findIndex((c) => PLAYER_COLUMN.test(c));

  const playerIndex =
    nameIndex >= 0
      ? nameIndex
      : table.columns.findIndex((_, i) => table.rows.every((r) => named.has(nameOf(r[i])?.toLowerCase() ?? "")));

  if (playerIndex < 0) return null;

  const [a, b] = table.rows.map((r) => nameOf(r[playerIndex]));

  if (a == null || b == null || a.toLowerCase() === b.toLowerCase()) return null;

  const stats: ComparedStat[] = [];
  const byBase = new Map<string, { values: Pair<number | null>; average: boolean }>();

  const gamesIndex = table.columns.findIndex((c) => /^(games|games_played|parties|nb_games|game_count)$/.test(baseName(c).base));
  const gameCounts = gamesIndex < 0 ? null : both((r) => numberOf(table.rows[r][gamesIndex]));
  // Totals only compare when both players played as many games; an unknown game count compares nothing.
  const totalsComparable = gameCounts != null && gameCounts[0] != null && gameCounts[0] === gameCounts[1];

  table.columns.forEach((column, i) => {
    if (i === playerIndex) return;

    const cells = both((r) => table.rows[r][i]);
    const pair = both((r) => numberOf(cells[r]));

    // Text columns (team, role…) are not stats; one null cell is allowed (n/d for one player).
    if (cells.some((v, r) => v != null && pair[r] == null) || (pair.every((v) => v == null) && column !== keep)) return;

    const meaning = meaningOf(column, locale);

    byBase.set(baseName(column).base, { values: pair, average: meaning.average });
    const total = (meaning.count ?? false) && !meaning.average;

    stats.push({
      key: column,
      label: total ? `${meaning.label} (total)` : meaning.label,
      values: pair,
      better: total && !totalsComparable ? null : meaning.better,
      percent: meaning.percent ?? false,
      signed: meaning.signed ?? false,
      derived: false,
    });
  });

  if (stats.length < 2) return null;

  const derived: ComparedStat[] = [];
  const games = byBase.get("games") ?? byBase.get("games_played") ?? byBase.get("parties");
  const wins = byBase.get("wins") ?? byBase.get("victoires");

  if (games && wins && !byBase.has("winrate") && !byBase.has("win_rate"))
    derived.push({
      key: "derived:winrate",
      label: "winrate",
      values: both((i) => {
        const g = games.values[i];
        const w = wins.values[i];

        return g && w != null ? (100 * w) / g : null;
      }),
      better: "higher",
      percent: true,
      signed: false,
      derived: true,
    });

  const [k, d, as] = ["kills", "deaths", "assists"].map((key) => byBase.get(key));

  // Same aggregate on all three (all averages or all totals): the ratio is then the same KDA.
  if (k && d && as && !byBase.has("kda") && k.average === d.average && d.average === as.average)
    derived.push({
      key: "derived:kda",
      label: "KDA",
      values: both((i) => {
        const [kv, dv, av] = [k.values[i], d.values[i], as.values[i]];

        return kv == null || dv == null || av == null || dv === 0 ? null : (kv + av) / dv;
      }),
      better: "higher",
      percent: false,
      signed: false,
      derived: true,
    });

  const all = [...derived, ...stats];
  const tally: Pair<number> = [0, 0];

  for (const s of all) {
    const w = rowWinner(s);

    if (w != null) tally[w]++;
  }

  return {
    players: both((i) => {
      const name = i === 0 ? a : b;

      return { name, profile: profiles.find((p) => p.player.toLowerCase() === name.toLowerCase()) ?? null };
    }),
    stats: all,
    leader: tally[0] === tally[1] ? null : tally[0] > tally[1] ? 0 : 1,
    wins: tally,
  };
}

/** Index of the better value of a row, null when the row is not compared or tied. */
export function rowWinner(s: ComparedStat): 0 | 1 | null {
  const [a, b] = s.values;

  if (s.better == null || a == null || b == null || a === b) return null;

  return (s.better === "higher") === a > b ? 0 : 1;
}

/** "2,93", "13 777", "+72", "66,3 %" */
export function formatStat(s: ComparedStat, v: number | null, locale: Locale = DEFAULT_LOCALE): string {
  if (v == null) return NO_DATA[locale];

  if (s.percent) return percent(locale, numberFormat(locale, 2).format(Math.round(v * 10) / 10));

  const text = numberFormat(locale, Math.abs(v) >= 1000 ? 0 : 2).format(Math.abs(v));
  const sign = v < 0 ? "−" : s.signed && v > 0 ? "+" : "";

  return `${sign}${text}`;
}
