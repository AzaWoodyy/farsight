export type KillEvent = { timestamp: number; killerId?: number; victimId?: number };

export type FirstBloodFlags = { killers: readonly number[]; teams: readonly number[]; notKillers: readonly number[]; notTeams: readonly number[] };

export type FirstBlood<E extends KillEvent> = { event: E; killerId: number | null; victimId: number; killerTeam: number; victimTeam: number };

type FlagSource = {
  participants: readonly { participantId: number; firstBloodKill?: boolean; stats?: { firstBloodKill?: boolean } }[];
  teams: readonly { teamId: number; firstBlood?: boolean; objectives?: { champion?: { first?: boolean } } }[];
};

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

export function firstBlood<E extends KillEvent>(kills: readonly E[], teamOf: ReadonlyMap<number, number>, flags: FirstBloodFlags, version: number): FirstBlood<E> | null {
  const sorted = [...kills].sort((a, b) => a.timestamp - b.timestamp);

  for (const [i, event] of sorted.entries()) {
    const victimTeam = event.victimId == null ? undefined : teamOf.get(event.victimId);

    if (victimTeam == null || event.killerId == null) return null;
    const killerTeam = teamOf.get(event.killerId);

    if (killerTeam == null) {
      const team = flags.teams.length === 1 ? flags.teams[0] : null;

      if (version >= 5 && event.killerId === 0 && i === 0 && flags.killers.length === 0 && flags.notKillers.length > 0 && team != null && team !== victimTeam && [...teamOf.values()].includes(team))
        return { event, killerId: null, victimId: event.victimId!, killerTeam: team, victimTeam };

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
