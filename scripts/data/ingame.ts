/**
 * In-game summary of one game, computed at ingestion from its Riot JSON
 * (stats + timeline, match-v4 or match-v5 shape): the per-player and per-team
 * numbers that go to SQL. The raw JSON stays in object storage.
 *
 * Definitions (the same for v4 and v5, so seasons compare):
 * - `*_10/15/20`: the timeline frame of that minute (frames are one minute
 *   apart); null when the game ended earlier or has no timeline.
 * - `kills_10` / `deaths_10` / `assists_10`: champion kills strictly before 10:00.
 * - `solo_kills`: champion kills with no assisting champion, by a champion
 *   (executions by towers or minions excluded).
 * - `first_blood_*`: Riot's end-of-game flags; the victim comes from the
 *   first champion kill of the timeline.
 * - `plates`: turret plates destroyed, from the match-v5 timelines (null for
 *   match-v4 ones, which have no plate event, and before patch 9.2).
 * - `dragons`: every dragon kill of the timeline, in order: second, Riot team
 *   and element (null before the elements, patch 6.9); null without a timeline.
 * - `elder_dragons`: elder dragons a team killed (null without a timeline).
 * - `dragon_soul` / `soul`: whether the team got the dragon soul, and its
 *   element. The soul goes to the first team with four elemental dragons, from
 *   patch 9.23. match-v5 timelines say so (DRAGON_SOUL_GIVEN with a team; the
 *   same event with team 0 only announces the element of the map); the count
 *   is used otherwise. Null without a timeline or before patch 9.23.
 */
import { z } from "zod";
import { dragonKind, soulKind } from "../../src/lib/domain/dragons";
import type { Json } from "../../src/lib/json";
import type { RawGame } from "../../src/lib/sources/riot";

/** Bump when the computation changes: summaries of an older version are recomputed from the raw JSON. */
export const DERIVE_VERSION = 3;

/**
 * Oldest version whose numbers are those of DERIVE_VERSION: such a summary only lacks what later versions added
 * (dragons and souls, from 3). `data:build` keeps it with these columns NULL; `data:fetch` recomputes it as soon as
 * it can read the raw JSON, and a published release refuses it.
 */
export const DERIVE_COMPATIBLE = 2;

const MINUTES = [10, 15, 20] as const;

const N = z.number().nullable();

export const PlayerSummary = z.object({
  pid: z.number().int(),
  /** Riot side: 100 blue, 200 red. */
  teamId: z.number().int(),
  championId: z.number().int(),
  championName: z.string().nullable(),
  /** Riot summoner name, kept to diagnose mapping problems. */
  name: z.string().nullable(),
  kills: z.number(),
  deaths: z.number(),
  assists: z.number(),
  gold_10: N, gold_15: N, gold_20: N,
  xp_10: N, xp_15: N, xp_20: N,
  cs_10: N, cs_15: N, cs_20: N,
  kills_10: N, deaths_10: N, assists_10: N,
  solo_kills: N,
  first_blood_kill: N, first_blood_assist: N, first_blood_victim: N,
  double_kills: N, triple_kills: N, quadra_kills: N, penta_kills: N,
  wards_placed: N, wards_killed: N, control_wards: N,
  plates: N,
  damage_taken: N,
});

export type PlayerSummary = z.infer<typeof PlayerSummary>;

export const TeamSummary = z.object({
  teamId: z.number().int(),
  first_blood: N, first_tower: N, first_dragon: N, first_herald: N, first_baron: N, first_inhibitor: N,
  plates: N,
  gold_10: N, gold_15: N, gold_20: N,
  kills_10: N, kills_15: N, kills_20: N,
  towers_15: N,
  // From derive 3: absent from an older summary.
  elder_dragons: N.optional(),
  dragon_soul: N.optional(),
  soul: z.string().nullable().optional(),
});

export type TeamSummary = z.infer<typeof TeamSummary>;

export const DragonKill = z.object({
  /** Second of the game. */
  t: z.number().int(),
  /** Riot side of the killer, null when the timeline does not tell. */
  teamId: z.number().int().nullable(),
  kind: z.string().nullable(),
});

export type DragonKill = z.infer<typeof DragonKill>;

/** One line of data/raw/ingame.jsonl: a game's summary, or why there is none. */
export const IngameLine = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    derive: z.number().int(),
    key: z.string(),
    gameId: z.string(),
    version: z.number().int(),
    statsPage: z.string(),
    hasTimeline: z.boolean(),
    durationS: z.number().nullable(),
    players: z.array(PlayerSummary),
    teams: z.array(TeamSummary),
    /** From derive 3 (absent from an older summary); null without a timeline. */
    dragons: z.array(DragonKill).nullable().optional(),
  }),
  z.object({
    status: z.enum(["missing", "invalid"]),
    key: z.string(),
    gameId: z.string(),
    checkedAt: z.string(),
    reason: z.string(),
  }),
]);

export type IngameLine = z.infer<typeof IngameLine>;

export type IngameOk = Extract<IngameLine, { status: "ok" }>;

// --- Riot JSON, only the fields we read (v4 and v5) ---------------------------

const num = z.number().optional();
const flag = z.boolean().optional();

const V4Stats = z.object({
  kills: num, deaths: num, assists: num,
  firstBloodKill: flag, firstBloodAssist: flag,
  doubleKills: num, tripleKills: num, quadraKills: num, pentaKills: num,
  wardsPlaced: num, wardsKilled: num, visionWardsBoughtInGame: num, totalDamageTaken: num,
});

const Participant = V4Stats.extend({
  participantId: z.number(),
  teamId: z.number(),
  championId: z.number(),
  championName: z.string().optional(),
  summonerName: z.string().optional(),
  riotIdGameName: z.string().optional(),
  stats: V4Stats.optional(),
});

const Objective = z.object({ first: flag, kills: num }).optional();

const Team = z.object({
  teamId: z.number(),
  firstBlood: flag, firstTower: flag, firstDragon: flag, firstRiftHerald: flag, firstBaron: flag, firstInhibitor: flag,
  objectives: z
    .object({ champion: Objective, tower: Objective, dragon: Objective, riftHerald: Objective, baron: Objective, inhibitor: Objective })
    .optional(),
});

const Identity = z.object({ participantId: z.number(), player: z.object({ summonerName: z.string().optional() }).optional() });

const Stats = z.object({
  gameDuration: num,
  gameVersion: z.string().optional(),
  participants: z.array(Participant),
  participantIdentities: z.array(Identity).optional(),
  teams: z.array(Team),
});

const Event = z.object({
  type: z.string(),
  timestamp: z.number(),
  killerId: num,
  victimId: num,
  assistingParticipantIds: z.array(z.number()).optional(),
  teamId: num,
  killType: z.string().optional(),
  buildingType: z.string().optional(),
  monsterType: z.string().optional(),
  monsterSubType: z.string().optional(),
  killerTeamId: num,
  name: z.string().optional(),
});

const Frame = z.object({
  timestamp: z.number(),
  participantFrames: z.record(
    z.string(),
    z.object({ participantId: num, totalGold: num, xp: num, minionsKilled: num, jungleMinionsKilled: num }),
  ),
  events: z.array(Event).catch([]),
});

const Timeline = z.object({ frames: z.array(Frame) });

const Wrapped = z.object({ info: z.record(z.string(), z.json()) });

/** match-v5 JSON may come wrapped as { metadata, info }. */
function unwrap(json: Json): Json {
  const wrapped = Wrapped.safeParse(json);

  return wrapped.success ? wrapped.data.info : json;
}

const bit = (b: boolean | undefined) => (b == null ? null : b ? 1 : 0);

/** Patch 9.2 introduced turret plates. */
function hasPlates(version: string | undefined): boolean {
  const [major, minor] = (version ?? "").split(".").map(Number);

  return major > 9 || (major === 9 && minor >= 2);
}

/** Patch 9.23 introduced the dragon soul. */
function hasSouls(version: string | undefined): boolean {
  const [major, minor] = (version ?? "").split(".").map(Number);

  return major > 9 || (major === 9 && minor >= 23);
}

/** Elemental dragons a team needs for the soul. */
const SOUL_DRAGONS = 4;

/** The game summary, or throws when the JSON does not have the expected shape. */
export function summarizeGame(raw: RawGame): IngameOk {
  const stats = Stats.parse(unwrap(raw.stats));
  const timeline = raw.timeline == null ? null : Timeline.safeParse(unwrap(raw.timeline));
  const frames = timeline?.success ? timeline.data.frames : null;
  const events = (frames ?? []).flatMap((f) => f.events).sort((a, b) => a.timestamp - b.timestamp);
  const kills = events.filter((e) => e.type === "CHAMPION_KILL");
  // match-v4 timelines have no plate event, even after plates existed.
  const plates = raw.version >= 5 && hasPlates(stats.gameVersion) && frames ? events.filter((e) => e.type === "TURRET_PLATE_DESTROYED") : null;
  const teamOf = new Map(stats.participants.map((p) => [p.participantId, p.teamId]));
  const names = new Map((stats.participantIdentities ?? []).map((i) => [i.participantId, i.player?.summonerName ?? null]));
  const firstKill = kills[0];

  /** Frame of minute m, if the game lasted that long. */
  const frameAt = (m: number) => {
    const f = frames?.[m];

    return f && Math.abs(f.timestamp - m * 60_000) < 30_000 ? f : null;
  };

  const snapshot = (pid: number, m: number) => {
    const pf = frameAt(m)?.participantFrames[String(pid)];

    return pf
      ? { gold: pf.totalGold ?? null, xp: pf.xp ?? null, cs: pf.minionsKilled == null ? null : pf.minionsKilled + (pf.jungleMinionsKilled ?? 0) }
      : { gold: null, xp: null, cs: null };
  };

  const riotSide = (n: number | undefined) => (n === 100 || n === 200 ? n : null);

  const dragons = frames
    ? events
        .filter((e) => e.type === "ELITE_MONSTER_KILL" && e.monsterType === "DRAGON")
        .map((e): DragonKill => ({ t: Math.round(e.timestamp / 1000), teamId: riotSide(e.killerTeamId) ?? riotSide(teamOf.get(e.killerId ?? 0)), kind: dragonKind(e.monsterSubType) }))
    : null;

  const soulKnown = dragons != null && hasSouls(stats.gameVersion);

  /** The team with the soul and its element, or null when nobody got it. */
  const soul = (() => {
    if (!dragons || !soulKnown) return null;
    const given = events.find((e) => e.type === "DRAGON_SOUL_GIVEN" && riotSide(e.teamId) != null);

    if (given) return { teamId: given.teamId, kind: soulKind(given.name) };
    const taken = new Map<number, number>();

    for (const d of dragons) {
      if (d.teamId == null || d.kind === "elder") continue;
      const n = (taken.get(d.teamId) ?? 0) + 1;

      if (n === SOUL_DRAGONS) return { teamId: d.teamId, kind: d.kind };
      taken.set(d.teamId, n);
    }

    return null;
  })();

  const before10 = kills.filter((k) => k.timestamp < 600_000);
  const count = (list: typeof kills, pred: (e: (typeof kills)[number]) => boolean) => (frames ? list.filter(pred).length : null);

  const players = stats.participants.map((p): PlayerSummary => {
    const s = { ...p, ...p.stats };
    const pid = p.participantId;
    const [a, b, c] = MINUTES.map((m) => snapshot(pid, m));

    return {
      pid,
      teamId: p.teamId,
      championId: p.championId,
      championName: p.championName ?? null,
      name: p.riotIdGameName ?? p.summonerName ?? names.get(pid) ?? null,
      kills: s.kills ?? 0,
      deaths: s.deaths ?? 0,
      assists: s.assists ?? 0,
      gold_10: a.gold, gold_15: b.gold, gold_20: c.gold,
      xp_10: a.xp, xp_15: b.xp, xp_20: c.xp,
      cs_10: a.cs, cs_15: b.cs, cs_20: c.cs,
      kills_10: count(before10, (k) => k.killerId === pid),
      deaths_10: count(before10, (k) => k.victimId === pid),
      assists_10: count(before10, (k) => (k.assistingParticipantIds ?? []).includes(pid)),
      solo_kills: count(kills, (k) => k.killerId === pid && (k.assistingParticipantIds ?? []).length === 0),
      first_blood_kill: bit(s.firstBloodKill),
      first_blood_assist: bit(s.firstBloodAssist),
      first_blood_victim: firstKill ? (firstKill.victimId === pid ? 1 : 0) : null,
      double_kills: s.doubleKills ?? null,
      triple_kills: s.tripleKills ?? null,
      quadra_kills: s.quadraKills ?? null,
      penta_kills: s.pentaKills ?? null,
      wards_placed: s.wardsPlaced ?? null,
      wards_killed: s.wardsKilled ?? null,
      control_wards: s.visionWardsBoughtInGame ?? null,
      plates: plates ? plates.filter((e) => e.killerId === pid).length : null,
      damage_taken: s.totalDamageTaken ?? null,
    };
  });

  const teams = stats.teams.map((t): TeamSummary => {
    const o = t.objectives;

    const side = (m: number) => {
      const f = frameAt(m);

      return f
        ? Object.values(f.participantFrames).reduce(
            (sum, pf) => sum + (pf.participantId != null && teamOf.get(pf.participantId) === t.teamId ? (pf.totalGold ?? 0) : 0),
            0,
          )
        : null;
    };

    const killsAt = (m: number) => (frames && frames.length > m ? kills.filter((k) => k.timestamp < m * 60_000 && teamOf.get(k.killerId ?? 0) === t.teamId).length : null);

    // BUILDING_KILL / TURRET_PLATE_DESTROYED name the team that lost the building.
    const towers15 =
      frames && frames.length > 15
        ? events.filter((e) => e.type === "BUILDING_KILL" && e.buildingType === "TOWER_BUILDING" && e.timestamp < 900_000 && e.teamId != null && e.teamId !== t.teamId).length
        : null;

    return {
      teamId: t.teamId,
      first_blood: bit(o?.champion?.first ?? t.firstBlood),
      first_tower: bit(o?.tower?.first ?? t.firstTower),
      first_dragon: bit(o?.dragon?.first ?? t.firstDragon),
      first_herald: bit(o?.riftHerald?.first ?? t.firstRiftHerald),
      first_baron: bit(o?.baron?.first ?? t.firstBaron),
      first_inhibitor: bit(o?.inhibitor?.first ?? t.firstInhibitor),
      plates: plates ? plates.filter((e) => e.teamId != null && e.teamId !== t.teamId).length : null,
      gold_10: side(10), gold_15: side(15), gold_20: side(20),
      kills_10: killsAt(10), kills_15: killsAt(15), kills_20: killsAt(20),
      towers_15: towers15,
      elder_dragons: dragons ? dragons.filter((d) => d.teamId === t.teamId && d.kind === "elder").length : null,
      dragon_soul: soulKnown ? (soul?.teamId === t.teamId ? 1 : 0) : null,
      soul: soul?.teamId === t.teamId ? soul.kind : null,
    };
  });

  const duration = stats.gameDuration ?? null;

  return {
    status: "ok",
    derive: DERIVE_VERSION,
    key: raw.key,
    gameId: raw.gameId,
    version: raw.version,
    statsPage: raw.statsPage,
    hasTimeline: frames != null,
    // match-v4 and early v5 report milliseconds in gameDuration for some games.
    durationS: duration == null ? null : duration > 20_000 ? Math.round(duration / 1000) : duration,
    players,
    teams,
    dragons,
  };
}
