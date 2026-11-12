/** Riot Data Dragon: champion names and square icons. */
export const DDRAGON_BASE = "https://ddragon.leagueoflegends.com";

export type DdragonChampion = { id: string; name: string; imageUrl: string };

export async function fetchChampions(): Promise<{
  version: string;
  champions: DdragonChampion[];
}> {
  const versions = (await (
    await fetch(`${DDRAGON_BASE}/api/versions.json`)
  ).json()) as string[];
  const version = versions[0];
  const data = (await (
    await fetch(`${DDRAGON_BASE}/cdn/${version}/data/en_US/champion.json`)
  ).json()) as {
    data: Record<string, { id: string; name: string; image: { full: string } }>;
  };
  const champions = Object.values(data.data).map((c) => ({
    id: c.id,
    name: c.name,
    imageUrl: `${DDRAGON_BASE}/cdn/${version}/img/champion/${c.image.full}`,
  }));
  return { version, champions };
}
