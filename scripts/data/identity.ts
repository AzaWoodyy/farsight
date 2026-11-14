/**
 * Player identity: the Leaguepedia player page a scoreboard link stands for.
 *
 * `ScoreboardPlayers.Link` is what the scoreboard says, not always the page:
 * the case drifts ("caPs", "RooKie") and an older handle stays on old games
 * ("ZionSpartan" for Darshan). Without this step each spelling is its own
 * player and a career is split between them.
 */

export type Resolution = {
  /** The player page, or the link itself when nothing (or more than one page) matches. */
  page: string;
  /**
   * How the page was found: the link is a page, a page at another case, a
   * `PlayerRedirects.AllName`, several pages (not merged), or nothing.
   */
  via: "page" | "case" | "redirect" | "ambiguous" | "unknown";
};

type Redirect = { name: string; page: string };

const fold = (s: string) => s.toLowerCase();

function index(entries: Iterable<[string, string]>) {
  const map = new Map<string, Set<string>>();

  for (const [key, page] of entries) map.set(key, (map.get(key) ?? new Set()).add(page));

  return map;
}

/**
 * Builds `canonical(link)` from the player pages and their redirects. In
 * order: the exact page, a page at another case, a redirect name, a redirect
 * name at another case. The first step that points to several pages stops
 * the search: two players who share a handle stay apart.
 */
export function playerIdentity(pages: Iterable<string>, redirects: Iterable<Redirect>): (link: string) => Resolution {
  const rows = [...redirects];
  const known = new Set([...pages, ...rows.map((r) => r.page)]);
  const pageByCase = index([...known].map((p) => [fold(p), p]));
  const byName = index(rows.map((r) => [r.name, r.page]));
  const byNameCase = index(rows.map((r) => [fold(r.name), r.page]));

  return (link) => {
    if (known.has(link)) return { page: link, via: "page" };

    const steps = [
      { via: "case", found: pageByCase.get(fold(link)) },
      { via: "redirect", found: byName.get(link) },
      { via: "redirect", found: byNameCase.get(fold(link)) },
    ] as const;

    for (const { via, found } of steps) {
      if (found?.size === 1) return { page: [...found][0], via };

      if (found) return { page: link, via: "ambiguous" };
    }

    return { page: link, via: "unknown" };
  };
}
