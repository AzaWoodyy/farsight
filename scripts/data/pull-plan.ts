/** Pure download decision; installation and checksum checks stay in pull.ts. */
export type PullFacts = {
  local: "absent" | "unusable" | "usable";
  onVercel: boolean;
  token: boolean;
  pinned: string | null;
  force: boolean;
};

export type PullPlan =
  | { kind: "keep_local"; reason: "offline_build" | "no_token" }
  | { kind: "fail"; message: string }
  | { kind: "resolve"; pinned: string | null };

export function planPull(facts: PullFacts): PullPlan {
  const keep = facts.local === "usable" && !facts.pinned && !facts.force;

  if (keep && !facts.onVercel) return { kind: "keep_local", reason: "offline_build" };

  if (keep && !facts.token) return { kind: "keep_local", reason: "no_token" };

  if (!facts.token) return {
    kind: "fail",
    message: facts.onVercel
      ? "DATA_GITHUB_TOKEN is not set on this Vercel project (see docs/deploy.md)"
      : "no usable local database and DATA_GITHUB_TOKEN is not set: run `bun run data:build`, or set the token to download a release",
  };

  return { kind: "resolve", pinned: facts.pinned };
}
