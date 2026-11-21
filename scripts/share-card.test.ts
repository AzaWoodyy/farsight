import { describe, expect, test } from "bun:test";
import { getLlm, withoutLlm } from "../src/lib/agent/llm";
import { cardOf, clearShareCards, rememberCard, type ShareCard } from "../src/lib/agent/share";
import type { ChampionRankingInput } from "../src/lib/agent/tools";
import type { Answer, ResultRow, SeriesDetail } from "../src/lib/agent/types";

/** An answer a typed tool gave, with rows and nothing left unread: the only kind that gets a card. */
function answer(over: Partial<Omit<Answer, "meta">> = {}, meta: Partial<Answer["meta"]> = {}): Answer {
  return {
    title: "Chovy — Worlds",
    summary: "Chovy a disputé 8 éditions des Worlds (2019–2026). Meilleur résultat : finaliste en 2026.",
    rows: [],
    table: null,
    timeline: null,
    scoreboard: null,
    versus: null,
    teams: null,
    roster: null,
    champion: null,
    pool: null,
    series: null,
    icons: {},
    iconTones: {},
    teamLeagues: {},
    profiles: [],
    sources: [],
    followUps: [],
    notes: [],
    ...over,
    meta: {
      route: "player_event_history",
      sqlAvailable: false,
      // Only its presence is read (a typed tool answered), and `sort` by a champion ranking.
      input: ranked("picks"),
      players: [],
      teams: [],
      champion: null,
      league: null,
      rowCount: 3,
      totals: {},
      ambiguities: [],
      attempts: 1,
      unread: [],
      empty: null,
      ...meta,
    },
  };
}

const ranked = (sort: ChampionRankingInput["sort"]): ChampionRankingInput => ({ league: null, yearFrom: null, yearTo: null, sort, total: false, role: null, side: null, minPicks: null });

const row = (year: number, placeNumber: number | null, placeLabel: string, wins: number, losses: number): ResultRow => ({
  year, event: `Worlds ${year}`, team: "Gen.G", place: placeNumber == null ? null : String(placeNumber), placeLabel, placeNumber, wins, losses, champions: [],
});

const series = (over: Partial<SeriesDetail> = {}): SeriesDetail => ({
  label: "Worlds 2025 · finale", tournamentPage: "2025 Season World Championship/Main Event", playedAt: null, teamA: "T1", teamB: "KT Rolster", winsA: 3, winsB: 2, bestOf: 5, games: null,
  scheduleOnly: false, forfeitedBy: null,
  source: { label: "Leaguepedia", url: "https://lol.fandom.com/wiki/2025_Season_World_Championship" },
  ...over,
});

describe("which answers get a card", () => {
  test.each<[string, Partial<Answer["meta"]>]>([
    ["no typed tool answered (generated SQL, out of scope)", { input: null }],
    ["no row", { rowCount: 0 }],
    ["a word of the question was not read", { unread: ["progressé"] }],
    ["an explained empty result", { empty: "no_games" }],
  ])("none when %s", (_, meta) => {
    expect(cardOf(answer({}, meta))).toBeNull();
  });

  test("the answer's title and first sentence, never more", () => {
    const card = cardOf(answer());

    expect(card).toMatchObject({ title: "Chovy — Worlds", heading: "Chovy — Worlds", line: "Chovy a disputé 8 éditions des Worlds (2019–2026).", duel: null, top: [], figures: [] });
  });

  test("an abbreviation or a decimal does not end the sentence", () => {
    expect(cardOf(answer({ summary: "T1 bat Gen.G 3-2 le 9 nov. 2025, KDA 3.13. Game 1 : T1 en 36:10." }))?.line).toBe("T1 bat Gen.G 3-2 le 9 nov. 2025, KDA 3.13.");
  });

  test("the rank of a list does not end the sentence either; a number that closes or opens one does", () => {
    const ranking = "Part des parties avec premier dragon au MSI (2023) : 1. PSG Talon (6 sur 9 parties, 66.7 %), 2. T1 (11 sur 17 parties, 64.7 %). 76 parties avec données in-game.";
    const matchup = "Azir contre Orianna : 24 parties, Azir en gagne 9 (38 %) et Orianna 15. KDA d'Azir : 2,26, d'Orianna : 4,88.";

    expect(cardOf(answer({ summary: ranking }))?.line).toBe("Part des parties avec premier dragon au MSI (2023) : 1. PSG Talon (6 sur 9 parties, 66.7 %), 2. T1 (11 sur 17 parties, 64.7 %).");
    expect(cardOf(answer({ summary: matchup }))?.line).toBe("Azir contre Orianna : 24 parties, Azir en gagne 9 (38 %) et Orianna 15.");
  });

  test("a long sentence is cut", () => {
    const line = cardOf(answer({ summary: `${"Faker ".repeat(60)}gagne.` }))?.line ?? "";

    expect(line).toHaveLength(200);
    expect(line.endsWith("…")).toBe(true);
  });
});

describe("score of two sides", () => {
  test("one series: its score, under its label", () => {
    const card = cardOf(answer({ title: "T1 3-2 KT Rolster — Worlds 2025 · finale", series: { scope: "Worlds 2025 · finale", count: 1, series: [series()] } }));

    expect(card).toMatchObject({ title: "T1 3-2 KT Rolster — Worlds 2025 · finale", heading: "Worlds 2025 · finale", duel: { a: "T1", b: "KT Rolster", scoreA: 3, scoreB: 2, caption: "BO5" } });
  });

  test("several series are not one score", () => {
    expect(cardOf(answer({ series: { scope: "Worlds 2025", count: 2, series: [series(), series({ label: "Worlds 2025 · demi-finale" })] } }))?.duel).toBeNull();
  });

  test("two teams: games won, over their series", () => {
    const teams = { teamA: "Karmine Corp", teamB: "Movistar KOI", scope: "", seriesA: 12, seriesB: 5, gamesA: 27, gamesB: 16, seriesCount: 17, series: [] };

    expect(cardOf(answer({ teams }))?.duel).toEqual({ a: "Karmine Corp", b: "Movistar KOI", scoreA: 27, scoreB: 16, caption: "parties gagnées · 17 séries" });
    expect(cardOf(answer({ teams }), "en")?.duel?.caption).toBe("games won · 17 series");
    expect(cardOf(answer({ teams: { ...teams, seriesCount: 0, gamesA: 0, gamesB: 0 } }))?.duel).toBeNull();
  });

  describe("two players", () => {
    const versus = {
      playerA: "Faker", playerB: "Chovy", scope: "", focus: null,
      global: { columns: ["player", "games", "wins"], rows: [["Faker", 1560, 1042], ["Chovy", 1002, 696]] },
      h2h: { columns: ["player", "games", "wins"], rows: [["Faker", 146, 70], ["Chovy", 146, 76]] },
      lanes: { same: 146, roles: [] },
      games: [],
    };

    test("their wins against each other", () => {
      expect(cardOf(answer({ versus }))?.duel).toEqual({ a: "Faker", b: "Chovy", scoreA: 70, scoreB: 76, caption: "victoires · 146 parties face à face" });
    });

    test("no score when they never met, or when the question is about one statistic", () => {
      expect(cardOf(answer({ versus: { ...versus, h2h: null } }))?.duel).toBeNull();
      expect(cardOf(answer({ versus: { ...versus, focus: "penta_kills" } }))?.duel).toBeNull();
    });
  });
});

describe("history of a player or a team", () => {
  test("tournaments, record, and the best place (the latest of equal ones)", () => {
    const rows = [row(2024, 2, "Finaliste", 10, 5), row(2025, 5, "Quart de finale", 4, 3), row(2026, 2, "Finaliste", 12, 4)];

    expect(cardOf(answer({ rows }, { totals: { events: 3, wins: 26, losses: 12 } }))?.figures).toEqual([
      { label: "tournois", value: "3" },
      { label: "victoires-défaites", value: "26-12" },
      { label: "meilleur résultat", value: "Finaliste 2026" },
    ]);
  });

  test("no best place when none is known", () => {
    expect(cardOf(answer({ rows: [row(2024, null, "n/d", 1, 2)] }, { totals: { events: 1, wins: 1, losses: 2 } }), "en")?.figures).toEqual([
      { label: "tournaments", value: "1" },
      { label: "wins-losses", value: "1-2" },
    ]);
  });

  test("the counts are the tool's, as its summary writes them: a tournament played for two teams is one", () => {
    const rows = [row(2025, 3, "Demi-finale", 6, 4), row(2025, 3, "Demi-finale", 2, 1)];

    expect(cardOf(answer({ rows }, { totals: { events: 1, wins: 8, losses: 5 } }))?.figures.slice(0, 2)).toEqual([
      { label: "tournois", value: "1" },
      { label: "victoires-défaites", value: "8-5" },
    ]);
    expect(cardOf(answer({ rows }))?.figures).toEqual([]);
  });
});

describe("head of a ranking", () => {
  const icons = { Vi: "vi.png", Kalista: "kalista.png", Azir: "azir.png", Rumble: "rumble.png" };
  const champions = { columns: ["rank", "champion", "picks", "bans", "presence"], rows: [[1, "Vi", 82, 287, 68.7], [2, "Kalista", 45, 259, 56.6], [3, "Azir", 118, 247, 68], [4, "Rumble", 90, 200, 54]] };

  test("champions: the three first, by the column the tool sorted on", () => {
    const card = cardOf(answer({ table: champions, icons }, { route: "champion_ranking", input: ranked("bans") }));

    expect(card?.metric).toBe("bans");
    expect(card?.top).toEqual([
      { rank: 1, name: "Vi", value: "287", icon: "vi.png" },
      { rank: 2, name: "Kalista", value: "259", icon: "kalista.png" },
      { rank: 3, name: "Azir", value: "247", icon: "azir.png" },
    ]);
  });

  test("a percentage is written as one, in the language of the page", () => {
    const table = { ...champions, rows: champions.rows.toSorted((a, b) => Number(b[4]) - Number(a[4])) };
    const input = ranked("presence");

    expect(cardOf(answer({ table, icons }, { input }))?.top[0]).toMatchObject({ name: "Vi", value: "68,7 %" });
    expect(cardOf(answer({ table, icons }, { input }), "en")).toMatchObject({ metric: "presence", top: [{ value: "68.7%" }, { value: "68%" }, { value: "56.6%" }] });
  });

  test("players or teams: the column the table names as its focus", () => {
    const table = { columns: ["Rang", "Joueur", "Équipe", "Parties", "KDA"], rows: [[1, "Knight", "Bilibili Gaming", 19, 9.15], [2, "Faker", "T1", 17, 7.16]], focus: "KDA" };

    expect(cardOf(answer({ table }))).toMatchObject({ metric: "KDA", top: [{ rank: 1, name: "Knight", value: "9,15", icon: null }, { rank: 2, name: "Faker", value: "7,16", icon: null }] });
  });

  test("no head without a rank column or without a known ranked column", () => {
    const table = { columns: ["Rang", "Joueur", "Parties", "KDA"], rows: [[1, "Knight", 19, 9.15]] };

    expect(cardOf(answer({ table }))?.top).toEqual([]);
    expect(cardOf(answer({ table: { ...table, focus: "% victoires" } }))?.top).toEqual([]);
    expect(cardOf(answer({ table: { columns: ["Joueur", "KDA"], rows: [["Knight", 9.15]], focus: "KDA" } }))?.top).toEqual([]);
  });
});

test("a run for a card never gets the model, whatever the key", () => {
  const key = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "sk-or-test";

  try {
    expect(withoutLlm(() => getLlm())).toBeNull();
  } finally {
    if (key === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = key;
  }
});

describe("one computation per question and five minutes", () => {
  const card: ShareCard = { title: "Chovy", line: "", heading: "Chovy", duel: null, top: [], metric: "", figures: [] };

  test("the same question shares one run; another question, or five minutes later, runs again", async () => {
    clearShareCards();
    let runs = 0;
    const compute = async () => (runs++, card);
    const now = 1_800_000_000_000;

    const first = rememberCard("fr\nChovy", compute, now);
    expect(rememberCard("fr\nChovy", compute, now + 299_999)).toBe(first);
    expect(await first).toBe(card);
    expect(runs).toBe(1);

    await rememberCard("en\nChovy", compute, now);
    expect(runs).toBe(2);

    await rememberCard("fr\nChovy", compute, now + 300_000);
    expect(runs).toBe(3);
  });

  test("a run that throws reads null and is not kept", async () => {
    clearShareCards();

    let runs = 0;

    const failing = async (): Promise<ShareCard | null> => {
      runs++;

      throw new Error("database down");
    };

    expect(await rememberCard("fr\nChovy", failing)).toBeNull();
    expect(await rememberCard("fr\nChovy", async () => (runs++, card))).toBe(card);
    expect(runs).toBe(2);
  });

  test("at most 500 questions: the oldest is forgotten first", async () => {
    clearShareCards();
    let runs = 0;
    const compute = async () => (runs++, card);

    for (let i = 0; i <= 500; i++) await rememberCard(`fr\n${i}`, compute);
    expect(runs).toBe(501);

    await rememberCard("fr\n500", compute);
    expect(runs).toBe(501);
    await rememberCard("fr\n0", compute);
    expect(runs).toBe(502);
  });
});
