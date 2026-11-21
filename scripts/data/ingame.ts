import { z } from "zod";
import { dragonKind, soulKind } from "../../src/lib/domain/dragons";
import type { Json } from "../../src/lib/json";
import { firstBlood, firstBloodFlags } from "../../src/lib/sources/first-blood";
import type { RawGame } from "../../src/lib/sources/riot";

export const DERIVE_VERSION = 5;

export const DERIVE_COMPATIBLE = 5;

const MINUTES = [10, 15, 20] as const;

const MINUTE_MS = 60_000;

const FRAME_TOLERANCE_MS = 30_000;

const durationMs = (d: number | undefined) => (d == null ? null : d > 20_000 ? d : d * 1000);

const N = z.number().nullable();

export const PlayerSummary = z.object({
  pid: z.number().int(),
  teamId: z.number().int(),
  championId: z.number().int(),
  championName: z.string().nullable(),
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
  elder_dragons: N.optional(),
  dragon_soul: N.optional(),
  soul: z.string().nullable().optional(),
  heralds: N.optional(),
});

export type TeamSummary = z.infer<typeof TeamSummary>;

export const DragonKill = z.object({
  t: z.number().int(),
  teamId: z.number().int().nullable(),
  kind: z.string().nullable(),
});

export type DragonKill = z.infer<typeof DragonKill>;

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
    dragons: z.array(DragonKill).nullable().optional(),
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

const num = z.number().optional();
const flag = z.boolean().optional();

const V4Stats = z.object({
  kills: num, deaths: num, assists: num,
  firstBloodKill: flag, firstBloodAssist: flag,
  doubleKills: num, tripleKills: num, quadraKills: num, pentaKills: num,
  wardsPlaced: num, wardsKilled: num, visionWardsBoughtInGame: num, totalDamageTaken: num,
  totalDamageDealtToChampions: num, visionScore: num,
  perk0: num, perk1: num, perk2: num, perk3: num, perk4: num, perk5: num,
  perkPrimaryStyle: num, perkSubStyle: num,
  statPerk0: num, statPerk1: num, statPerk2: num,
});

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

function unwrap(json: Json): Json {
  const wrapped = Wrapped.safeParse(json);

  return wrapped.success ? wrapped.data.info : json;
}

const bit = (b: boolean | undefined) => (b == null ? null : b ? 1 : 0);

function hasPlates(version: string | undefined): boolean {
  const [major, minor] = (version ?? "").split(".").map(Number);

  return major > 9 || (major === 9 && minor >= 2);
}

function hasShards(version: string | undefined): boolean {
  const [major, minor] = (version ?? "").split(".").map(Number);

  return major > 8 || (major === 8 && minor >= 23);
}

function hasHeralds(version: string | undefined): boolean {
  const [major, minor] = (version ?? "").split(".").map(Number);

  return major > 5 || (major === 5 && minor >= 22);
}

function hasSouls(version: string | undefined): boolean {
  const [major, minor] = (version ?? "").split(".").map(Number);

  return major > 9 || (major === 9 && minor >= 23);
}

const id = (n: number | undefined) => (n != null && n > 0 ? n : null);

const known = (ids: (number | null)[]): ids is number[] => ids.every((x) => x != null);

type RunePage = { runes: number[] | null; primary: number | null; secondary: number | null };

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
  const shardsAt = /^\d+\.\d+(?:\.|$)/.test(version ?? "") ? hasShards(version) : true;
  const none = { runes: null, primary: null, secondary: null };

  if (page.length !== 6 || !known(page)) return none;

  if (!shardsAt) return { runes: page, primary: id(primary), secondary: id(secondary) };

  return known(statIds) ? { runes: [...page, ...statIds], primary: id(primary), secondary: id(secondary) } : none;
}

export function leaguepediaPatch(version: string | null | undefined): string | null {
  const m = /^(\d+)\.(\d+)\./.exec(version ?? "");

  return m && Number(m[1]) <= 14 ? `${Number(m[1])}.${Number(m[2])}` : null;
}

const SOUL_DRAGONS = 4;

export function summarizeGame(raw: RawGame): IngameOk {
  const stats = Stats.parse(unwrap(raw.stats));
  const timeline = raw.timeline == null ? null : Timeline.safeParse(unwrap(raw.timeline));
  const frames = timeline?.success ? timeline.data.frames : null;
  const events = (frames ?? []).flatMap((f) => f.events).sort((a, b) => a.timestamp - b.timestamp);
  const kills = events.filter((e) => e.type === "CHAMPION_KILL");
  const plates = raw.version >= 5 && hasPlates(stats.gameVersion) && frames ? events.filter((e) => e.type === "TURRET_PLATE_DESTROYED") : null;
  const teamOf = new Map(stats.participants.map((p) => [p.participantId, p.teamId]));
  const names = new Map((stats.participantIdentities ?? []).map((i) => [i.participantId, i.player?.summonerName ?? null]));
  const credited = firstBlood(kills, teamOf, firstBloodFlags(stats), raw.version);

  const endMs = durationMs(stats.gameDuration);
  const lastFrameMs = frames?.length ? frames[frames.length - 1].timestamp : null;

  const reached = (m: number) => lastFrameMs != null && lastFrameMs >= m * MINUTE_MS && (endMs ?? lastFrameMs) >= m * MINUTE_MS;

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
    durationS: stats.gameDuration == null ? null : stats.gameDuration > 20_000 ? Math.round(stats.gameDuration / 1000) : stats.gameDuration,
    players,
    teams,
    dragons,
    gameVersion: stats.gameVersion ?? null,
  };
}
