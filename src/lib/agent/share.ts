import { z } from "zod";
import { championSortKey, detectChampionRanking, formatChampionValue, RANK_COLUMN } from "../champions";
import { DEFAULT_LOCALE, type Locale, numberFormat } from "../locale";
import { withoutLlm } from "./llm";
import { runAgent } from "./run";
import type { Answer, TableCell } from "./types";

export type ShareCard = {
  title: string;
  line: string;
  heading: string;
  duel: { a: string; b: string; scoreA: number; scoreB: number; caption: string } | null;
  top: { rank: number; name: string; value: string; icon: string | null }[];
  metric: string;
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

const HistoryTotals = z.object({ events: z.number(), wins: z.number(), losses: z.number() });

const LINE_MAX = 200;
const TOP = 3;

const SENTENCE_END = /(?<![:;,]\s\d{1,2})(?<!\b(?:janv|févr|avr|juil|sept|oct|nov|déc))\.(?=\s+[\p{Lu}\d]|\s*$)/u;

function firstSentence(text: string): string {
  const end = text.search(SENTENCE_END);
  const sentence = (end < 0 ? text : text.slice(0, end + 1)).trim();

  return sentence.length > LINE_MAX ? `${sentence.slice(0, LINE_MAX - 1).trimEnd()}…` : sentence;
}

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

export function cardOf(answer: Answer, locale: Locale = DEFAULT_LOCALE): ShareCard | null {
  const { meta } = answer;

  if (!meta.input || meta.rowCount === 0 || meta.unread.length > 0 || meta.empty || meta.ambiguities.some((a) => a.uncertain)) return null;

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

    if (!one.forfeitedBy) card.duel = { a: one.teamA, b: one.teamB, scoreA: one.winsA, scoreB: one.winsB, caption: one.bestOf ? `BO${one.bestOf}` : "" };
  } else if (answer.rows.length) {
    const totals = HistoryTotals.safeParse(meta.totals).data;
    const best = answer.rows.filter((r) => r.placeNumber != null).toSorted((x, y) => x.placeNumber! - y.placeNumber! || y.year - x.year)[0];

    if (totals)
      card.figures = [
        { label: t.events, value: String(totals.events) },
        { label: t.record, value: `${totals.wins}-${totals.losses}` },
        ...(best ? [{ label: t.best, value: `${best.placeLabel} ${best.year}` }] : []),
      ];
  } else {
    Object.assign(card, ranking(answer, locale));
  }

  return card;
}

type Remembered = { at: number; card: Promise<ShareCard | null> };

const cards = new Map<string, Remembered>();

const CARD_TTL_MS = 5 * 60 * 1_000;
const MAX_CARDS = 500;

export function rememberCard(key: string, compute: () => Promise<ShareCard | null>, now = Date.now()): Promise<ShareCard | null> {
  const known = cards.get(key);

  if (known && now - known.at < CARD_TTL_MS) return known.card;

  if (known) cards.delete(key);

  if (cards.size >= MAX_CARDS) {
    const oldest = cards.keys().next().value;

    if (oldest !== undefined) cards.delete(oldest);
  }

  const entry: Remembered = { at: now, card: Promise.resolve(null) };
  entry.card = compute().catch(() => {
    if (cards.get(key) === entry) cards.delete(key);

    return null;
  });
  cards.set(key, entry);

  return entry.card;
}

export function clearShareCards() {
  cards.clear();
}

export function shareCard(question: string, locale: Locale = DEFAULT_LOCALE): Promise<ShareCard | null> {
  return rememberCard(`${locale}\n${question}`, async () =>
    cardOf(await withoutLlm(() => runAgent(question, () => {}, undefined, undefined, locale)), locale),
  );
}
