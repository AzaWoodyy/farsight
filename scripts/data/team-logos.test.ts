import { describe, expect, test } from "bun:test";
import { wikiImageUrl } from "../../src/lib/domain/wiki-images";
import { FILES_PER_REQUEST, parseWikiFiles } from "../../src/lib/sources/leaguepedia";
import { chooseLogo, fetchTeamLogoFiles, fileTitle, logoCandidates, logoCandidatesOf, teamPageOf } from "./team-logos";

const teams = [{ Page: "DN SOOPers" }, { Page: "Nova Esports (Thai Team)" }, { Page: "Nova Esports (Taiwanese Team)" }, { Page: "Shadow" }, { Page: "SHADOW" }];

const redirects = [
  { AllName: "Afreeca Freecs", Page: "DN SOOPers" },
  { AllName: "Nova Esports", Page: "Nova Esports (Thai Team)" },
  { AllName: "Nova Esports", Page: "Nova Esports (Taiwanese Team)" },
];

describe("the logo files a team name may have", () => {
  test("its own square logo, then its page's, as the wiki writes titles", () => {
    expect(fileTitle("dN_SOOPers logo square.png")).toBe("DN SOOPers logo square.png");
    expect(logoCandidates("Afreeca Freecs", "DN SOOPers")).toEqual(["Afreeca Freecslogo square.png", "DN SOOPerslogo square.png"]);
    expect(logoCandidates("DN SOOPers", "DN SOOPers")).toEqual(["DN SOOPerslogo square.png"]);
  });

  test("the page of a name: its own, the one at another case, the one it redirects to", () => {
    const pageOf = teamPageOf(teams, redirects);

    expect(pageOf("DN SOOPers")).toBe("DN SOOPers");
    expect(pageOf("dn soopers")).toBe("DN SOOPers");
    expect(pageOf("afreeca freecs")).toBe("DN SOOPers");
    expect(pageOf("Unknown")).toBeNull();
  });

  test("a name that leads to two pages has none", () => {
    const pageOf = teamPageOf(teams, redirects);

    expect(pageOf("Nova Esports")).toBeNull();
    expect(pageOf("shadow")).toBeNull();
    expect(pageOf("Shadow")).toBe("Shadow");
    expect(logoCandidatesOf(teams, redirects)("Nova Esports")).toEqual(["Nova Esportslogo square.png"]);
  });

  test("the first file the wiki has, under its exact name", () => {
    const files = new Map([["DN SOOPerslogo square.png", "DN SOOPerslogo square.png"]]);

    expect(chooseLogo(["Afreeca Freecslogo square.png", "DN SOOPerslogo square.png"], files)).toBe("DN SOOPerslogo square.png");
    expect(chooseLogo(["Afreeca Freecslogo square.png"], files)).toBeNull();
  });
});

describe("asking the wiki", () => {
  // Real answers of the MediaWiki API (2026-11-21), cut down: a name the API normalizes, a file that redirects to another
  // one (an older name's logo), a missing file.
  const answer = {
    query: {
      normalized: [{ from: "File:t1logo_square.png", to: "File:T1logo square.png" }],
      redirects: [{ from: "File:1TAP Dinologo square.png", to: "File:Saigon Dinologo square.png" }],
      pages: [
        { title: "File:Nobodylogo square.png" },
        { title: "File:T1logo square.png", imageinfo: [{ width: 5000 }] },
        { title: "File:Saigon Dinologo square.png", imageinfo: [{ width: 1697 }] },
      ],
    },
  };

  test("each name asked gets the exact name the wiki stores it under, or null", () => {
    const files = parseWikiFiles(["t1logo_square.png", "1TAP Dinologo square.png", "Nobodylogo square.png", "Unanswered.png"], answer);

    expect([...files]).toEqual([
      ["t1logo_square.png", "T1logo square.png"],
      ["1TAP Dinologo square.png", "Saigon Dinologo square.png"],
      ["Nobodylogo square.png", null],
    ]);
  });

  test("the CDN path is built from the exact name, as the wiki's own image URL", () => {
    // `imageinfo.url` of File:T1logo square.png, asked as "t1logo_square.png", on the same day.
    expect(wikiImageUrl("T1logo square.png", 64)).toStartWith("https://static.wikia.nocookie.net/lolesports_gamepedia_en/images/a/a2/T1logo_square.png/");
  });

  test("every candidate of every name, as written and as stored, by batches; the files found only", async () => {
    const rows = [{ Team1: "dn soopers", Team2: "Afreeca Freecs" }, ...Array.from({ length: 60 }, (_, i) => ({ Team: `Team ${i}` }))];
    const asked: string[][] = [];

    const found = await fetchTeamLogoFiles(rows, { teams, redirects }, async (names) => {
      asked.push(names);

      return new Map(names.map((n) => [n, n.startsWith("DN SOOPers") || n === "Team 7logo square.png" ? n : null]));
    });

    expect(asked.map((b) => b.length)).toEqual([FILES_PER_REQUEST, 63 - FILES_PER_REQUEST]);
    expect(found).toEqual([
      { Asked: "DN SOOPerslogo square.png", File: "DN SOOPerslogo square.png" },
      { Asked: "Team 7logo square.png", File: "Team 7logo square.png" },
    ]);
  });

  test("a name left unanswered is asked once more", async () => {
    let calls = 0;

    const found = await fetchTeamLogoFiles([{ Team: "Solo" }], { teams: [], redirects: [] }, async (names) => {
      calls++;

      return new Map(calls === 1 ? [] : names.map((n) => [n, n]));
    });

    expect(calls).toBe(2);
    expect(found).toEqual([{ Asked: "Solologo square.png", File: "Solologo square.png" }]);
  });
});
