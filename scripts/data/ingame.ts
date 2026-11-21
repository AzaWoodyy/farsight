/**
 * In-game summary of one game, computed at ingestion from its Riot JSON
 * (stats + timeline, match-v4 or match-v5 shape): the per-player and per-team
 * numbers that go to SQL. The raw JSON stays in object storage.
 *
 * Definitions (the same for v4 and v5, so seasons compare):
 * - `*_10/15/20` (gold, XP, CS, team gold): the timeline frame of that minute,
 *   chosen by its time (frames are one minute apart, a few hundred ms late in
 *   match-v5); null when the game or its timeline ended before the minute, when
 *   no frame is that close, or without a timeline. The last frame of a match-v5
 *   timeline is the end of the game: a game over at 19:46 has one about 20:00,
 *   which is no observation at 20:00.
 * - team `kills_10/15/20` and `towers_15`: counted strictly before the minute,
 *   for a game whose duration and timeline both reach it (null otherwise).
 * - player `kills_10` / `deaths_10` / `assists_10`: champion kills strictly
 *   before 10:00, whenever the game has a timeline.
 * - `solo_kills`: champion kills with no assisting champion, by a champion
 *   (executions by towers or minions excluded).
 * - `first_blood_*`: Riot's end-of-game flags; the victim comes from the
 *   credited first blood of the timeline (`src/lib/sources/first-blood`: an
 *   execution is skipped, and the victim is unknown when the kill does not
 *   match Riot's flags).
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
 *
 * From derive 4, what Leaguepedia's scoreboard lacks on many 2018-2020 games, for `data:build` to fall back on:
 * - `damage`: damage dealt to champions; `vision`: vision score. Null when no participant of the game has a
 *   non-zero value (the field was not tracked yet).
 * - `runes`: the rune ids in Leaguepedia's order, keystone, three primary runes, two secondary runes, then the stat
 *   shards offense, flex, defense (six ids before the shards, patch 8.23); `primary_tree` / `secondary_tree`: the
 *   two tree ids. Null before Runes Reforged or when a slot (a shard from 8.23) is missing.
 * - `heralds`: Rift Heralds a team killed, from Riot's end-of-game count; null before the Herald (patch 5.22).
 * - `gameVersion`: Riot's full game version ("9.11.276.3025").
 */
import { z } from "zod";
import { dragonKind, soulKind } from "../../src/lib/domain/dragons";
import type { Json } from "../../src/lib/json";
import { firstBlood, firstBloodFlags } from "../../src/lib/sources/first-blood";
import type { RawGame } from "../../src/lib/sources/riot";

/** Bump when the computation changes: summaries of an older version are recomputed from the raw JSON. */
export const DERIVE_VERSION = 5;

/**
 * Oldest version whose numbers are those of DERIVE_VERSION: such a summary only lacks what later versions added
 * (dragons and souls from 3, Leaguepedia fallbacks from 4). `data:build` keeps it with these columns NULL; `data:fetch` recomputes it as soon as
 * it can read the raw JSON, and a published release refuses it. Derive 5 changed existing numbers (the minute
 * statistics of games that ended before the minute, the first-blood victim after an execution), so no older summary
 * is compatible.
 */
export const DERIVE_COMPATIBLE = 5;

const MINUTES = [10, 15, 20] as const;

const MINUTE_MS = 60_000;

/** How far from its minute a frame may be and still be that minute's observation. */
const FRAME_TOLERANCE_MS = 30_000;

/** match-v4 and early v5 report milliseconds in gameDuration for some games, the others seconds. */
const durationMs = (d: number | undefined) => (d == null ? null : d > 20_000 ? d : d * 1000);

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
  // From derive 4: absent from an older summary.
  damage: N.optional(),
  vision: N.optional(),
  runes: z.array(z.number().int()).nullable().optional(),
  primary_tree: N.optional(),
  secondary_tree: N.optional(),
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
  // From derive 4.
  heralds: N.optional(),
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
    /** From derive 4: Riot's full game version, null when the JSON has none. */
    gameVersion: z.string().nullable().optional(),
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
  totalDamageDealtToChampions: num, visionScore: num,
  // match-v4 rune page.
  perk0: num, perk1: num, perk2: num, perk3: num, perk4: num, perk5: num,
  perkPrimaryStyle: num, perkSubStyle: num,
  statPerk0: num, statPerk1: num, statPerk2: num,
});

/** match-v5 rune page. */
const Perks = z.object({
  statPerks: z.object({ offense: num, flex: num, defense: num }).optional(),
  styles: z.array(z.object({ description: z.string().optional(), style: num, selections: z.array(z.object({ perk: num })).optional() })).optional(),
});

const Participant = V4Stats.extend({
  participantId: z.number(),
  teamId: z.number(),
  championId: z.number(),
  championName: z.string().optional(),
  summonerName: z.string().optional(),
  riotIdGameName: z.string().optional(),
  perks: Perks.optional(),
  stats: V4Stats.optional(),
});

const Objective = z.object({ first: flag, kills: num }).optional();

const Team = z.object({
  teamId: z.number(),
  firstBlood: flag, firstTower: flag, firstDragon: flag, firstRiftHerald: flag, firstBaron: flag, firstInhibitor: flag,
  riftHeraldKills: num,
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

/** Patch 8.23 introduced the stat shards. */
function hasShards(version: string | undefined): boolean {
  const [major, minor] = (version ?? "").split(".").map(Number);

  return major > 8 || (major === 8 && minor >= 23);
}

/** Patch 5.22 introduced the Rift Herald. */
function hasHeralds(version: string | undefined): boolean {
  const [major, minor] = (version ?? "").split(".").map(Number);

  return major > 5 || (major === 5 && minor >= 22);
}

/** Patch 9.23 introduced the dragon soul. */
function hasSouls(version: string | undefined): boolean {
  const [major, minor] = (version ?? "").split(".").map(Number);

  return major > 9 || (major === 9 && minor >= 23);
}

/** A Riot id, null when absent or 0 (an empty slot). */
const id = (n: number | undefined) => (n != null && n > 0 ? n : null);

const known = (ids: (number | null)[]): ids is number[] => ids.every((x) => x != null);

type RunePage = { runes: number[] | null; primary: number | null; secondary: number | null };

/** The rune page of a participant, match-v4 (`perk0`..) or match-v5 (`perks`), in Leaguepedia's order. */
function runePage(p: z.infer<typeof Participant>, s: z.infer<typeof V4Stats>, version: string | undefined): RunePage {
  const styles = p.perks?.styles;
  const primaryStyle = styles?.find((x) => x.description === "primaryStyle") ?? styles?.[0];
  const subStyle = styles?.find((x) => x.description === "subStyle") ?? styles?.[1];
  const shards = p.perks?.statPerks;

  const [perks, shardIds, primary, secondary] = styles
    ? [
        [...(primaryStyle?.selections ?? []), ...(subStyle?.selections ?? [])].map((x) => x.perk),
        [shards?.offense, shards?.flex, shards?.defense],
        primaryStyle?.style,
        subStyle?.style,
      ]
    : [[s.perk0, s.perk1, s.perk2, s.perk3, s.perk4, s.perk5], [s.statPerk0, s.statPerk1, s.statPerk2], s.perkPrimaryStyle, s.perkSubStyle];

  const page = perks.map(id);
  const statIds = shardIds.map(id);
  // From patch 8.23 a page has its three shards: without them it is incomplete, not a page of six runes. Without a
  // version, only a page with its shards is trusted.
  const shardsAt = /^\d+\.\d+(?:\.|$)/.test(version ?? "") ? hasShards(version) : true;
  const none = { runes: null, primary: null, secondary: null };

  if (page.length !== 6 || !known(page)) return none;

  if (!shardsAt) return { runes: page, primary: id(primary), secondary: id(secondary) };

  return known(statIds) ? { runes: [...page, ...statIds], primary: id(primary), secondary: id(secondary) } : none;
}

/**
 * Leaguepedia's patch ("9.11") of a Riot game version ("9.11.276.3025"), for a game whose scoreboard has none. Only
 * up to season 14: from 2025 Riot's versions (15.x) and Leaguepedia's patches (25.x, 25.S1.1) are numbered apart.
 */
export function leaguepediaPatch(version: string | null | undefined): string | null {
  const m = /^(\d+)\.(\d+)\./.exec(version ?? "");

  return m && Number(m[1]) <= 14 ? `${Number(m[1])}.${Number(m[2])}` : null;
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
  const credited = firstBlood(kills, teamOf, firstBloodFlags(stats), raw.version);

  const endMs = durationMs(stats.gameDuration);
  const lastFrameMs = frames?.length ? frames[frames.length - 1].timestamp : null;

  /**
   * Whether the game and its timeline both lasted until minute m, in milliseconds (19:59.9 is not 20:00). The
   * timeline's last frame stands in for a missing duration.
   */
  const reached = (m: number) => lastFrameMs != null && lastFrameMs >= m * MINUTE_MS && (endMs ?? lastFrameMs) >= m * MINUTE_MS;

  /** Frame of minute m: the closest to it in time, if the game lasted that long. */
  const frameAt = (m: number) => {
    if (!frames || !reached(m)) return null;
    let best: (typeof frames)[number] | null = null;

    for (const f of frames) {
      const gap = Math.abs(f.timestamp - m * MINUTE_MS);

      if (gap < FRAME_TOLERANCE_MS && (!best || gap < Math.abs(best.timestamp - m * MINUTE_MS))) best = f;
    }

    return best;
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
  const merged = stats.participants.map((p) => ({ ...p, ...p.stats }));
  /** Null for every participant when none has a non-zero value: the field was not tracked yet. */
  const tracked = (pick: (s: (typeof merged)[number]) => number | undefined) => merged.some((s) => (pick(s) ?? 0) > 0);
  const damageTracked = tracked((s) => s.totalDamageDealtToChampions);
  const visionTracked = tracked((s) => s.visionScore);
  const count = (list: typeof kills, pred: (e: (typeof kills)[number]) => boolean) => (frames ? list.filter(pred).length : null);

  const players = stats.participants.map((p, i): PlayerSummary => {
    const s = merged[i];
    const pid = p.participantId;
    const page = runePage(p, s, stats.gameVersion);
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
      first_blood_victim: credited ? (credited.victimId === pid ? 1 : 0) : null,
      double_kills: s.doubleKills ?? null,
      triple_kills: s.tripleKills ?? null,
      quadra_kills: s.quadraKills ?? null,
      penta_kills: s.pentaKills ?? null,
      wards_placed: s.wardsPlaced ?? null,
      wards_killed: s.wardsKilled ?? null,
      control_wards: s.visionWardsBoughtInGame ?? null,
      plates: plates ? plates.filter((e) => e.killerId === pid).length : null,
      damage_taken: s.totalDamageTaken ?? null,
      damage: damageTracked ? (s.totalDamageDealtToChampions ?? null) : null,
      vision: visionTracked ? (s.visionScore ?? null) : null,
      runes: page.runes,
      primary_tree: page.primary,
      secondary_tree: page.secondary,
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

    const killsAt = (m: number) => (reached(m) ? kills.filter((k) => k.timestamp < m * MINUTE_MS && teamOf.get(k.killerId ?? 0) === t.teamId).length : null);

    // BUILDING_KILL / TURRET_PLATE_DESTROYED name the team that lost the building.
    const towers15 =
      reached(15)
        ? events.filter((e) => e.type === "BUILDING_KILL" && e.buildingType === "TOWER_BUILDING" && e.timestamp < 15 * MINUTE_MS && e.teamId != null && e.teamId !== t.teamId).length
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
      heralds: hasHeralds(stats.gameVersion) ? (o?.riftHerald?.kills ?? t.riftHeraldKills ?? null) : null,
    };
  });


  return {
    status: "ok",
    derive: DERIVE_VERSION,
    key: raw.key,
    gameId: raw.gameId,
    version: raw.version,
    statsPage: raw.statsPage,
    hasTimeline: frames != null,
    // match-v4 and early v5 report milliseconds in gameDuration for some games.
    durationS: stats.gameDuration == null ? null : stats.gameDuration > 20_000 ? Math.round(stats.gameDuration / 1000) : stats.gameDuration,
    players,
    teams,
    dragons,
    gameVersion: stats.gameVersion ?? null,
  };
}
