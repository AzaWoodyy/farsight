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
  | { kind: "resolve"; pinned: string | null };

export function planPull(facts: PullFacts): PullPlan {
  const keep = facts.local === "usable" && !facts.pinned && !facts.force;

  if (keep && !facts.onVercel) return { kind: "keep_local", reason: "offline_build" };

  if (keep && !facts.token) return { kind: "keep_local", reason: "no_token" };

  // The releases are public: without a token the download is anonymous.
  return { kind: "resolve", pinned: facts.pinned };
}
