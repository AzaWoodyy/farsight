import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import { ChatMessages, digestAnswer, lastUserText, modelHistory } from "../src/lib/agent/chat";
import { StoredMessages } from "../src/lib/agent/chat-parts";
import { CHAT_HISTORY_MESSAGES } from "../src/lib/agent/chat-types";
import { emptyAnswer } from "./fixtures/answer";

type Message = z.input<typeof ChatMessages>[number];

type Part = NonNullable<Message["parts"]>[number];

const text = (value: string) => ({ type: "text", text: value });

const shown = (asked: string, digest: string | null, via: string = "pipeline") => ({
  type: "data-answer",
  id: "call_1",
  data: { asked, via, pending: digest == null, card: null, sources: [], digest },
});

const user = (...parts: Part[]): Message => ({ role: "user", parts });

const assistant = (...parts: Part[]): Message => ({ role: "assistant", parts });

const history = (...messages: Message[]) => modelHistory(ChatMessages.parse(messages));

describe("modelHistory", () => {
  test("an answer shown by ask_data comes back as a tool call, its result, then the comment", () => {
    expect(history(user(text("Chovy aux Worlds")), assistant(shown("Résultats de Chovy aux Worlds", '{"route":"player_event_history"}'), text("Huit éditions.")))).toEqual([
      { role: "user", content: "Chovy aux Worlds" },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "past_1_0", toolName: "ask_data", input: { question: "Résultats de Chovy aux Worlds" } }] },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "past_1_0", toolName: "ask_data", output: { type: "text", value: '{"route":"player_event_history"}' } }],
      },
      { role: "assistant", content: "Huit éditions." },
    ]);
  });

  test("a query result is a run_sql call and a custom view a render_html call, numbered in the order of the message", () => {
    const [, calls, results] = history(
      user(text("promotions en LEC")),
      assistant(shown("Équipes promues", '{"rows":[]}', "sql"), { type: "data-html", id: "call_2", data: { title: "Récapitulatif", html: "<p>secret</p>" } }),
    );

    expect(calls).toEqual({
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "past_1_0", toolName: "run_sql", input: { title: "Équipes promues", sql: "SELECT 1" } },
        { type: "tool-call", toolCallId: "past_1_1", toolName: "render_html", input: { title: "Récapitulatif", html: "<p>…</p>" } },
      ],
    });
    expect(results).toEqual({
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "past_1_0", toolName: "run_sql", output: { type: "text", value: '{"rows":[]}' } },
        { type: "tool-result", toolCallId: "past_1_1", toolName: "render_html", output: { type: "text", value: "The view is displayed to the visitor." } },
      ],
    });
  });

  test("an answer of an unknown origin is replayed as ask_data", () => {
    const [, calls] = history(user(text("q")), assistant(shown("q", "{}", "elsewhere")));

    expect(calls).toMatchObject({ content: [{ toolName: "ask_data", input: { question: "q" } }] });
  });

  test("unknown parts, pending answers and messages without text leave nothing", () => {
    expect(
      history(
        user(text("première")),
        assistant({ type: "step-start" }, { type: "reasoning", text: "…" }, shown("en cours", null), { type: "data-html", data: {} }),
        user({ type: "file", url: "x" }),
        user(text("  ")),
        assistant(text("fin")),
      ),
    ).toEqual([
      { role: "user", content: "première" },
      { role: "assistant", content: "fin" },
    ]);
  });

  test("several text parts of one message are joined, one per line", () => {
    expect(history(user(text("Chovy"), { type: "step-start" }, text("aux Worlds")))).toEqual([{ role: "user", content: "Chovy\naux Worlds" }]);
  });

  test("only the last messages are kept, and the history starts on a visitor message", () => {
    const messages = Array.from({ length: CHAT_HISTORY_MESSAGES + 1 }, (_, i) => (i % 2 === 0 ? user(text(`question ${i}`)) : assistant(text(`réponse ${i}`))));
    const kept = history(...messages);

    expect(kept).toHaveLength(CHAT_HISTORY_MESSAGES - 1);
    expect(kept[0]).toEqual({ role: "user", content: "question 2" });
    expect(kept.at(-1)).toEqual({ role: "user", content: `question ${CHAT_HISTORY_MESSAGES}` });
  });

  test("an older visitor message is not looked for beyond the kept messages", () => {
    const kept = history(user(text("ancienne")), ...Array.from({ length: CHAT_HISTORY_MESSAGES - 1 }, (_, i) => assistant(text(`réponse ${i}`))), user(text("dernière")));

    expect(kept).toEqual([{ role: "user", content: "dernière" }]);
  });

  test("a past result is cut to what the history gives each one", () => {
    const [, , results] = history(user(text("q")), assistant(shown("q", "x".repeat(9000))));

    expect(results).toMatchObject({ content: [{ output: { value: "x".repeat(6000) } }] });
  });
});

describe("lastUserText", () => {
  test("the text of the last message when the visitor wrote it", () => {
    expect(lastUserText(ChatMessages.parse([user(text("avant")), assistant(text("réponse")), user(text(" et en 2024 ?"), text("en LCK "))]))).toBe("et en 2024 ?\nen LCK");
  });

  test("nothing when the last message is the agent's or has no text", () => {
    expect(lastUserText(ChatMessages.parse([user(text("question")), assistant(text("réponse"))]))).toBe("");
    expect(lastUserText(ChatMessages.parse([user({ type: "file", url: "x" })]))).toBe("");
  });
});

describe("digestAnswer", () => {
  test("the model reads the route, the unread words and the figures, never an image or what the page adds around", () => {
    const digest = JSON.parse(
      digestAnswer(
        emptyAnswer(
          {
            title: "Faker — Worlds",
            summary: "Faker a disputé une édition.",
            rows: [
              {
                year: 2023,
                event: "Worlds 2023",
                team: "T1",
                place: "1",
                placeLabel: "Vainqueur",
                placeNumber: 1,
                wins: 5,
                losses: 1,
                champions: [{ name: "Azir", games: 4, wins: 3, imageUrl: "https://cdn.example/azir.png" }],
              },
            ],
            pool: {
              subject: "player",
              name: "Faker",
              scope: "Worlds 2023",
              games: 4,
              wins: 3,
              losses: 1,
              picks: 4,
              unique: 1,
              top3Share: 1,
              lines: [{ champion: "Azir", icon: "https://cdn.example/azir.png", games: 4, wins: 3, losses: 1, winrate: 0.75, kda: null, share: 1, players: [] }],
            },
            icons: { T1: "https://cdn.example/t1.png" },
            iconTones: { T1: "dark" },
            teamLeagues: { T1: ["LCK"] },
            profiles: [{ player: "Faker", teams: ["T1"], role: "Mid", photo: { url: "https://cdn.example/faker.png", year: 2023, source: "Leaguepedia" } }],
            sources: [{ label: "Leaguepedia", url: "https://lol.fandom.com/wiki/Faker" }],
            followUps: ["Et en 2024 ?"],
            notes: ["Une note."],
          },
          { route: "player_event_history", unread: ["promotion"] },
        ),
      ),
    );

    expect(digest).toEqual({
      route: "player_event_history",
      wordsNotRead: ["promotion"],
      title: "Faker — Worlds",
      summary: "Faker a disputé une édition.",
      rows: [{ year: 2023, event: "Worlds 2023", team: "T1", place: "1", placeLabel: "Vainqueur", placeNumber: 1, wins: 5, losses: 1, champions: ["Azir 3/4"] }],
      pool: {
        subject: "player",
        name: "Faker",
        scope: "Worlds 2023",
        games: 4,
        wins: 3,
        losses: 1,
        picks: 4,
        unique: 1,
        top3Share: 1,
        lines: [{ champion: "Azir", games: 4, wins: 3, losses: 1, winrate: 0.75, share: 1 }],
      },
      notes: ["Une note."],
    });
  });

  test("an answer that read every word says nothing of unread words", () => {
    expect(JSON.parse(digestAnswer(emptyAnswer({ title: "Vide" }, { route: "none" })))).toEqual({ route: "none", title: "Vide", summary: "" });
  });

  test("keystone figures stay readable: only image keys are hidden", () => {
    const digest = JSON.parse(
      digestAnswer(
        emptyAnswer({
          runes: {
            player: "Faker",
            scope: "LCK 2024",
            champion: null,
            role: null,
            games: 4,
            wins: 3,
            keystoneGames: 4,
            pageGames: 0,
            runes: [{ rune: "Electrocute", kind: "keystone", tree: "Domination", icon: "https://cdn.example/electrocute.png", games: 4, wins: 3 }],
            trees: [],
            pages: [],
            notes: [],
          },
        }),
      ),
    );

    expect(digest.runes.keystoneGames).toBe(4);
    expect(digest.runes.runes).toEqual([{ rune: "Electrocute", kind: "keystone", tree: "Domination", games: 4, wins: 3 }]);
  });

  test("a digest over the limit is cut and says so", () => {
    const digest = digestAnswer(emptyAnswer({ summary: "x".repeat(13_000) }));

    expect(digest).toHaveLength(12_000 + "… (truncated: the visitor sees the full result)".length);
    expect(digest.startsWith('{"route":"sql","title":"Titre","summary":"xxx')).toBe(true);
    expect(digest.endsWith("x… (truncated: the visitor sees the full result)")).toBe(true);
  });
});

describe("the parts kept in a stored message", () => {
  test("a part the page cannot draw is dropped, the others are kept as they are", () => {
    const html = { type: "data-html" as const, id: "h", data: { title: "Vue", html: "<p>ok</p>" } };
    const greeting = { type: "text" as const, text: "Bonjour" };

    const stored = StoredMessages.parse([
      { id: "m1", role: "assistant", parts: [greeting, { type: "text" }, { type: "data-answer", data: { pending: false } }, { type: "tool-ask_data", state: "output-available" }, html] },
    ]);

    expect(stored[0].parts).toEqual([greeting, html]);
  });

  test("an empty list of messages is refused", () => {
    expect(StoredMessages.safeParse([]).success).toBe(false);
  });
});
