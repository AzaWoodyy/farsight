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

// These scoreboard-only handles have no Players/PlayerRedirects row. The
// matching historical rosters were checked before merging the two spellings:
// https://lol.fandom.com/wiki/Team_Tempest (William Lyall, including the
// GeekGoneMad roster of NA LCS 2014 Spring Prequalifier 1) and
// https://lol.fandom.com/wiki/NA_LCS/2014_Season/Spring_Promotion/Qualifiers/WellPlayed_2/Team_Rosters
// https://lol.fandom.com/wiki/EU_LCS/2014_Season/Spring_Promotion/Qualifiers/WellPlayed_2
// (Minde, the single bleiz eSPORTS support across all four scoreboards).
const VERIFIED_SCOREBOARD_PAGES = ["GeekGoneMAD", "Minde"] as const;

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
  const known = new Set([...pages, ...rows.map((r) => r.page), ...VERIFIED_SCOREBOARD_PAGES]);
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

/**
 * Team identity: one spelling per team whatever the case Leaguepedia wrote it in ("Dplus KIA" on a game,
 * "Dplus Kia" on its player lines). The page of `Teams` wins; without a page, the first spelling seen. Two pages
 * that differ only in case stay apart, and so do the names at their case.
 *
 * A wiki title always starts with a capital, so a name that differs from its page by the first letter alone
 * ("paiN Gaming" for the page "PaiN Gaming") is that page as the wiki displays it: the name is kept.
 */
export function teamIdentity(pages: Iterable<string>): (name: string) => string {
  const pageByCase = index([...pages].flatMap((p): [string, string][] => {
    const page = p.trim();

    return page ? [[fold(page), page]] : [];
  }));

  const chosen = new Map<string, string>();

  return (raw) => {
    const name = raw.trim();
    const key = fold(name);
    const found = pageByCase.get(key);

    if (found && found.size > 1) return name;

    const known = chosen.get(key);

    if (known != null) return known;

    const page = found && [...found][0];
    const spelling = page != null && page.slice(1) !== name.slice(1) ? page : name;
    chosen.set(key, spelling);

    return spelling;
  };
}
