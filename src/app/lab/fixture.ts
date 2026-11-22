import { z } from "zod";
import type { ToolInput } from "@/lib/agent/tools";
import type { Answer, StepPart } from "@/lib/agent/types";

const Status = z.enum(["ok", "warn", "error", "fix"]);

const Step = z.object({
  step: z.enum(["understand", "build", "execute", "format"]),
  state: z.enum(["running", "done"]),
  status: Status,
  title: z.string(),
  entries: z.array(
    z.object({
      status: Status,
      title: z.string(),
      detail: z.string().optional(),
      level: z.enum(["rules", "llm"]).optional(),
      confidence: z.number().optional(),
      at: z.string(),
    }),
  ),
});

const Cell = z.union([z.string(), z.number(), z.null()]);
const Grid = z.object({ columns: z.array(z.string()), rows: z.array(z.array(Cell)) });
const Source = z.object({ label: z.string(), url: z.string() });
const Side = z.enum(["blue", "red"]);
const Count = z.number().nullable();
const Text = z.string().nullable();
const Photo = z.object({ url: z.string(), year: Count, source: z.string() }).nullable();
const RuneKind = z.enum(["keystone", "primary", "secondary", "shard"]);
const Spell = z.object({ name: z.string(), iconUrl: Text });
const Tally = { games: z.number(), wins: z.number() };
const RoleGames = z.array(z.object({ role: z.string(), games: z.number() }));
const ChampionRune = z.object({ rune: z.string(), kind: RuneKind, tree: Text, icon: Text, ...Tally });

const Champions = z.array(z.object({ name: z.string(), ...Tally, imageUrl: Text }));

const ResultRow = z.object({
  year: z.number(),
  event: z.string(),
  team: z.string(),
  place: Text,
  placeLabel: z.string(),
  placeNumber: Count,
  wins: z.number(),
  losses: z.number(),
  champions: Champions,
});

const Timeline = z.object({
  label: z.string(),
  blue: z.string(),
  red: z.string(),
  winner: Side.nullable(),
  durationS: Count,
  version: z.number(),
  gold: z.array(z.object({ s: z.number(), diff: z.number() })),
  events: z.array(
    z.object({
      s: z.number(),
      kind: z.enum(["first_blood", "tower", "inhibitor", "dragon", "elder", "herald", "grubs", "baron", "atakhan", "ace"]),
      side: Side,
      detail: Text,
    }),
  ),
});

const ScoreboardTeam = z.object({
  name: z.string(),
  kills: Count,
  gold: Count,
  towers: Count,
  inhibitors: Count,
  dragons: Count,
  barons: Count,
  heralds: Count,
  grubs: Count,
  dragonKinds: z.array(z.string()),
  soul: Text,
});

const Scoreboard = z.object({
  label: z.string(),
  durationS: Count,
  patch: Text,
  winner: Side.nullable(),
  blue: ScoreboardTeam,
  red: ScoreboardTeam,
  players: z.array(
    z.object({
      side: Side,
      role: Text,
      player: z.string(),
      photo: Photo,
      champion: Text,
      championIcon: Text,
      kills: Count,
      deaths: Count,
      assists: Count,
      gold: Count,
      cs: Count,
      damage: Count,
      vision: Count,
      keystone: Text,
      keystoneIcon: Text,
      spells: z.array(Spell),
      runes: z.array(z.object({ name: z.string(), kind: RuneKind, iconUrl: Text })),
      items: z.array(z.object({ name: z.string(), iconUrl: z.string() })),
    }),
  ),
});

const VersusSide = z.object({
  team: Text,
  role: Text,
  champion: Text,
  championIcon: Text,
  kills: Count,
  deaths: Count,
  assists: Count,
});

const Versus = z.object({
  playerA: z.string(),
  playerB: z.string(),
  scope: z.string(),
  focus: Text,
  global: Grid,
  h2h: Grid.nullable(),
  lanes: z.object({ same: z.number(), roles: RoleGames }),
  games: z.array(z.object({ playedAt: Count, label: z.string(), winA: z.boolean().nullable(), a: VersusSide, b: VersusSide, source: Source })),
});

const Forfeit = { scheduleOnly: z.boolean(), forfeitedBy: Text, source: Source };

const Teams = z.object({
  teamA: z.string(),
  teamB: z.string(),
  scope: z.string(),
  seriesA: z.number(),
  seriesB: z.number(),
  gamesA: z.number(),
  gamesB: z.number(),
  seriesCount: z.number(),
  series: z.array(
    z.object({
      playedAt: Count,
      label: z.string(),
      teamA: z.string(),
      teamB: z.string(),
      winsA: z.number(),
      winsB: z.number(),
      winner: Text,
      ...Forfeit,
    }),
  ),
});

const Pick = z.object({ role: Text, player: z.string(), champion: Text, icon: Text });
const Ban = z.object({ champion: z.string(), icon: Text });

const Series = z.object({
  scope: z.string(),
  count: z.number(),
  series: z.array(
    z.object({
      label: z.string(),
      tournamentPage: z.string(),
      playedAt: Count,
      teamA: z.string(),
      teamB: z.string(),
      winsA: z.number(),
      winsB: z.number(),
      bestOf: Count,
      games: z
        .array(
          z.object({
            n: Count,
            playedAt: Count,
            blue: z.string(),
            red: z.string(),
            winner: Side.nullable(),
            durationS: Count,
            patch: Text,
            picks: z.object({ blue: z.array(Pick), red: z.array(Pick) }),
            bans: z.object({ blue: z.array(Ban), red: z.array(Ban) }),
            source: Source,
          }),
        )
        .nullable(),
      ...Forfeit,
    }),
  ),
});

const Roster = z.object({
  team: z.string(),
  names: z.array(z.string()),
  scope: z.string(),
  ...Tally,
  tournaments: z.array(z.object({ label: z.string(), games: z.number(), source: Source })),
  players: z.array(
    z.object({
      player: z.string(),
      role: z.string(),
      ...Tally,
      starter: z.boolean(),
      tournaments: z.array(z.string()),
      firstPlayed: Count,
      lastPlayed: Count,
      photo: Photo,
      source: Source,
    }),
  ),
});

const Champion = z.object({
  champion: z.string(),
  icon: Text,
  scope: z.string(),
  games: z.number(),
  picks: z.number(),
  bans: z.number(),
  wins: z.number(),
  kda: Count,
  averages: z.array(z.object({ key: z.string(), label: z.string(), value: Count, signed: z.boolean().optional(), counted: z.number() })),
  players: z.array(z.object({ player: z.string(), team: Text, ...Tally, kda: Count })),
  roles: RoleGames,
  focus: z.enum(["items", "runes", "spells"]).nullable(),
  items: z.object({
    games: z.number(),
    items: z.array(z.object({ item: z.string(), icon: z.string(), kind: z.enum(["complete", "boots", "component", "starter", "consumable"]).nullable(), ...Tally })),
    notes: z.array(z.string()),
  }),
  setups: z.object({
    spellGames: z.number(),
    spells: z.array(z.object({ spells: z.array(Spell), ...Tally })),
    keystoneGames: z.number(),
    pageGames: z.number(),
    runes: z.array(ChampionRune),
    notes: z.array(z.string()),
  }),
});

const Pool = z.object({
  subject: z.enum(["player", "team"]),
  name: z.string(),
  scope: z.string(),
  games: z.number(),
  wins: z.number(),
  losses: z.number(),
  picks: z.number(),
  unique: z.number(),
  top3Share: z.number(),
  lines: z.array(
    z.object({
      champion: z.string(),
      icon: Text,
      games: z.number(),
      wins: z.number(),
      losses: z.number(),
      winrate: z.number(),
      kda: Count,
      share: z.number(),
      players: z.array(z.object({ player: z.string(), games: z.number() })),
    }),
  ),
});

const Runes = z.object({
  player: z.string(),
  scope: z.string(),
  champion: z.object({ name: z.string(), icon: Text }).nullable(),
  role: Text,
  ...Tally,
  keystoneGames: z.number(),
  pageGames: z.number(),
  runes: z.array(ChampionRune),
  trees: z.array(z.object({ tree: z.string(), part: z.enum(["primary", "secondary"]), ...Tally })),
  pages: z.array(z.object({ runes: z.array(z.object({ rune: z.string(), kind: RuneKind, tree: Text, icon: Text })), ...Tally })),
  notes: z.array(z.string()),
});

const Meta = z.object({
  route: z.string().pipe(z.custom<Answer["meta"]["route"]>()),
  sqlAvailable: z.boolean(),
  input: z.record(z.string(), z.unknown()).pipe(z.custom<ToolInput>()).nullable(),
  players: z.array(z.string()),
  teams: z.array(z.string()),
  champion: Text,
  league: Text,
  rowCount: z.number(),
  totals: z.record(z.string(), z.union([z.string(), z.number()])),
  ambiguities: z.array(z.object({ mention: z.string(), chosen: z.string(), alternatives: z.array(z.string()), uncertain: z.boolean() })),
  attempts: z.number(),
  unread: z.array(z.string()),
  empty: z.enum(["no_games", "qualifier_only", "zero_count", "no_ingame", "unexplained"]).nullable(),
});

const AnswerSchema = z.object({
  title: z.string(),
  summary: z.string(),
  rows: z.array(ResultRow),
  table: z.object({ columns: z.array(z.string()), rows: z.array(z.array(Cell)), focus: z.string().optional() }).nullable(),
  timeline: Timeline.nullable(),
  scoreboard: Scoreboard.nullable(),
  versus: Versus.nullable(),
  teams: Teams.nullable(),
  roster: Roster.nullable(),
  champion: Champion.nullable(),
  pool: Pool.nullable(),
  runes: Runes.nullable(),
  series: Series.nullable(),
  icons: z.record(z.string(), z.string()),
  iconTones: z.record(z.string(), z.enum(["dark", "light"])),
  teamLeagues: z.record(z.string(), z.array(z.string())),
  profiles: z.array(z.object({ player: z.string(), teams: z.array(z.string()), role: Text, photo: Photo })),
  sources: z.array(Source),
  followUps: z.array(z.string()),
  notes: z.array(z.string()),
  meta: Meta,
});

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

export const schemaMatchesTypes: Same<z.infer<typeof AnswerSchema>, Answer> & Same<z.infer<typeof Step>, StepPart> = true;

export const LabFixture = z.object({
  question: z.string(),
  steps: z.array(Step),
  answer: AnswerSchema.nullable(),
  error: z.string().nullable(),
});

export type LabFixture = z.infer<typeof LabFixture>;
