/**
 * First blood of a game, read from its Riot JSON (match-v4 or match-v5), one
 * definition for the in-game summary (the victim) and the timeline (the event).
 *
 * The credited first blood is the first champion kill, in time order, by an
 * identified participant against an identified opponent. An execution (a
 * death to a tower or minions, `killerId` 0) is not one: Riot then credits the
 * next kill. Riot's end-of-game flags (the player with `firstBloodKill`, the
 * team with first blood) are a consistency check: when they name another
 * player or team, or when a kill before it cannot be read (an unknown victim, a
 * kill between teammates), the first blood is unknown rather than a later
 * plausible kill.
 */

/** The fields of a CHAMPION_KILL event read here. */
export type KillEvent = { timestamp: number; killerId?: number; victimId?: number };

/** Riot's end-of-game first-blood flags: participants with `firstBloodKill`, teams with first blood. */
export type FirstBloodFlags = { killers: readonly number[]; teams: readonly number[] };

export type FirstBlood<E extends KillEvent> = { event: E; killerId: number; victimId: number; killerTeam: number; victimTeam: number };

type FlagSource = {
  participants: readonly { participantId: number; firstBloodKill?: boolean; stats?: { firstBloodKill?: boolean } }[];
  teams: readonly { teamId: number; firstBlood?: boolean; objectives?: { champion?: { first?: boolean } } }[];
};

/** Riot's flags, match-v5 (`firstBloodKill`, `objectives.champion.first`) or match-v4 (`stats.firstBloodKill`, `firstBlood`). */
export function firstBloodFlags(stats: FlagSource): FirstBloodFlags {
  return {
    killers: stats.participants.filter((p) => (p.firstBloodKill ?? p.stats?.firstBloodKill) === true).map((p) => p.participantId),
    teams: stats.teams.filter((t) => (t.objectives?.champion?.first ?? t.firstBlood) === true).map((t) => t.teamId),
  };
}

/**
 * The credited first blood among `kills` (CHAMPION_KILL events, any order), or null when unknown. `teamOf` gives each
 * participant's Riot team.
 */
export function firstBlood<E extends KillEvent>(kills: readonly E[], teamOf: ReadonlyMap<number, number>, flags: FirstBloodFlags): FirstBlood<E> | null {
  const sorted = [...kills].sort((a, b) => a.timestamp - b.timestamp);

  for (const event of sorted) {
    const victimTeam = event.victimId == null ? undefined : teamOf.get(event.victimId);

    if (victimTeam == null) return null;
    const killerTeam = event.killerId == null ? undefined : teamOf.get(event.killerId);

    // An execution: no champion gets the kill, the next one is first blood.
    if (killerTeam == null) continue;

    if (killerTeam === victimTeam) return null;
    const killerId = event.killerId!;

    if (flags.killers.length > 1 || (flags.killers.length === 1 && flags.killers[0] !== killerId)) return null;

    if (flags.teams.length > 1 || (flags.teams.length === 1 && flags.teams[0] !== killerTeam)) return null;

    return { event, killerId, victimId: event.victimId!, killerTeam, victimTeam };
  }

  return null;
}
