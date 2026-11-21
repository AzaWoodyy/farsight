import { describe, expect, test } from "bun:test";
import { candidatesOf, guessLocale, normalizeQuestion, reasonsOf, type TracedQuestion, withoutEvalCases } from "./eval-candidates/select";

let next = 0;

const trace = (over: Partial<TracedQuestion>): TracedQuestion => ({
  traceId: `t${++next}`,
  date: `2026-01-0${(next % 9) + 1}T12:00:00Z`,
  question: "question synthétique",
  route: "player_event_history",
  unread: [],
  locale: "fr",
  localeGuessed: false,
  rating: null,
  ...over,
});

describe("reasonsOf", () => {
  test("a question answered by a typed tool, without unread word or thumbs down, is no candidate", () => {
    expect(reasonsOf(trace({}))).toEqual([]);
    expect(reasonsOf(trace({ rating: "up" }))).toEqual([]);
  });

  test("generated SQL, thumbs down, missing data and unread words each make one", () => {
    expect(reasonsOf(trace({ route: "sql" }))).toEqual(["sql"]);
    expect(reasonsOf(trace({ rating: "down" }))).toEqual(["down"]);
    expect(reasonsOf(trace({ route: "missing_data" }))).toEqual(["missing_data"]);
    expect(reasonsOf(trace({ unread: ["zorglub"] }))).toEqual(["unread"]);
    expect(reasonsOf(trace({ route: "sql", unread: ["zorglub"], rating: "down" }))).toEqual(["sql", "down", "unread"]);
  });

  test("out of scope alone is no gap of the router", () => {
    expect(reasonsOf(trace({ route: "out_of_scope" }))).toEqual([]);
  });
});

describe("normalizeQuestion", () => {
  test("case, accents, punctuation and spacing do not count", () => {
    expect(normalizeQuestion("  Résultats de  JOUEURX, aux Worlds ?! ")).toBe("resultats de joueurx aux worlds");
    expect(normalizeQuestion("résultats de joueurx aux worlds")).toBe(normalizeQuestion("Resultats de JoueurX aux Worlds."));
  });

  test("hangul and digits stay", () => {
    expect(normalizeQuestion("정지훈 2024")).toBe("정지훈 2024");
  });
});

describe("candidatesOf", () => {
  test("the same question asked twice is one candidate, its reasons, routes, unread words and ratings merged", () => {
    const list = candidatesOf([
      trace({ traceId: "a", date: "2026-01-01T00:00:00Z", question: "Bilan de JoueurX ?", route: "sql" }),
      trace({ traceId: "b", date: "2026-01-03T00:00:00Z", question: "bilan de joueurx", route: "missing_data", unread: ["bilan"], rating: "down" }),
      trace({ traceId: "c", date: "2026-01-02T00:00:00Z", question: "BILAN de JoueurX", route: "sql", unread: ["bilan"], rating: "up" }),
    ]);

    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      question: "bilan de joueurx",
      reasons: ["sql", "down", "missing_data", "unread"],
      routes: ["sql", "missing_data"],
      unread: ["bilan"],
      rating: { up: 1, down: 1 },
      traces: 3,
      firstSeen: "2026-01-01T00:00:00Z",
      lastSeen: "2026-01-03T00:00:00Z",
      lastTraceId: "b",
    });
  });

  test("a trace without reason neither makes nor feeds a candidate", () => {
    const list = candidatesOf([trace({ question: "q un", route: "series" }), trace({ question: "q deux", route: "sql" })]);

    expect(list.map((c) => c.question)).toEqual(["q deux"]);
  });

  test("the same words from the other language are another candidate", () => {
    const list = candidatesOf([trace({ question: "faker worlds", route: "sql" }), trace({ question: "Faker Worlds", route: "sql", locale: "en" })]);

    expect(list.map((c) => c.locale).sort()).toEqual(["en", "fr"]);
  });

  test("most recent first", () => {
    const list = candidatesOf([
      trace({ question: "ancienne", route: "sql", date: "2026-01-01T00:00:00Z" }),
      trace({ question: "récente", route: "sql", date: "2026-01-05T00:00:00Z" }),
    ]);

    expect(list.map((c) => c.question)).toEqual(["récente", "ancienne"]);
  });

  test("a guessed language stays guessed only while no trace recorded it", () => {
    const [c] = candidatesOf([trace({ question: "q", route: "sql", localeGuessed: true }), trace({ question: "q", route: "sql", localeGuessed: false })]);

    expect(c.localeGuessed).toBe(false);
  });
});

describe("withoutEvalCases", () => {
  test("a question the eval already asks, in the same language, is dropped", () => {
    const list = candidatesOf([
      trace({ question: "Résultats de JoueurX aux Worlds ?", route: "sql" }),
      trace({ question: "players of TeamY", route: "sql", locale: "en" }),
      trace({ question: "nouvelle question", route: "sql" }),
    ]);

    const left = withoutEvalCases(list, [{ question: "résultats de joueurx aux worlds" }, { question: "players of teamy", locale: "fr" }]);

    expect(left.map((c) => c.question).sort()).toEqual(["nouvelle question", "players of TeamY"]);
  });
});

describe("guessLocale", () => {
  test("the answer's language, French when nothing decides", () => {
    expect(guessLocale("JoueurX played 12 games in the league and won 8 of them.")).toBe("en");
    expect(guessLocale("JoueurX a joué 12 parties dans la ligue et en a gagné 8.")).toBe("fr");
    expect(guessLocale("")).toBe("fr");
  });
});
