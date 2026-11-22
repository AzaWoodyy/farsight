import { describe, expect, test } from "bun:test";
import { chatCard, tableCard } from "../src/lib/agent/chat-card";
import { withLocale } from "../src/lib/agent/messages";
import type {
  ChampionPoolLine,
  ChampionProfile,
  GameScoreboard,
  PlayerPhoto,
  PlayerRunes,
  RosterPlayer,
  ScoreboardPlayer,
  ScoreboardTeam,
  SeriesDetail,
  SeriesGame,
  TeamSeries,
  TimelineView,
} from "../src/lib/agent/types";
import { emptyAnswer } from "./fixtures/answer";

const NOV_14_2023 = 1_700_000_000;
const source = { label: "Leaguepedia", url: "https://lol.fandom.com/wiki/Page" };
const cdn = (file: string) => `https://cdn.example/${file}.png`;
const photo = (file: string): PlayerPhoto => ({ url: cdn(file), year: 2023, source: "Leaguepedia" });

const line = (champion: string, games: number, wins: number): ChampionPoolLine => ({
  champion,
  icon: cdn(champion),
  games,
  wins,
  losses: games - wins,
  winrate: wins / games,
  kda: null,
  share: 0,
  players: [],
});

const teamSeries = (over: Partial<TeamSeries> = {}): TeamSeries => ({
  playedAt: NOV_14_2023,
  label: "Worlds 2023 · finale",
  teamA: "T1",
  teamB: "Gen.G",
  winsA: 3,
  winsB: 1,
  winner: "T1",
  scheduleOnly: false,
  forfeitedBy: null,
  source,
  ...over,
});

const rosterPlayer = (player: string, role: string, starter: boolean, games: number, wins: number): RosterPlayer => ({
  player,
  role,
  games,
  wins,
  starter,
  tournaments: [],
  firstPlayed: null,
  lastPlayed: null,
  photo: photo(player),
  source,
});

const championProfile = (over: Partial<ChampionProfile> = {}): ChampionProfile => ({
  champion: "Azir",
  icon: cdn("Azir"),
  scope: "LCK 2024",
  games: 10,
  picks: 10,
  bans: 4,
  wins: 6,
  kda: 4.2,
  averages: [],
  players: [{ player: "Faker", team: "T1", games: 6, wins: 4, kda: 5.1 }],
  roles: [],
  focus: null,
  items: { games: 0, items: [], notes: [] },
  setups: { spellGames: 0, spells: [], keystoneGames: 0, pageGames: 0, runes: [], notes: [] },
  ...over,
});

const playerRunes = (runes: PlayerRunes["runes"]): PlayerRunes => ({
  player: "Faker",
  scope: "LCK 2024",
  champion: null,
  role: null,
  games: 10,
  wins: 6,
  keystoneGames: 10,
  pageGames: 0,
  runes,
  trees: [],
  pages: [],
  notes: [],
});

const seriesGame = (over: Partial<SeriesGame> = {}): SeriesGame => ({
  n: 1,
  playedAt: NOV_14_2023,
  blue: "T1",
  red: "Gen.G",
  winner: "blue",
  durationS: 1925,
  patch: null,
  picks: { blue: [], red: [] },
  bans: { blue: [], red: [] },
  source,
  ...over,
});

const seriesDetail = (over: Partial<SeriesDetail> = {}): SeriesDetail => ({
  label: "Worlds 2023 · finale",
  tournamentPage: "2023 Season World Championship",
  playedAt: NOV_14_2023,
  teamA: "T1",
  teamB: "Gen.G",
  winsA: 2,
  winsB: 1,
  bestOf: 3,
  games: null,
  scheduleOnly: false,
  forfeitedBy: null,
  source,
  ...over,
});

const scoreboardTeam = (name: string, kills: number | null): ScoreboardTeam => ({
  name,
  kills,
  gold: null,
  towers: null,
  inhibitors: null,
  dragons: null,
  barons: null,
  heralds: null,
  grubs: null,
  dragonKinds: [],
  soul: null,
});

const scoreboardPlayer = (over: Partial<ScoreboardPlayer>): ScoreboardPlayer => ({
  side: "blue",
  role: "Mid",
  player: "Faker",
  photo: photo("Faker"),
  champion: "Azir",
  championIcon: cdn("Azir"),
  kills: 4,
  deaths: 1,
  assists: 7,
  gold: null,
  cs: null,
  damage: null,
  vision: null,
  keystone: null,
  keystoneIcon: null,
  spells: [],
  runes: [],
  items: [],
  ...over,
});

const scoreboard = (over: Partial<GameScoreboard> = {}): GameScoreboard => ({
  label: "Worlds 2023 · finale · partie 1",
  durationS: 1925,
  patch: null,
  winner: "blue",
  blue: scoreboardTeam("T1", 12),
  red: scoreboardTeam("Gen.G", null),
  players: [scoreboardPlayer({}), scoreboardPlayer({ side: "red", player: "Chovy", photo: null, champion: null, championIcon: null, kills: null, deaths: null, assists: null })],
  ...over,
});

const timeline = (over: Partial<TimelineView> = {}): TimelineView => ({
  label: "Worlds 2023 · finale · partie 1",
  blue: "T1",
  red: "Gen.G",
  winner: "red",
  durationS: 1925,
  version: 5,
  gold: [
    { s: 600, diff: 800 },
    { s: 1925, diff: -1500 },
  ],
  events: [
    { s: 185, kind: "first_blood", side: "blue", detail: null },
    { s: 1500, kind: "baron", side: "red", detail: "Baron Nashor" },
  ],
  ...over,
});

describe("chatCard, one card per shape of answer", () => {
  test("a player's results by edition: totals and one line per edition", () => {
    const card = chatCard(
      emptyAnswer({
        title: "Faker — Worlds",
        rows: [
          { year: 2023, event: "Worlds 2023", team: "T1", place: "1", placeLabel: "Vainqueur", placeNumber: 1, wins: 5, losses: 1, champions: [] },
          { year: 2022, event: "Worlds 2022", team: "T1", place: null, placeLabel: "Finaliste", placeNumber: null, wins: 2, losses: 2, champions: [] },
        ],
        pool: { subject: "player", name: "Faker", scope: "", games: 1, wins: 1, losses: 0, picks: 1, unique: 1, top3Share: 1, lines: [line("Azir", 1, 1)] },
      }),
    );

    expect(card).toEqual({
      title: "Faker — Worlds",
      stats: [
        { label: "Éditions", value: "2" },
        { label: "Bilan en parties", value: "7 V – 3 D" },
        { label: "Victoires", value: "70 %" },
      ],
      bars: null,
      table: {
        columns: ["Année", "Équipe", "Résultat", "V-D"],
        rows: [
          [2023, "T1", "Vainqueur (1)", "5-1"],
          [2022, "T1", "Finaliste", "2-2"],
        ],
        numeric: [true, false, false, false],
        total: 2,
      },
      subjects: [],
      icons: {},
    });
  });

  test("a champion pool: bars scaled on the most played champion, eight at most, and only their icons", () => {
    const lines = [line("Azir", 10, 6), line("Orianna", 5, 5), ...Array.from({ length: 7 }, (_, i) => line(`Champion ${i}`, 1, 0))];
    const card = chatCard(emptyAnswer({ pool: { subject: "player", name: "Faker", scope: "LCK 2024", games: 22, wins: 11, losses: 11, picks: 22, unique: 9, top3Share: 0.7, lines } }));

    expect(card?.stats).toEqual([
      { label: "Parties", value: "22" },
      { label: "Bilan", value: "11 V – 11 D" },
      { label: "Champions joués", value: "9" },
    ]);
    expect(card?.table).toBeNull();
    expect(card?.bars).toHaveLength(8);
    expect(card?.bars?.slice(0, 3)).toEqual([
      { label: "Azir", value: 100, text: "10 p. · 60 %" },
      { label: "Orianna", value: 50, text: "5 p. · 100 %" },
      { label: "Champion 0", value: 10, text: "1 p. · 0 %" },
    ]);
    expect(Object.keys(card?.icons ?? {})).toEqual(lines.slice(0, 8).map((l) => l.champion));
    expect(card?.icons?.Azir).toEqual({ src: cdn("Azir"), tone: undefined });
  });

  test("a head-to-head between teams: both teams as subjects with their logo and its tone", () => {
    const card = chatCard(
      emptyAnswer({
        teams: {
          teamA: "T1",
          teamB: "Gen.G",
          scope: "Worlds",
          seriesA: 3,
          seriesB: 1,
          gamesA: 8,
          gamesB: 5,
          seriesCount: 4,
          series: [teamSeries(), teamSeries({ playedAt: null, label: "T1", winsA: 0, winsB: 2 })],
        },
        icons: { T1: cdn("T1"), "Gen.G": cdn("Gen.G"), "Hanwha Life Esports": cdn("HLE") },
        iconTones: { T1: "dark" },
      }),
    );

    expect(card?.stats).toEqual([
      { label: "Séries", value: "T1 3 – 1 Gen.G" },
      { label: "Parties", value: "8 – 5" },
    ]);
    expect(card?.table).toEqual({
      columns: ["Date", "Rencontre", "Score"],
      rows: [
        ["14 nov. 2023", "Worlds 2023 · finale", "T1 3-1 Gen.G"],
        ["–", "T1", "T1 0-2 Gen.G"],
      ],
      numeric: [false, false, false],
      total: 2,
    });
    expect(card?.subjects).toEqual([
      { name: "T1", line: null, image: { src: cdn("T1"), tone: "dark" } },
      { name: "Gen.G", line: null, image: { src: cdn("Gen.G"), tone: undefined } },
    ]);
    expect(card?.icons).toEqual({ T1: { src: cdn("T1"), tone: "dark" } });
  });

  test("a comparison of two players: its scope and its table, column names without underscores", () => {
    const card = chatCard(
      emptyAnswer({
        versus: {
          playerA: "Faker",
          playerB: "Chovy",
          scope: "LCK 2024",
          focus: null,
          global: { columns: ["stat", "Faker", "Chovy", "win_rate"], rows: [["KDA", 4.1, 5.3, "60 %"]] },
          h2h: null,
          lanes: { same: 0, roles: [] },
          games: [],
        },
        profiles: [
          { player: "Faker", teams: ["T1", "SK Telecom T1", "T1 Academy", "T1 Rookies"], role: "Mid", photo: photo("Faker") },
          { player: "Chovy", teams: [], role: null, photo: null },
        ],
      }),
    );

    expect(card?.stats).toEqual([{ label: "Périmètre", value: "LCK 2024" }]);
    expect(card?.table).toEqual({ columns: ["stat", "Faker", "Chovy", "win rate"], rows: [["KDA", 4.1, 5.3, "60 %"]], numeric: [false, true, true, true], total: 1 });
    expect(card?.subjects).toEqual([
      { name: "Faker", line: "Mid · T1, SK Telecom T1, T1 Academy", image: { src: cdn("Faker"), photo: true } },
      { name: "Chovy", line: null, image: null },
    ]);
    expect(card?.icons).toEqual({});
  });

  test("a roster: substitutes are marked and keep their photo", () => {
    const card = chatCard(
      emptyAnswer({
        roster: {
          team: "T1",
          names: ["T1"],
          scope: "LCK 2024",
          games: 10,
          wins: 7,
          tournaments: [],
          players: [rosterPlayer("Faker", "Mid", true, 9, 7), rosterPlayer("Poby", "Mid", false, 1, 0)],
        },
        icons: { T1: cdn("T1") },
      }),
    );

    expect(card?.stats).toEqual([
      { label: "Parties", value: "10" },
      { label: "Victoires", value: "70 %" },
    ]);
    expect(card?.table).toEqual({
      columns: ["Rôle", "Joueur", "Parties", "Victoires"],
      rows: [
        ["Mid", "Faker", 9, "78 %"],
        ["Mid", "Poby (remplaçant)", 1, "0 %"],
      ],
      numeric: [false, false, true, true],
      total: 2,
    });
    expect(card?.subjects).toEqual([{ name: "T1", line: "LCK 2024", image: { src: cdn("T1"), tone: undefined } }]);
    expect(card?.icons).toEqual({ Faker: { src: cdn("Faker"), photo: true }, "Poby (remplaçant)": { src: cdn("Poby"), photo: true } });
  });

  test("a champion: its figures, its players, and the champion as subject", () => {
    const card = chatCard(emptyAnswer({ champion: championProfile() }));

    expect(card?.stats).toEqual([
      { label: "Picks", value: "10" },
      { label: "Bans", value: "4" },
      { label: "Victoires", value: "60 %" },
      { label: "KDA", value: "4.2" },
    ]);
    expect(card?.table).toEqual({ columns: ["Joueur", "Équipe", "Parties", "Victoires", "KDA"], rows: [["Faker", "T1", 6, "67 %", 5.1]], numeric: [false, false, true, true, true], total: 1 });
    expect(card?.subjects).toEqual([{ name: "Azir", line: "LCK 2024", image: { src: cdn("Azir"), tone: undefined } }]);
    expect(card?.icons).toEqual({});
  });

  test("a champion nobody played: no table, and dashes for what cannot be computed", () => {
    const card = chatCard(emptyAnswer({ champion: championProfile({ picks: 0, wins: 0, kda: null, players: [], icon: null }) }));

    expect(card?.stats.map((s) => s.value)).toEqual(["0", "4", "–", "–"]);
    expect(card?.table).toBeNull();
    expect(card?.subjects).toEqual([{ name: "Azir", line: "LCK 2024", image: null }]);
  });

  test("a player's runes: one bar per keystone, the other runes left out", () => {
    const card = chatCard(
      emptyAnswer({
        runes: playerRunes([
          { rune: "Electrocute", kind: "keystone", tree: "Domination", icon: cdn("Electrocute"), games: 8, wins: 6 },
          { rune: "Taste of Blood", kind: "primary", tree: "Domination", icon: cdn("Taste"), games: 9, wins: 6 },
          { rune: "Conqueror", kind: "keystone", tree: "Precision", icon: null, games: 2, wins: 0 },
        ]),
      }),
    );

    expect(card?.stats).toEqual([
      { label: "Parties", value: "10" },
      { label: "Victoires", value: "60 %" },
    ]);
    expect(card?.bars).toEqual([
      { label: "Electrocute", value: 100, text: "8 p. · 75 %" },
      { label: "Conqueror", value: 25, text: "2 p. · 0 %" },
    ]);
    expect(card?.table).toBeNull();
    expect(card?.icons).toEqual({ Electrocute: { src: cdn("Electrocute"), tone: undefined } });
  });

  test("one series with its games: one line per game, with its winner and its length", () => {
    const card = chatCard(
      emptyAnswer({
        series: {
          scope: "Worlds 2023",
          count: 1,
          series: [
            seriesDetail({
              games: [seriesGame(), seriesGame({ n: null, blue: "Gen.G", red: "T1", winner: "red", durationS: 2405 }), seriesGame({ n: 3, winner: null, durationS: null })],
            }),
          ],
        },
      }),
    );

    expect(card?.stats).toEqual([
      { label: "Score", value: "T1 2 – 1 Gen.G" },
      { label: "Date", value: "14 nov. 2023" },
    ]);
    expect(card?.table).toEqual({
      columns: ["Partie", "Côté bleu", "Côté rouge", "Vainqueur", "Durée"],
      rows: [
        [1, "T1", "Gen.G", "T1", "32:05"],
        [2, "Gen.G", "T1", "T1", "40:05"],
        [3, "T1", "Gen.G", "–", "–"],
      ],
      numeric: [true, false, false, false, false],
      total: 3,
    });
  });

  test.each([
    ["one series without its games", [seriesDetail()]],
    ["several series", [seriesDetail({ games: [seriesGame()] }), seriesDetail({ playedAt: null, teamA: "DRX", winsA: 0, winsB: 2 })]],
  ])("%s: the list of series", (_, series) => {
    const card = chatCard(emptyAnswer({ series: { scope: "Worlds 2023", count: 7, series } }));

    expect(card?.stats).toEqual([{ label: "Séries", value: "7" }]);
    expect(card?.table?.columns).toEqual(["Date", "Rencontre", "Score"]);
    expect(card?.table?.rows[0]).toEqual(["14 nov. 2023", "Worlds 2023 · finale", "T1 2-1 Gen.G"]);
    expect(card?.table?.rows.at(-1)).toEqual(series.length > 1 ? ["–", "Worlds 2023 · finale", "DRX 0-2 Gen.G"] : card?.table?.rows[0]);
  });

  test("a game scoreboard: the ten lines, with the photos and champion icons they show", () => {
    const card = chatCard(emptyAnswer({ scoreboard: scoreboard(), icons: { T1: cdn("T1"), LCK: cdn("LCK") } }));

    expect(card?.stats).toEqual([
      { label: "Vainqueur", value: "T1" },
      { label: "Durée", value: "32:05" },
      { label: "Kills", value: "12 – –" },
    ]);
    expect(card?.table).toEqual({
      columns: ["Équipe", "Rôle", "Joueur", "Champion", "K/D/A"],
      rows: [
        ["T1", "Mid", "Faker", "Azir", "4/1/7"],
        ["Gen.G", "Mid", "Chovy", null, "–/–/–"],
      ],
      numeric: [false, false, false, false, false],
      total: 2,
    });
    expect(card?.icons).toEqual({ T1: { src: cdn("T1"), tone: undefined }, Faker: { src: cdn("Faker"), photo: true }, Azir: { src: cdn("Azir"), tone: undefined } });
  });

  test.each([
    ["red", "Gen.G"],
    [null, "–"],
  ] as const)("a scoreboard won by %s names %s", (winner, name) => {
    expect(chatCard(emptyAnswer({ scoreboard: scoreboard({ winner, durationS: null }) }))?.stats.slice(0, 2)).toEqual([
      { label: "Vainqueur", value: name },
      { label: "Durée", value: "–" },
    ]);
  });

  test("a game timeline: the final gold lead goes to the side that holds it", () => {
    const card = chatCard(emptyAnswer({ timeline: timeline() }));

    expect(card?.stats).toEqual([
      { label: "Vainqueur", value: "Gen.G" },
      { label: "Durée", value: "32:05" },
      { label: "Écart d'or final", value: "Gen.G +1500" },
    ]);
    expect(card?.table).toEqual({
      columns: ["Temps", "Équipe", "Événement"],
      rows: [
        ["3:05", "T1", "first_blood"],
        ["25:00", "Gen.G", "Baron Nashor"],
      ],
      numeric: [false, false, false],
      total: 2,
    });
  });

  test("a timeline led by the blue side, and one without any gold reading", () => {
    expect(chatCard(emptyAnswer({ timeline: timeline({ winner: "blue", gold: [{ s: 600, diff: 800 }] }) }))?.stats.map((s) => s.value)).toEqual(["T1", "32:05", "T1 +800"]);
    expect(chatCard(emptyAnswer({ timeline: timeline({ winner: null, gold: [] }) }))?.stats.map((s) => s.value)).toEqual(["–", "32:05", "–"]);
  });

  test("any other table is shown as it is", () => {
    const answer = emptyAnswer({ title: "Classement", table: { columns: ["team", "win_rate"], rows: [["T1", "70 %"]] }, icons: { T1: cdn("T1"), "Gen.G": cdn("Gen.G") }, iconTones: { T1: "light" } });

    expect(chatCard(answer)).toEqual({
      ...tableCard("Classement", ["team", "win_rate"], [["T1", "70 %"]]),
      subjects: [],
      icons: { T1: { src: cdn("T1"), tone: "light" } },
    });
  });

  test.each([
    ["nothing", emptyAnswer()],
    ["a table without rows", emptyAnswer({ table: { columns: ["team"], rows: [] } })],
  ])("an answer with %s has no card", (_, answer) => {
    expect(chatCard(answer)).toBeNull();
  });

  test("the card is written in the language of the answer", () => {
    const card = withLocale("en", () =>
      chatCard(
        emptyAnswer({
          roster: { team: "T1", names: ["T1"], scope: "LCK 2024", games: 1, wins: 1, tournaments: [], players: [rosterPlayer("Poby", "Mid", false, 1, 1)] },
        }),
      ),
    );

    expect(card?.stats.map((s) => s.label)).toEqual(["Games", "Win rate"]);
    expect(card?.table?.columns).toEqual(["Role", "Player", "Games", "Win rate"]);
    expect(card?.table?.rows).toEqual([["Mid", "Poby (substitute)", 1, "100 %"]]);
    expect(Object.keys(card?.icons ?? {})).toEqual(["Poby (substitute)"]);
  });
});

describe("subjects and icons", () => {
  const table = { columns: ["player"], rows: [["Faker"]] };
  const profile = (player: string) => ({ player, teams: ["T1"], role: "Mid", photo: photo(player) });

  test("one or two profiles are the subjects, three or more are not", () => {
    expect(chatCard(emptyAnswer({ table, profiles: [profile("Faker")] }))?.subjects).toEqual([{ name: "Faker", line: "Mid · T1", image: { src: cdn("Faker"), photo: true } }]);
    expect(chatCard(emptyAnswer({ table, profiles: [profile("Faker"), profile("Chovy"), profile("Zeus")] }))?.subjects).toEqual([]);
  });

  test("an icon of the answer wins over a photo of the same name", () => {
    const card = chatCard(emptyAnswer({ table, profiles: [profile("Faker")], icons: { Faker: cdn("icon") }, iconTones: { Faker: "dark" } }));

    expect(card?.icons).toEqual({ Faker: { src: cdn("icon"), tone: "dark" } });
  });

  test("the icons of rows beyond the limit are not kept", () => {
    const rows = Array.from({ length: 41 }, (_, i) => [`Team ${i}`]);
    const card = chatCard(emptyAnswer({ table: { columns: ["team"], rows }, icons: Object.fromEntries(rows.map(([team]) => [team, cdn(team)])) }));

    expect(Object.keys(card?.icons ?? {})).toHaveLength(40);
    expect(card?.icons).not.toHaveProperty("Team 40");
  });
});

describe("tableCard", () => {
  test("a title and a table, nothing else", () => {
    expect(tableCard("Titre", ["first_year", "team"], [[2024, "T1"]])).toEqual({
      title: "Titre",
      stats: [],
      bars: null,
      table: { columns: ["first year", "team"], rows: [[2024, "T1"]], numeric: [true, false], total: 1 },
    });
  });

  test("a column is numeric when every filled cell reads as a number", () => {
    const columns = ["integers", "percents", "spaced", "signed", "with_gaps", "mixed", "scores", "empty"];

    const rows = [
      [1, "45 %", "1 234,5", "-3", null, 12, "3-1", null],
      [2024, "7%", "12.5", "+4", 8, "T1", "2-0", null],
    ];

    expect(tableCard("t", columns.slice(0, 6), rows).table?.numeric).toEqual([true, true, true, true, true, false]);
    expect(tableCard("t", columns.slice(6), rows.map((r) => r.slice(6))).table?.numeric).toEqual([false, true]);
  });

  test("a table without rows has no numeric column", () => {
    expect(tableCard("t", ["games"], []).table).toEqual({ columns: ["games"], rows: [], numeric: [false], total: 0 });
  });

  test("forty rows and six columns are shown, and the total says how many rows there were", () => {
    const columns = Array.from({ length: 8 }, (_, i) => `c${i}`);
    const rows = Array.from({ length: 45 }, (_, r) => columns.map((_, c) => r * 10 + c));
    const shown = tableCard("t", columns, rows).table;

    expect(shown?.columns).toEqual(["c0", "c1", "c2", "c3", "c4", "c5"]);
    expect(shown?.rows).toHaveLength(40);
    expect(shown?.rows.at(-1)).toEqual([390, 391, 392, 393, 394, 395]);
    expect(shown?.numeric).toEqual([true, true, true, true, true, true]);
    expect(shown?.total).toBe(45);
  });
});
