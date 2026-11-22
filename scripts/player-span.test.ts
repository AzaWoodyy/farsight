import { describe, expect, test } from "bun:test";
import { aliasCandidates, PLAYER_SPAN_WIDTH, playerSpan } from "../src/lib/agent/understand";

const QUESTIONS = [
  ["les", "résultats", "de", "Chovy", "à", "chaque", "Worlds", "2024"],
  ["정지훈", "et", "Faker", "contre", "T1", "en", "LCK"],
  ["Hans", "Sama", "Rekkles", "Caps", "Upset", "Hylissang", "et", "de", "la"],
  ["Ruler", "2", "3", "les", "des", "d", "Kiin", "Canyon", "Zeus", "Oner", "Keria"],
  ["李相赫", "a", "the", "Bo", "Yo", "Jankos"],
];

const spans = (tokens: string[]) =>
  tokens.flatMap((_, i) => Array.from({ length: tokens.length - i }, (_, k) => tokens.slice(i, i + k + 1)));

describe("player spans", () => {
  test("every span detection may look up is among the alias candidates", () => {
    for (const tokens of QUESTIONS) {
      const candidates = new Set(aliasCandidates(tokens));
      const asked = spans(tokens).flatMap((words) => playerSpan(words) ?? []);

      expect(asked.filter((mention) => !candidates.has(mention))).toEqual([]);
      expect([...candidates].toSorted()).toEqual([...new Set(asked)].toSorted());
    }
  });

  test("a span is read as a player alias only within its width and length", () => {
    expect(playerSpan(["Chovy"])).toBe("Chovy");
    expect(playerSpan(["정지"])).toBe("정지");
    expect(playerSpan(["Bo"])).toBeNull();
    expect(playerSpan(["de"])).toBeNull();
    expect(playerSpan(["de", "la"])).toBeNull();
    expect(playerSpan(["20", "24"])).toBeNull();
    expect(playerSpan(Array.from({ length: PLAYER_SPAN_WIDTH }, () => "Faker"))).not.toBeNull();
    expect(playerSpan(Array.from({ length: PLAYER_SPAN_WIDTH + 1 }, () => "Faker"))).toBeNull();
  });
});
