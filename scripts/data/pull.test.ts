import { describe, expect, test } from "bun:test";
import { planPull, type PullFacts } from "./pull-plan";

const facts: PullFacts = { local: "usable", onVercel: false, token: false, pinned: null, force: false };

describe("data:pull decision", () => {
  test("keeps a usable offline rebuild even when a token is available", () => {
    expect(planPull(facts)).toEqual({ kind: "keep_local", reason: "offline_build" });
    expect(planPull({ ...facts, token: true })).toEqual({ kind: "keep_local", reason: "offline_build" });
  });
  test("a local vercel build can run without a token", () => {
    expect(planPull({ ...facts, onVercel: true })).toEqual({ kind: "keep_local", reason: "no_token" });
  });
  test("cloud builds resolve a release when authenticated", () => {
    expect(planPull({ ...facts, onVercel: true, token: true })).toEqual({ kind: "resolve", pinned: null });
  });

  for (const local of ["absent", "unusable"] as const) {
    for (const onVercel of [false, true]) {
      test(`${local} database, vercel=${onVercel}: resolves a release with or without a token`, () => {
        expect(planPull({ ...facts, local, onVercel })).toEqual({ kind: "resolve", pinned: null });
        expect(planPull({ ...facts, local, onVercel, token: true })).toEqual({ kind: "resolve", pinned: null });
      });
    }
  }

  test("pinning and forcing never keep the local file, with or without a token", () => {
    expect(planPull({ ...facts, pinned: "data-20261113" })).toEqual({ kind: "resolve", pinned: "data-20261113" });
    expect(planPull({ ...facts, force: true })).toEqual({ kind: "resolve", pinned: null });
    expect(planPull({ ...facts, token: true, pinned: "data-20261113" })).toEqual({ kind: "resolve", pinned: "data-20261113" });
    expect(planPull({ ...facts, token: true, force: true })).toEqual({ kind: "resolve", pinned: null });
  });
});
