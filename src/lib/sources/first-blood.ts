/**
 * First blood of a game, read from its Riot JSON (match-v4 or match-v5), one
 * definition for the in-game summary (the victim) and the timeline (the event).
 *
 * The credited first blood is the first champion kill, in time order, by an
 * identified participant against an identified opponent. An execution (a
 * death to a tower or minions, `killerId` 0) is not one: match-v4 then credits
 * the next kill. match-v5 may instead credit the execution itself to the
 * team: no player has `firstBloodKill` and the team flag goes to the opponent
 * of the executed player; the first blood is then that execution, with no
 * killer. Riot's end-of-game flags (the player with `firstBloodKill`, the
 * team with first blood) are a consistency check: when they name another
 * player or team, or when a kill before it cannot be read (an unknown victim, a
 * kill between teammates), the first blood is unknown rather than a later
 * plausible kill.
 */

/** The fields of a CHAMPION_KILL event read here. */
export type KillEvent = { timestamp: number; killerId?: number; victimId?: number };

/**
 * Riot's end-of-game first-blood flags: participants and teams flagged true, and those explicitly flagged false (an
 * absent flag says nothing).
 */
export type FirstBloodFlags = { killers: readonly number[]; teams: readonly number[]; notKillers: readonly number[]; notTeams: readonly number[] };

/** `killerId` is null for an execution Riot credits to the team. */
export type FirstBlood<E extends KillEvent> = { event: E; killerId: number | null; victimId: number; killerTeam: number; victimTeam: number };

type FlagSource = {
  participants: readonly { participantId: number; firstBloodKill?: boolean; stats?: { firstBloodKill?: boolean } }[];
  teams: readonly { teamId: number; firstBlood?: boolean; objectives?: { champion?: { first?: boolean } } }[];
};

/** Riot's flags, match-v5 (`firstBloodKill`, `objectives.champion.first`) or match-v4 (`stats.firstBloodKill`, `firstBlood`). */
export function firstBloodFlags(stats: FlagSource): FirstBloodFlags {
  const killer = (p: FlagSource["participants"][number]) => p.firstBloodKill ?? p.stats?.firstBloodKill;
  const team = (t: FlagSource["teams"][number]) => t.objectives?.champion?.first ?? t.firstBlood;

  return {
    killers: stats.participants.filter((p) => killer(p) === true).map((p) => p.participantId),
    teams: stats.teams.filter((t) => team(t) === true).map((t) => t.teamId),
    notKillers: stats.participants.filter((p) => killer(p) === false).map((p) => p.participantId),
    notTeams: stats.teams.filter((t) => team(t) === false).map((t) => t.teamId),
  };
}

/**
 * The credited first blood among `kills` (CHAMPION_KILL events, any order), or null when unknown. `teamOf` gives each
 * participant's Riot team; `version` is the Riot API version of the JSON (4 or 5).
 */
export function firstBlood<E extends KillEvent>(kills: readonly E[], teamOf: ReadonlyMap<number, number>, flags: FirstBloodFlags, version: number): FirstBlood<E> | null {
  const sorted = [...kills].sort((a, b) => a.timestamp - b.timestamp);

  for (const [i, event] of sorted.entries()) {
    const victimTeam = event.victimId == null ? undefined : teamOf.get(event.victimId);

    // Without a killer id the kill cannot be read; 0 (or any id that is no participant) is an execution.
    if (victimTeam == null || event.killerId == null) return null;
    const killerTeam = teamOf.get(event.killerId);

    if (killerTeam == null) {
      // match-v5: the first death, an execution, credited to the other team with no player.
      const team = flags.teams.length === 1 ? flags.teams[0] : null;

      if (version >= 5 && event.killerId === 0 && i === 0 && flags.killers.length === 0 && flags.notKillers.length > 0 && team != null && team !== victimTeam && [...teamOf.values()].includes(team))
        return { event, killerId: null, victimId: event.victimId!, killerTeam: team, victimTeam };

      // Otherwise no champion gets the kill, the next one is first blood.
      continue;
    }

    if (killerTeam === victimTeam) return null;
    const { killerId } = event;

    if (flags.killers.length > 1 || (flags.killers.length === 1 && flags.killers[0] !== killerId)) return null;

    if (flags.teams.length > 1 || (flags.teams.length === 1 && flags.teams[0] !== killerTeam)) return null;

    if (flags.notKillers.includes(killerId) || flags.notTeams.includes(killerTeam)) return null;

    return { event, killerId, victimId: event.victimId!, killerTeam, victimTeam };
  }

  return null;
}
