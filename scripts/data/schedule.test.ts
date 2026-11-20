import { describe, expect, test } from "bun:test";
import { type ScoreboardMatch, scheduleOnly, scheduledSeries } from "./schedule";

const PAGE = "PCS/2026 Season/Spring Qualifier";

// Rows as Special:CargoExport returns them for that page (13 April 2026).
const forfeit = { MatchId: `${PAGE}_Round 1_1`, Page: PAGE, Tab: "Round 1", N: 1, Team1: "Nova Esports (Taiwanese Team)", Team2: "Equinox Core", Winner: 2, S1: 0, S2: 2, FF: 1, Date: "2026-04-13 09:00:00", Nullified: 0 };
const played = { MatchId: `${PAGE}_Round 1_4`, Page: PAGE, Tab: "Round 1", N: 4, Team1: "Shadow Keepers Esports", Team2: "Viper Night Raider", Winner: 1, S1: 2, S2: 1, FF: null, Date: "2026-04-13 12:00:00", Nullified: 0 };

const at = (date: string) => Date.parse(`${date}Z`) / 1000;

describe("schedule series", () => {
  test("keeps a decided match with its score, winner and forfeit", () => {
    expect(scheduledSeries(played)).toEqual({ page: PAGE, tab: "Round 1", n: 4, team1: "Shadow Keepers Esports", team2: "Viper Night Raider", winner: 1, score1: 2, score2: 1, forfeit: null, playedAt: at("2026-04-13T12:00:00") });
    expect(scheduledSeries(forfeit)).toMatchObject({ winner: 2, forfeit: 1, score1: 0, score2: 2 });
  });

  test("drops a nullified or TBD match, keeps an undecided one without a winner", () => {
    expect(scheduledSeries({ ...played, Winner: null })).toMatchObject({ winner: null });
    expect(scheduleOnly([scheduledSeries({ ...played, Winner: 0 })!], [])).toEqual([]);
    expect(scheduledSeries({ ...played, Nullified: 1 })).toBeNull();
    expect(scheduledSeries({ ...played, Team2: "TBD" })).toBeNull();
    expect(scheduledSeries({ ...played, Team2: played.Team1 })).toBeNull();
  });

  const series = [scheduledSeries(played)!, scheduledSeries(forfeit)!];
  const game = (over: Partial<ScoreboardMatch>): ScoreboardMatch => ({ page: PAGE, tab: "Round 1", n: 4, team1: "Viper Night Raider", team2: "Shadow Keepers Esports", playedAt: at("2026-04-13T12:05:00"), ...over });

  test("a page without scoreboards keeps every series", () => {
    expect(scheduleOnly(series, [])).toEqual(series);
  });

  test("a scoreboard game covers its series by slot, or by the two teams within two days", () => {
    expect(scheduleOnly(series, [game({})])).toEqual([series[1]]);
    expect(scheduleOnly(series, [game({ tab: "Day 1", n: 9 })])).toEqual([series[1]]);
    // The same teams a week later: another series.
    expect(scheduleOnly(series, [game({ tab: "Round 1", n: 9, playedAt: at("2026-04-20T12:00:00") })])).toEqual(series);
  });

  test("tabs named otherwise: one team in common the same day is the same series, never counted twice", () => {
    const renamed = game({ tab: "Scoreboards", n: 1, team1: "Shadow Keepers", team2: "Viper Night Raider" });
    expect(scheduleOnly(series, [renamed])).toEqual([series[1]]);
    // Where the tabs match the schedule's, the slot alone decides.
    expect(scheduleOnly(series, [{ ...renamed, tab: "Round 1", n: 3 }])).toEqual(series);
  });

  test("a scoreboard series another match claimed covers nothing else", () => {
    // LVP SuperLiga Orange 2018 Spring: Penguins played eMonkeyz the day before its tiebreaker against KIYF.
    const page = "LVP SuperLiga Orange/2018 Season/Spring Season";
    // Its Week 14 draw against MAD Lions (1-1, no winner) still claims its own scoreboards.
    const week = scheduledSeries({ Page: page, Tab: "Week 14", N: 1, Team1: "eMonkeyz", Team2: "Penguins", Winner: 1, S1: 2, S2: 0, Date: "2018-03-14 18:00:00" })!;
    const draw = scheduledSeries({ Page: page, Tab: "Week 14", N: 2, Team1: "MAD Lions E.C.", Team2: "KIYF eSports Club", Winner: 0, S1: 1, S2: 1, Date: "2018-03-14 20:30:00" })!;
    const tiebreaker = scheduledSeries({ Page: page, Tab: "Tiebreakers", N: 1, Team1: "KIYF eSports Club", Team2: "Penguins", Winner: 1, S1: 1, S2: 0, Date: "2018-03-15 22:30:00" })!;

    const games: ScoreboardMatch[] = [
      { page, tab: "Week 14", n: 1, team1: "eMonkeyz", team2: "Penguins", playedAt: at("2018-03-14T18:17:00") },
      { page, tab: "Week 14", n: 2, team1: "MAD Lions E.C.", team2: "KIYF eSports Club", playedAt: at("2018-03-14T20:40:00") },
    ];

    expect(scheduleOnly([week, draw, tiebreaker], games)).toEqual([tiebreaker]);
  });

  test("a rematch the next day is another series", () => {
    const rematch = scheduledSeries({ ...played, Tab: "Tiebreakers", N: 1, Date: "2026-04-14 12:00:00" })!;

    expect(scheduleOnly([series[0], rematch], [game({})])).toEqual([rematch]);
  });

  test("a showmatch is no series", () => {
    expect(scheduleOnly([{ ...series[0], tab: "Showmatch" }], [])).toEqual([]);
  });
});
