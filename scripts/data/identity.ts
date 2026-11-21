export type Resolution = {
  page: string;
  via: "page" | "case" | "redirect" | "ambiguous" | "unknown";
};

type Redirect = { name: string; page: string };

const VERIFIED_SCOREBOARD_PAGES = ["GeekGoneMAD", "Minde"] as const;

const fold = (s: string) => s.toLowerCase();

function index(entries: Iterable<[string, string]>) {
  const map = new Map<string, Set<string>>();

  for (const [key, page] of entries) map.set(key, (map.get(key) ?? new Set()).add(page));

  return map;
}

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
