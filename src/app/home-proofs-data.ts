import { z } from "zod";
import type { Locale } from "@/lib/locale";

const Cell = z.union([z.string(), z.number(), z.null()]);
const Count = z.number().nullable();
const Text = z.string().nullable();
const Photo = z.object({ url: z.string(), year: Count, source: z.string() }).nullable();
const Profile = z.object({ player: z.string(), teams: z.array(z.string()), role: Text, photo: Photo });
const LatestSide = z.object({ champion: Text, championIcon: Text, kills: Count, deaths: Count, assists: Count });

const Shared = {
  question: z.string(),
  title: z.string(),
  sources: z.array(z.object({ label: z.string(), url: z.string() })),
};

const Logos = { icons: z.record(z.string(), z.string()), iconTones: z.record(z.string(), z.enum(["dark", "light"])) };

const Duel = z.object({
  kind: z.literal("duel"),
  ...Shared,
  h2h: z.object({ columns: z.array(z.string()), rows: z.array(z.array(Cell)) }),
  lanes: z.object({ same: z.number(), roles: z.array(z.object({ role: z.string(), games: z.number() })) }),
  profiles: z.array(Profile),
  latest: z.object({ playedAt: Count, a: LatestSide, b: LatestSide }).nullable(),
});

const Teams = z.object({
  kind: z.literal("teams"),
  ...Shared,
  ...Logos,
  teamA: z.string(),
  teamB: z.string(),
  seriesA: z.number(),
  seriesB: z.number(),
  gamesA: z.number(),
  gamesB: z.number(),
  seriesCount: z.number(),
  series: z.array(z.object({ playedAt: Count, label: z.string(), winsA: z.number(), winsB: z.number() })),
});

const Series = z.object({
  kind: z.literal("series"),
  ...Shared,
  ...Logos,
  teamA: z.string(),
  teamB: z.string(),
  winsA: z.number(),
  winsB: z.number(),
  bestOf: Count,
  playedAt: Count,
  games: z.array(z.object({ n: Count, winner: z.enum(["a", "b"]).nullable(), side: z.enum(["blue", "red"]).nullable(), durationS: Count })),
});

const Champion = z.object({
  kind: z.literal("champion"),
  ...Shared,
  champion: z.string(),
  icon: Text,
  games: z.number(),
  picks: z.number(),
  bans: z.number(),
  wins: z.number(),
  kda: Count,
  players: z.array(z.object({ player: z.string(), team: Text, games: z.number(), wins: z.number() })),
});

const Runes = z.object({
  kind: z.literal("runes"),
  ...Shared,
  profile: Profile.nullable(),
  player: z.string(),
  games: z.number(),
  wins: z.number(),
  keystones: z.array(z.object({ rune: z.string(), icon: Text, games: z.number(), wins: z.number() })),
});

export const HomeProof = z.discriminatedUnion("kind", [Duel, Teams, Series, Champion, Runes]);

export type HomeProof = z.infer<typeof HomeProof>;

export type ProofOf<K extends HomeProof["kind"]> = Extract<HomeProof, { kind: K }>;

export const HomeProofs = z.object({ fr: z.array(HomeProof), en: z.array(HomeProof) });

export type HomeProofs = z.infer<typeof HomeProofs>;

export const PROOF_QUESTIONS: Record<HomeProof["kind"], Record<Locale, string>> = {
  duel: { fr: "Caliste contre Supa", en: "Caliste vs Supa" },
  teams: { fr: "KC contre MKOI", en: "KC vs MKOI" },
  series: { fr: "Finale des Worlds 2026", en: "Worlds 2026 final" },
  champion: { fr: "Stats d'Azir aux Worlds 2025", en: "Azir stats at Worlds 2025" },
  runes: { fr: "Keystones de Chovy en LCK 2025", en: "Chovy's keystones in LCK 2025" },
};

export const PROOF_KINDS = ["duel", "teams", "series", "champion", "runes"] as const satisfies readonly HomeProof["kind"][];

export function readProofs(inlined = process.env.HOME_PROOFS): HomeProofs | null {
  return inlined ? HomeProofs.parse(JSON.parse(inlined)) : null;
}
