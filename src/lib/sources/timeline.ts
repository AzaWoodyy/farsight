/**
 * Minute-by-minute story of one game, parsed from its Riot JSON (match-v4 or
 * match-v5 shape, see ./riot): the gold difference at every timeline frame
 * and the key events, each with its time and the Riot team that got it.
 *
 * Definitions:
 * - gold difference: total gold of team 100 minus team 200 at each frame (one
 *   frame per minute, plus the last one at the end of the game);
 * - first blood: the credited first blood (./first-blood), the killer's team;
 *   an execution by a tower or minions is not one. None when it is unknown;
 * - towers and inhibitors: BUILDING_KILL names the team that lost the
 *   building, the other team gets it (whoever last hit it, minions included);
 * - dragons, elder, herald, baron, Atakhan: the killer's team (v5 gives it,
 *   v4 through the killer's participant); a kill with no champion killer is
 *   left out. Void grubs taken within 90 s by the same team make one event;
 * - ace: all five players of a team dead at once. Riot's esports timelines
 *   carry no ace event, so each death lasts the base respawn time of the
 *   victim's level (BRW table, without the extra time after 15 min): an
 *   underestimate, so an ace is never reported where the five deaths did
 *   not overlap.
 */
import { z } from "zod";
import { DRAGON_LABELS, dragonKind } from "../domain/dragons";
import type { Json } from "../json";
import { firstBlood, firstBloodFlags } from "./first-blood";
import type { RawGame } from "./riot";

/** Bump when the parsed shape or a definition changes: cached timelines of an older format are ignored. */
export const TIMELINE_FORMAT = 2;

export type RiotTeam = 100 | 200;

export const EVENT_KINDS = ["first_blood", "tower", "inhibitor", "dragon", "elder", "herald", "grubs", "baron", "atakhan", "ace"] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

export type TimelineEvent = {
  /** Seconds since the start of the game. */
  s: number;
  kind: EventKind;
  team: RiotTeam;
  /** French detail: dragon element, tower lane and tier, number of grubs. */
  detail: string | null;
};

export type GoldPoint = { s: number; diff: number };

export type ParsedTimeline = {
  format: typeof TIMELINE_FORMAT;
  key: string;
  /** Riot API version of the JSON (4 or 5). */
  version: number;
  durationS: number | null;
  winner: RiotTeam | null;
  /** Team 100 minus team 200, one point per frame. */
  gold: GoldPoint[];
  events: TimelineEvent[];
};

// --- Riot JSON, only the fields read here (v4 and v5) ---------------------------

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
  // One malformed event must not cost the whole timeline.
  events: z.array(z.unknown()).catch([]).transform((list) => list.flatMap((e) => {
    const parsed = Event.safeParse(e);

    return parsed.success ? [parsed.data] : [];
  })),
});

const Timeline = z.object({ frames: z.array(Frame).min(1) });

const Wrapped = z.object({ info: z.record(z.string(), z.json()) });

/** match-v5 JSON may come wrapped as { metadata, info }. */
function unwrap(json: Json): Json {
  const wrapped = Wrapped.safeParse(json);

  return wrapped.success ? wrapped.data.info : json;
}

const asTeam = (n: number | undefined): RiotTeam | null => (n === 100 || n === 200 ? n : null);
const other = (t: RiotTeam): RiotTeam => (t === 100 ? 200 : 100);

// --- Labels --------------------------------------------------------------------------

/** French element of a dragon, null before the elements. */
function dragonElement(subType: string | undefined): string | null {
  const kind = dragonKind(subType);

  return kind ? DRAGON_LABELS[kind] : null;
}

const LANES = new Map([
  ["TOP_LANE", "top"],
  ["MID_LANE", "mid"],
  ["BOT_LANE", "bot"],
]);

const TOWERS = new Map([
  ["OUTER_TURRET", "extérieure"],
  ["INNER_TURRET", "intérieure"],
  ["BASE_TURRET", "d'inhibiteur"],
]);

const label = (map: Map<string, string>, key: string | undefined) => (key ? (map.get(key) ?? null) : null);

function towerDetail(e: RiotEvent): string | null {
  if (e.towerType === "NEXUS_TURRET") return "du Nexus";

  return [label(TOWERS, e.towerType), label(LANES, e.laneType)].filter(Boolean).join(" ") || null;
}

/** Base respawn time (s) by champion level, without the extra time after 15 min. */
const BASE_RESPAWN_S = [10, 10, 12, 12, 14, 16, 20, 25, 28, 32.5, 35, 37.5, 40, 42.5, 45, 47.5, 50, 52.5];

/** Void grubs of the same team taken within this window are one event. */
const GRUBS_WINDOW_MS = 90_000;

// --- Parsing --------------------------------------------------------------------------

/** match-v4 and early v5 report milliseconds in gameDuration for some games. */
const durationSeconds = (d: number | undefined) => (d == null ? null : d > 20_000 ? Math.round(d / 1000) : Math.round(d));

const winnerOf = (teams: z.infer<typeof Team>[]): RiotTeam | null =>
  asTeam(teams.find((t) => t.win === true || t.win === "Win")?.teamId);

/** The game's timeline, or null when it has none. Throws when the JSON does not have the expected shape. */
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

  const push = (e: RiotEvent, kind: EventKind, team: RiotTeam | null, detail: string | null = null) => {
    if (team) events.push({ s: at(e), kind, team, detail });
  };

  /** Team credited with a monster: v5 names it, v4 through the killer. */
  const monsterTeam = (e: RiotEvent) => asTeam(e.killerTeamId) ?? (e.killerId ? (teamOf.get(e.killerId) ?? null) : null);

  // Respawn time of each dead participant, for aces.
  const deadUntil = new Map<number, number>();
  const aced = new Set<RiotTeam>();
  const first = firstBlood(all.filter((e) => e.type === "CHAMPION_KILL"), teamOf, firstBloodFlags(stats), raw.version);
  let lastGrubs: { team: RiotTeam; ms: number; event: TimelineEvent } | null = null;

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
        else if (e.buildingType === "INHIBITOR_BUILDING") push(e, "inhibitor", other(loser), label(LANES, e.laneType));
        break;
      }

      case "ELITE_MONSTER_KILL": {
        const team = monsterTeam(e);

        if (!team) break;

        if (e.monsterType === "DRAGON") {
          if (e.monsterSubType === "ELDER_DRAGON") push(e, "elder", team);
          else push(e, "dragon", team, dragonElement(e.monsterSubType));
        } else if (e.monsterType === "BARON_NASHOR") push(e, "baron", team);
        else if (e.monsterType === "RIFTHERALD") push(e, "herald", team);
        else if (e.monsterType === "ATAKHAN") push(e, "atakhan", team);
        else if (e.monsterType === "HORDE") {
          if (lastGrubs && lastGrubs.team === team && e.timestamp - lastGrubs.ms <= GRUBS_WINDOW_MS) {
            const n = Number(lastGrubs.event.detail?.split(" ")[0] ?? 1) + 1;
            lastGrubs.event.detail = `${n} larves`;
            lastGrubs.ms = e.timestamp;
          } else {
            const event: TimelineEvent = { s: at(e), kind: "grubs", team, detail: "1 larve" };

            events.push(event);
            lastGrubs = { team, ms: e.timestamp, event };
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

/** "12:34" */
export const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
