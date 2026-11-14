import { z } from "zod";

/** Riot Data Dragon: champion names and square icons. */
export const DDRAGON_BASE = "https://ddragon.leagueoflegends.com";

export type DdragonChampion = { id: string; name: string; imageUrl: string };

const Versions = z.array(z.string()).min(1);

const ChampionFile = z.object({
  data: z.record(z.string(), z.object({ id: z.string(), name: z.string(), image: z.object({ full: z.string() }) })),
});

export async function fetchChampions(): Promise<{
  version: string;
  champions: DdragonChampion[];
}> {
  const versions = Versions.parse(await (await fetch(`${DDRAGON_BASE}/api/versions.json`)).json());

  const version = versions[0];

  const data = ChampionFile.parse(
    await (await fetch(`${DDRAGON_BASE}/cdn/${version}/data/en_US/champion.json`)).json(),
  );

  const champions = Object.values(data.data).map((c) => ({
    id: c.id,
    name: c.name,
    imageUrl: `${DDRAGON_BASE}/cdn/${version}/img/champion/${c.image.full}`,
  }));

  return { version, champions };
}

const RuneFile = z.array(
  z.object({ slots: z.array(z.object({ runes: z.array(z.object({ name: z.string(), icon: z.string() })) })) }),
);

let keystones: Promise<Map<string, string>> | null = null;

/**
 * Keystone name → Data Dragon icon URL, read once per instance from `runesReforged.json`.
 * Keystones Riot removed (Kleptomancy, Predator…) are absent; a failed read gives an empty map
 * and is retried on the next call, so the scoreboard falls back to the keystone's name.
 */
export function keystoneIcons(version: string): Promise<Map<string, string>> {
  keystones ??= fetch(`${DDRAGON_BASE}/cdn/${version}/data/en_US/runesReforged.json`, { signal: AbortSignal.timeout(2000) })
    .then(async (res) => {
      if (!res.ok) throw new Error(`runesReforged.json: HTTP ${res.status}`);

      const trees = RuneFile.parse(await res.json());

      return new Map(trees.flatMap((t) => t.slots[0]?.runes ?? []).map((r) => [r.name, `${DDRAGON_BASE}/cdn/img/${r.icon}`]));
    })
    .catch(() => {
      keystones = null;

      return new Map<string, string>();
    });

  return keystones;
}
