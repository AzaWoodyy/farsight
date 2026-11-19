import { z } from "zod";
import { championSortKey, detectChampionRanking, formatChampionValue, RANK_COLUMN } from "../champions";
import { DEFAULT_LOCALE, type Locale, numberFormat } from "../locale";
import { withoutLlm } from "./llm";
import { runAgent } from "./run";
import type { Answer, TableCell } from "./types";

/**
 * What the preview of a link to an answer shows (`/?q=…` pasted in a chat): the page's title and description,
 * and the figures its image draws. Everything comes from the answer, nothing from the visitor's text.
 */
export type ShareCard = {
  /** The answer's own title, written from the resolved entities. */
  title: string;
  /** The first sentence of the summary: the description of the link, and the body of an image without figures. */
  line: string;
  /** What the image writes above its figures: the title, or the part of it the figures do not already say. */
  heading: string;
  /** Two sides and their score: one series, two teams, two players. */
  duel: { a: string; b: string; scoreA: number; scoreB: number; caption: string } | null;
  /** The head of a ranking, and what its values count ("bans", "KDA"). */
  top: { rank: number; name: string; value: string; icon: string | null }[];
  metric: string;
  /** The key figures of a player's or a team's history. */
  figures: { label: string; value: string }[];
};

const LABELS: Record<Locale, { faced: (games: number) => string; series: (n: number) => string; events: string; record: string; best: string }> = {
  fr: {
    faced: (games) => `victoires · ${games} parties face à face`,
    series: (n) => `parties gagnées · ${n} série${n > 1 ? "s" : ""}`,
    events: "tournois",
    record: "victoires-défaites",
    best: "meilleur résultat",
  },
  en: {
    faced: (games) => `wins · ${games} head-to-head games`,
    series: (n) => `games won · ${n} series`,
    events: "tournaments",
    record: "wins-losses",
    best: "best result",
  },
};

const LINE_MAX = 200;
const TOP = 3;

/** A period that ends a sentence: not the one of "nov. 2025" or "Gen.G", which no capital letter follows. */
const SENTENCE_END = /\.(?=\s+\p{Lu}|\s*$)/u;

function firstSentence(text: string): string {
  const end = text.search(SENTENCE_END);
  const sentence = (end < 0 ? text : text.slice(0, end + 1)).trim();

  return sentence.length > LINE_MAX ? `${sentence.slice(0, LINE_MAX - 1).trimEnd()}…` : sentence;
}

/** The first rows of a ranked table and the column that ranks them, when the answer says which one it is. */
function ranking(answer: Answer, locale: Locale): Pick<ShareCard, "top" | "metric"> | null {
  const { table } = answer;

  if (!table || !RANK_COLUMN.test(table.columns[0] ?? "")) return null;

  const champions = detectChampionRanking(table, answer.icons, championSortKey(answer.meta.input), locale);

  if (champions) {
    const metric = champions.metrics[champions.primary];

    return {
      metric: metric.label,
      top: champions.lines.slice(0, TOP).map((l) => ({ rank: l.rank, name: l.champion, value: formatChampionValue(l.values[champions.primary], metric.percent, locale), icon: l.icon })),
    };
  }

  const at = table.focus ? table.columns.indexOf(table.focus) : -1;

  if (at < 0) return null;

  const text = (v: TableCell) => {
    const n = z.number().safeParse(v).data;

    return n == null ? String(v ?? "") : numberFormat(locale, 2).format(n);
  };

  return { metric: table.columns[at], top: table.rows.slice(0, TOP).map((r) => ({ rank: Number(r[0]), name: String(r[1] ?? ""), value: text(r[at] ?? null), icon: null })) };
}

/**
 * The card of an answer, or null when the link keeps the site's own card: a typed tool must have answered,
 * with rows and without a word left unread. An answer in doubt is not put on an image.
 */
export function cardOf(answer: Answer, locale: Locale = DEFAULT_LOCALE): ShareCard | null {
  const { meta } = answer;

  if (!meta.input || meta.rowCount === 0 || meta.unread.length > 0 || meta.empty) return null;

  const t = LABELS[locale];
  const card: ShareCard = { title: answer.title, line: firstSentence(answer.summary), heading: answer.title, duel: null, top: [], metric: "", figures: [] };
  const faced = answer.versus?.focus == null ? answer.versus?.h2h?.rows : undefined;
  const one = answer.series?.count === 1 ? answer.series.series[0] : null;

  if (faced?.length === 2 && Number(faced[0][1]) > 0) {
    const [a, b] = faced;
    card.duel = { a: String(a[0]), b: String(b[0]), scoreA: Number(a[2]), scoreB: Number(b[2]), caption: t.faced(Number(a[1])) };
  } else if (answer.teams && answer.teams.seriesCount > 0) {
    const { teamA, teamB, gamesA, gamesB, seriesCount } = answer.teams;
    card.duel = { a: teamA, b: teamB, scoreA: gamesA, scoreB: gamesB, caption: t.series(seriesCount) };
  } else if (one) {
    card.heading = one.label;
    card.duel = { a: one.teamA, b: one.teamB, scoreA: one.winsA, scoreB: one.winsB, caption: one.bestOf ? `BO${one.bestOf}` : "" };
  } else if (answer.rows.length) {
    const best = answer.rows.filter((r) => r.placeNumber != null).toSorted((x, y) => x.placeNumber! - y.placeNumber! || y.year - x.year)[0];

    card.figures = [
      { label: t.events, value: String(answer.rows.length) },
      { label: t.record, value: `${answer.rows.reduce((n, r) => n + r.wins, 0)}-${answer.rows.reduce((n, r) => n + r.losses, 0)}` },
      ...(best ? [{ label: t.best, value: `${best.placeLabel} ${best.year}` }] : []),
    ];
  } else {
    Object.assign(card, ranking(answer, locale));
  }

  return card;
}

/** The card of a question, computed by the rules alone: a link preview never calls the model. */
export async function shareCard(question: string, locale: Locale = DEFAULT_LOCALE): Promise<ShareCard | null> {
  const answer = await withoutLlm(() => runAgent(question, () => {}, undefined, undefined, locale)).catch(() => null);

  return answer && cardOf(answer, locale);
}
