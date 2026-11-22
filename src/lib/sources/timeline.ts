import { z } from "zod";
import { type DragonKind, dragonKind } from "../domain/dragons";
import type { Json } from "../json";
import { firstBlood, firstBloodFlags } from "./first-blood";
import type { RawGame } from "./riot";

export const TIMELINE_FORMAT = 3;

export type RiotTeam = 100 | 200;

export const EVENT_KINDS = ["first_blood", "tower", "inhibitor", "dragon", "elder", "herald", "grubs", "baron", "atakhan", "ace"] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

export const LANES = ["top", "mid", "bot"] as const;

export type Lane = (typeof LANES)[number];

export const TOWER_TIERS = ["outer", "inner", "inhibitor", "nexus"] as const;

export type TowerTier = (typeof TOWER_TIERS)[number];

export type EventDetail =
  | { tower: TowerTier | null; lane: Lane | null }
  | { lane: Lane }
  | { dragon: DragonKind }
  | { grubs: number };

export type TimelineEvent = {
  s: number;
  kind: EventKind;
  team: RiotTeam;
  detail: EventDetail | null;
};

export type GoldPoint = { s: number; diff: number };

export type ParsedTimeline = {
  format: typeof TIMELINE_FORMAT;
  key: string;
  version: number;
  durationS: number | null;
  winner: RiotTeam | null;
  gold: GoldPoint[];
  events: TimelineEvent[];
};

const num = z.number().optional();

const flag = z.boolean().optional();

const Participant = z.object({ participantId: z.number(), teamId: z.number(), firstBloodKill: flag, stats: z.object({ firstBloodKill: flag }).optional() });

const Team = z.object({
  teamId: z.number(),
  win: z.union([z.boolean(), z.string()]).optional(),
  firstBlood: flag,
  objectives: z.object({ champion: z.object({ first: flag }).optional() }).optional(),
});

const Stats = z.object({ gameDuration: num, participants: z.array(Participant), teams: z.array(Team) });

const Event = z.object({
  type: z.string(),
  timestamp: z.number(),
  killerId: num,
  killerTeamId: num,
  victimId: num,
  teamId: num,
  monsterType: z.string().optional(),
  monsterSubType: z.string().optional(),
  buildingType: z.string().optional(),
  laneType: z.string().optional(),
  towerType: z.string().optional(),
});

type RiotEvent = z.infer<typeof Event>;

const ParticipantFrame = z.object({ participantId: num, totalGold: num, level: num });

const Frame = z.object({
  timestamp: z.number(),
  participantFrames: z.record(z.string(), ParticipantFrame),
  events: z.array(z.unknown()).catch([]).transform((list) => list.flatMap((e) => {
    const parsed = Event.safeParse(e);

    return parsed.success ? [parsed.data] : [];
  })),
});

const Timeline = z.object({ frames: z.array(Frame).min(1) });

const Wrapped = z.object({ info: z.record(z.string(), z.json()) });

function unwrap(json: Json): Json {
  const wrapped = Wrapped.safeParse(json);

  return wrapped.success ? wrapped.data.info : json;
}

const asTeam = (n: number | undefined): RiotTeam | null => (n === 100 || n === 200 ? n : null);
const other = (t: RiotTeam): RiotTeam => (t === 100 ? 200 : 100);

function dragonDetail(subType: string | undefined): EventDetail | null {
  const dragon = dragonKind(subType);

  return dragon ? { dragon } : null;
}

const RIOT_LANES = new Map<string, Lane>([
  ["TOP_LANE", "top"],
  ["MID_LANE", "mid"],
  ["BOT_LANE", "bot"],
]);

const RIOT_TOWERS = new Map<string, TowerTier>([
  ["OUTER_TURRET", "outer"],
  ["INNER_TURRET", "inner"],
  ["BASE_TURRET", "inhibitor"],
  ["NEXUS_TURRET", "nexus"],
]);

const laneOf = (e: RiotEvent) => (e.laneType ? (RIOT_LANES.get(e.laneType) ?? null) : null);

function towerDetail(e: RiotEvent): EventDetail | null {
  const tower = e.towerType ? (RIOT_TOWERS.get(e.towerType) ?? null) : null;

  if (tower === "nexus") return { tower, lane: null };

  const lane = laneOf(e);

  return tower || lane ? { tower, lane } : null;
}

function inhibitorDetail(e: RiotEvent): EventDetail | null {
  const lane = laneOf(e);

  return lane ? { lane } : null;
}

const BASE_RESPAWN_S = [10, 10, 12, 12, 14, 16, 20, 25, 28, 32.5, 35, 37.5, 40, 42.5, 45, 47.5, 50, 52.5];

const GRUBS_WINDOW_MS = 90_000;

const durationSeconds = (d: number | undefined) => (d == null ? null : d > 20_000 ? Math.round(d / 1000) : Math.round(d));

const winnerOf = (teams: z.infer<typeof Team>[]): RiotTeam | null =>
  asTeam(teams.find((t) => t.win === true || t.win === "Win")?.teamId);

export function parseTimeline(raw: RawGame): ParsedTimeline | null {
  if (raw.timeline == null) return null;

  const stats = Stats.parse(unwrap(raw.stats));
  const { frames } = Timeline.parse(unwrap(raw.timeline));

  const teamOf = new Map(stats.participants.flatMap((p) => {
    const t = asTeam(p.teamId);

    return t ? [[p.participantId, t] as const] : [];
  }));

  const gold = frames.map((f) => {
    let diff = 0;

    for (const [id, pf] of Object.entries(f.participantFrames)) {
      const team = teamOf.get(pf.participantId ?? Number(id));

      if (team) diff += (team === 100 ? 1 : -1) * (pf.totalGold ?? 0);
    }

    return { s: Math.round(f.timestamp / 1000), diff };
  });

  const levelAt = (pid: number, ms: number) => {
    const frame = frames[Math.min(frames.length - 1, Math.floor(ms / 60_000))];
    const pf = frame?.participantFrames[String(pid)];

    return pf?.level ?? 1;
  };

  const all = frames.flatMap((f) => f.events).sort((a, b) => a.timestamp - b.timestamp);
  const events: TimelineEvent[] = [];
  const at = (e: RiotEvent) => Math.round(e.timestamp / 1000);

  const push = (e: RiotEvent, kind: EventKind, team: RiotTeam | null, detail: EventDetail | null = null) => {
    if (team) events.push({ s: at(e), kind, team, detail });
  };

  const monsterTeam = (e: RiotEvent) => asTeam(e.killerTeamId) ?? (e.killerId ? (teamOf.get(e.killerId) ?? null) : null);

  const deadUntil = new Map<number, number>();
  const aced = new Set<RiotTeam>();
  const first = firstBlood(all.filter((e) => e.type === "CHAMPION_KILL"), teamOf, firstBloodFlags(stats), raw.version);
  let lastGrubs: { team: RiotTeam; ms: number; count: number; event: TimelineEvent } | null = null;

  for (const e of all) {
    switch (e.type) {
      case "CHAMPION_KILL": {
        const victim = e.victimId ?? 0;
        const victimTeam = teamOf.get(victim);

        if (e === first?.event) push(e, "first_blood", asTeam(first.killerTeam));

        if (!victimTeam) break;

        const level = Math.min(18, Math.max(1, levelAt(victim, e.timestamp)));
        deadUntil.set(victim, e.timestamp + BASE_RESPAWN_S[level - 1] * 1000);
        const mates = [...teamOf].flatMap(([pid, t]) => (t === victimTeam ? [pid] : []));
        const allDead = mates.length === 5 && mates.every((pid) => (deadUntil.get(pid) ?? 0) > e.timestamp);

        if (allDead && !aced.has(victimTeam)) {
          aced.add(victimTeam);
          push(e, "ace", other(victimTeam));
        } else if (!allDead) aced.delete(victimTeam);
        break;
      }

      case "BUILDING_KILL": {
        const loser = asTeam(e.teamId);

        if (!loser) break;

        if (e.buildingType === "TOWER_BUILDING") push(e, "tower", other(loser), towerDetail(e));
        else if (e.buildingType === "INHIBITOR_BUILDING") push(e, "inhibitor", other(loser), inhibitorDetail(e));
        break;
      }

      case "ELITE_MONSTER_KILL": {
        const team = monsterTeam(e);

        if (!team) break;

        if (e.monsterType === "DRAGON") {
          if (e.monsterSubType === "ELDER_DRAGON") push(e, "elder", team);
          else push(e, "dragon", team, dragonDetail(e.monsterSubType));
        } else if (e.monsterType === "BARON_NASHOR") push(e, "baron", team);
        else if (e.monsterType === "RIFTHERALD") push(e, "herald", team);
        else if (e.monsterType === "ATAKHAN") push(e, "atakhan", team);
        else if (e.monsterType === "HORDE") {
          if (lastGrubs && lastGrubs.team === team && e.timestamp - lastGrubs.ms <= GRUBS_WINDOW_MS) {
            lastGrubs.count++;
            lastGrubs.ms = e.timestamp;
            lastGrubs.event.detail = { grubs: lastGrubs.count };
          } else {
            const event: TimelineEvent = { s: at(e), kind: "grubs", team, detail: { grubs: 1 } };

            events.push(event);
            lastGrubs = { team, ms: e.timestamp, count: 1, event };
          }
        }

        break;
      }
    }
  }

  const last = frames[frames.length - 1];

  return {
    format: TIMELINE_FORMAT,
    key: raw.key,
    version: raw.version,
    durationS: durationSeconds(stats.gameDuration) ?? Math.round(last.timestamp / 1000),
    winner: winnerOf(stats.teams),
    gold,
    events,
  };
}

export const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
