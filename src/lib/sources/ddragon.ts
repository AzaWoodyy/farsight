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
