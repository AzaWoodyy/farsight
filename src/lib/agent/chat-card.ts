import { answerLocale, say } from "./messages";
import type { ChatCard, ChatCardImage, ChatCardSubject, ChatCardTable } from "./chat-types";
import type { Answer, TableCell } from "./types";

const CARD_ROWS = 40;
const CARD_COLUMNS = 6;
const CARD_BARS = 8;
const CARD_SUBJECTS = 2;
const SUBJECT_TEAMS = 3;
const NUMERIC = /^[-+]?[\d\s.,]+ ?%?$/;

const pct = (wins: number, games: number) => (games > 0 ? `${Math.round((100 * wins) / games)} %` : "–");

const record = (wins: number, losses: number) => say(`${wins} V – ${losses} D`, `${wins} W – ${losses} L`);

const clock = (seconds: number | null) => (seconds == null ? "–" : `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`);

function day(playedAt: number | null): string {
  return playedAt == null ? "–" : new Intl.DateTimeFormat(answerLocale(), { dateStyle: "medium", timeZone: "UTC" }).format(new Date(playedAt * 1000));
}

const table = (columns: string[], rows: TableCell[][]): ChatCardTable => {
  const kept = columns.slice(0, CARD_COLUMNS).map((c) => c.replaceAll("_", " "));

  return {
    columns: kept,
    rows: rows.slice(0, CARD_ROWS).map((r) => r.slice(0, kept.length)),
    numeric: kept.map((_, i) => rows.length > 0 && rows.every((r) => r[i] == null || NUMERIC.test(String(r[i])))),
    total: rows.length,
  };
};

export const tableCard = (title: string, columns: string[], rows: TableCell[][]): ChatCard => ({ title, stats: [], bars: null, table: table(columns, rows) });

function plainCard(answer: Answer): ChatCard | null {
  const base = { title: answer.title, stats: [], bars: null, table: null } satisfies ChatCard;

  if (answer.rows.length) {
    const wins = answer.rows.reduce((n, r) => n + r.wins, 0);
    const losses = answer.rows.reduce((n, r) => n + r.losses, 0);

    return {
      ...base,
      stats: [
        { label: say("Éditions", "Editions"), value: String(answer.rows.length) },
        { label: say("Bilan en parties", "Game record"), value: record(wins, losses) },
        { label: say("Victoires", "Win rate"), value: pct(wins, wins + losses) },
      ],
      table: table(
        [say("Année", "Year"), say("Équipe", "Team"), say("Résultat", "Result"), say("V-D", "W-L")],
        answer.rows.map((r) => [r.year, r.team, r.place ? `${r.placeLabel} (${r.place})` : r.placeLabel, `${r.wins}-${r.losses}`]),
      ),
    };
  }

  if (answer.pool) {
    const p = answer.pool;
    const most = Math.max(1, ...p.lines.map((l) => l.games));

    return {
      ...base,
      stats: [
        { label: say("Parties", "Games"), value: String(p.games) },
        { label: say("Bilan", "Record"), value: record(p.wins, p.losses) },
        { label: say("Champions joués", "Champions played"), value: String(p.unique) },
      ],
      bars: p.lines.slice(0, CARD_BARS).map((l) => ({
        label: l.champion,
        value: (100 * l.games) / most,
        text: say(`${l.games} p. · ${pct(l.wins, l.games)}`, `${l.games} g · ${pct(l.wins, l.games)}`),
      })),
    };
  }

  if (answer.teams) {
    const t = answer.teams;

    return {
      ...base,
      stats: [
        { label: say("Séries", "Series"), value: `${t.teamA} ${t.seriesA} – ${t.seriesB} ${t.teamB}` },
        { label: say("Parties", "Games"), value: `${t.gamesA} – ${t.gamesB}` },
      ],
      table: table(
        ["Date", say("Rencontre", "Match"), "Score"],
        t.series.map((s) => [day(s.playedAt), s.label, `${s.teamA} ${s.winsA}-${s.winsB} ${s.teamB}`]),
      ),
    };
  }

  if (answer.versus) {
    const v = answer.versus;

    return { ...base, stats: [{ label: say("Périmètre", "Scope"), value: v.scope }], table: table(v.global.columns, v.global.rows) };
  }

  if (answer.roster) {
    const r = answer.roster;

    return {
      ...base,
      stats: [
        { label: say("Parties", "Games"), value: String(r.games) },
        { label: say("Victoires", "Win rate"), value: pct(r.wins, r.games) },
      ],
      table: table(
        [say("Rôle", "Role"), say("Joueur", "Player"), say("Parties", "Games"), say("Victoires", "Win rate")],
        r.players.map((p) => [p.role, p.starter ? p.player : substitute(p.player), p.games, pct(p.wins, p.games)]),
      ),
    };
  }

  if (answer.champion) {
    const c = answer.champion;

    return {
      ...base,
      stats: [
        { label: "Picks", value: String(c.picks) },
        { label: "Bans", value: String(c.bans) },
        { label: say("Victoires", "Win rate"), value: pct(c.wins, c.picks) },
        { label: "KDA", value: c.kda == null ? "–" : String(c.kda) },
      ],
      table: c.players.length
        ? table(
            [say("Joueur", "Player"), say("Équipe", "Team"), say("Parties", "Games"), say("Victoires", "Win rate"), "KDA"],
            c.players.map((p) => [p.player, p.team, p.games, pct(p.wins, p.games), p.kda]),
          )
        : null,
    };
  }

  if (answer.runes) {
    const r = answer.runes;
    const keystones = r.runes.filter((x) => x.kind === "keystone");
    const most = Math.max(1, ...keystones.map((k) => k.games));

    return {
      ...base,
      stats: [
        { label: say("Parties", "Games"), value: String(r.games) },
        { label: say("Victoires", "Win rate"), value: pct(r.wins, r.games) },
      ],
      bars: keystones.slice(0, CARD_BARS).map((k) => ({
        label: k.rune,
        value: (100 * k.games) / most,
        text: say(`${k.games} p. · ${pct(k.wins, k.games)}`, `${k.games} g · ${pct(k.wins, k.games)}`),
      })),
    };
  }

  if (answer.series) {
    const only = answer.series.series.length === 1 ? answer.series.series[0] : null;

    if (only?.games)
      return {
        ...base,
        stats: [
          { label: "Score", value: `${only.teamA} ${only.winsA} – ${only.winsB} ${only.teamB}` },
          { label: "Date", value: day(only.playedAt) },
        ],
        table: table(
          [say("Partie", "Game"), say("Côté bleu", "Blue side"), say("Côté rouge", "Red side"), say("Vainqueur", "Winner"), say("Durée", "Length")],
          only.games.map((g, i) => [g.n ?? i + 1, g.blue, g.red, g.winner === "blue" ? g.blue : g.winner === "red" ? g.red : "–", clock(g.durationS)]),
        ),
      };

    return {
      ...base,
      stats: [{ label: say("Séries", "Series"), value: String(answer.series.count) }],
      table: table(
        ["Date", say("Rencontre", "Match"), "Score"],
        answer.series.series.map((s) => [day(s.playedAt), s.label, `${s.teamA} ${s.winsA}-${s.winsB} ${s.teamB}`]),
      ),
    };
  }

  if (answer.scoreboard) {
    const g = answer.scoreboard;

    return {
      ...base,
      stats: [
        { label: say("Vainqueur", "Winner"), value: g.winner === "blue" ? g.blue.name : g.winner === "red" ? g.red.name : "–" },
        { label: say("Durée", "Length"), value: clock(g.durationS) },
        { label: "Kills", value: `${g.blue.kills ?? "–"} – ${g.red.kills ?? "–"}` },
      ],
      table: table(
        [say("Équipe", "Team"), say("Rôle", "Role"), say("Joueur", "Player"), "Champion", "K/D/A"],
        g.players.map((p) => [p.side === "blue" ? g.blue.name : g.red.name, p.role, p.player, p.champion, `${p.kills ?? "–"}/${p.deaths ?? "–"}/${p.assists ?? "–"}`]),
      ),
    };
  }

  if (answer.timeline) {
    const t = answer.timeline;
    const lead = t.gold.at(-1)?.diff ?? null;

    return {
      ...base,
      stats: [
        { label: say("Vainqueur", "Winner"), value: t.winner === "blue" ? t.blue : t.winner === "red" ? t.red : "–" },
        { label: say("Durée", "Length"), value: clock(t.durationS) },
        { label: say("Écart d'or final", "Final gold lead"), value: lead == null ? "–" : `${lead > 0 ? t.blue : t.red} +${Math.abs(lead)}` },
      ],
      table: table(
        [say("Temps", "Time"), say("Équipe", "Team"), say("Événement", "Event")],
        t.events.map((e) => [clock(e.s), e.side === "blue" ? t.blue : t.red, e.detail ?? e.kind]),
      ),
    };
  }

  if (answer.table?.rows.length) return tableCard(answer.title, answer.table.columns, answer.table.rows);

  return null;
}

const substitute = (player: string) => say(`${player} (remplaçant)`, `${player} (substitute)`);

function knownImages(answer: Answer): Map<string, ChatCardImage> {
  const known = new Map<string, ChatCardImage>();

  const add = (name: string | null, src: string | null | undefined, photo = false) => {
    if (name && src && !known.has(name)) known.set(name, photo ? { src, photo } : { src, tone: answer.iconTones[name] });
  };

  for (const [name, src] of Object.entries(answer.icons)) add(name, src);

  for (const p of answer.profiles) add(p.player, p.photo?.url, true);

  for (const l of answer.pool?.lines ?? []) add(l.champion, l.icon);

  for (const r of answer.runes?.runes ?? []) add(r.rune, r.icon);

  for (const p of answer.roster?.players ?? []) {
    add(p.player, p.photo?.url, true);
    add(substitute(p.player), p.photo?.url, true);
  }

  for (const p of answer.scoreboard?.players ?? []) {
    add(p.player, p.photo?.url, true);
    add(p.champion, p.championIcon);
  }

  if (answer.champion) add(answer.champion.champion, answer.champion.icon);

  return known;
}

function subjectsOf(answer: Answer, known: Map<string, ChatCardImage>): ChatCardSubject[] {
  const named = (name: string, line: string | null): ChatCardSubject => ({ name, line, image: known.get(name) ?? null });

  if (answer.profiles.length > 0 && answer.profiles.length <= CARD_SUBJECTS)
    return answer.profiles.map((p) => named(p.player, [p.role, p.teams.slice(0, SUBJECT_TEAMS).join(", ")].filter(Boolean).join(" · ") || null));

  if (answer.teams) return [named(answer.teams.teamA, null), named(answer.teams.teamB, null)];

  if (answer.roster) return [named(answer.roster.team, answer.roster.scope)];

  if (answer.champion) return [named(answer.champion.champion, answer.champion.scope)];

  return [];
}

export function chatCard(answer: Answer): ChatCard | null {
  const card = plainCard(answer);

  if (!card) return null;

  const known = knownImages(answer);
  const shown = new Set([...(card.table?.rows.flat() ?? []), ...(card.bars ?? []).map((b) => b.label)].map(String));

  return {
    ...card,
    subjects: subjectsOf(answer, known),
    icons: Object.fromEntries([...known].filter(([name]) => shown.has(name))),
  };
}
