import { describe, expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { claimsBeyondFacts } from "../src/lib/agent/summary";
import { LEAGUES, detectLeague, eraLeague, leagueMembers } from "../src/lib/domain/leagues";
import { periodProblem } from "../src/lib/domain/years";
import { createSchema, createQuerySchema } from "../src/lib/db/schema";
import { readSchema } from "../src/lib/db";
import { bindTool } from "../src/lib/agent/tools";
import { routeQuestion } from "../src/lib/agent/query";
import type { Entities } from "../src/lib/agent/types";

describe("summary facts", () => {
  const facts = "T1 : first blood 55.3 % et première tourelle 61.2 %, sur 120 parties dont 80 victoires.";
  test.each([
    [facts, false],
    [facts.replace("55.3", "55,3").replace("61.2", "61,2"), false],
    ["T1 : first blood 61.2 % et première tourelle 55.3 %.", true],
    ["T1 a gagné 120 parties sur 80.", true],
    ["Gen.G : first blood 55.3 %.", true],
    ["T1 gagne plus de deux parties sur trois.", true],
    ["T1 est la meilleure équipe de LCK au first blood.", true],
    ["T1 prend le 1er dragon.", true],
    ["T1 : première tourelle 55.3 %.", true],
  ])("%s", (text, rejected) => expect(claimsBeyondFacts(text, facts).length > 0).toBe(rejected));
});

test("league cues choose the longest match and preserve all scope names", () => {
  expect(new Set(LEAGUES.map((l) => l.name)).size).toBe(LEAGUES.length);
  expect(detectLeague("LCK CL 2024").league).toBe("LCK Challengers League");
  expect(detectLeague("LTA North").league).toBe("League of Legends Championship of The Americas North");
  expect(detectLeague("EU LCS 2016").league).toBe("Europe League Championship Series");
});

test("periods spanning renamings read both leagues in parameterized tool SQL", async () => {
  const db = new DatabaseSync(":memory:");

  try {
    createSchema(db); createQuerySchema(db);
    db.exec(`INSERT INTO teams VALUES(1,'T1'),(2,'Gen.G');`);
    LEAGUES.forEach((l, i) => db.prepare("INSERT INTO leagues VALUES(?,?,?,?,?)").run(i+1,l.name,l.short,l.region,+l.international));
    const names = ["North America League Championship Series", "League of Legends Championship Series"];
    names.forEach((name, i) => {
      const id = Number(db.prepare("SELECT id FROM leagues WHERE name=?").get(name)!.id);
      db.prepare("INSERT INTO tournaments(id,page,event_page,stage,league_id,year) VALUES(?,?,?,'season',?,?)").run(i+1,`event${i}`,`event${i}`,id,2016+i*4);
      db.prepare("INSERT INTO games(id,tournament_id,blue_team_id,red_team_id,winner_side) VALUES(?,?,1,2,1)").run(i+1,i+1);
    });
    const league = "League of Legends Championship Series";
    expect(leagueMembers(league,2015,null)).toEqual(names);
    expect(eraLeague(league,2016,2016)).toBe("North America League Championship Series");
    const plan = bindTool(db, {tool:"team_history", input:{team:"T1", league, yearFrom:2015,yearTo:null}});
    expect(db.prepare(plan.sql).all(plan.params).map((r) => r.year)).toEqual([2016,2020]);
    const standings = bindTool(db, {tool:"tournament_standings", input:{league,yearFrom:2015,yearTo:null,split:null,full:false}});

    const out = await standings.format(db, [
      {year:2016,event_page:"event0",tournament_page:"event0",tournament:"2016",stage:"playoffs",team:"T1",place:"1",place_number:1,prize_usd:null},
      {year:2020,event_page:"event1",tournament_page:"event1",tournament:"2020",stage:"playoffs",team:"T1",place:"1",place_number:1,prize_usd:null},
    ]);

    expect(out.title).toBe("Palmarès — LCS 2016–2020");
    expect(leagueMembers("LoL EMEA Championship",2016,2020)).toHaveLength(2);
    expect(leagueMembers("LoL Champions Korea",2014,2020)).toHaveLength(2);
    expect(leagueMembers(league,null,null)).toEqual([league]);
  } finally { db.close(); }
});

test("router prioritizes timeline, missing coverage, unsupported data and tools", () => {
  const db = new DatabaseSync(":memory:");

  try {
    createSchema(db); createQuerySchema(db);
    const schema = readSchema(db);
    const base: Entities = { players:[],teams:[],champion:null,unresolved:[],league:"World Championship",leagueShort:"Worlds",leagueMention:"Worlds",yearFrom:2024,yearTo:2024,split:null,outOfScope:null };
    const coverage = {league:()=>({games:100,ingame:0}),player:()=>({games:100,ingame:0})};

    for (const [q, entities, kind] of [
      ["palmarès Worlds 2024", base, "tool"],
      ["first blood en LPL", {...base,league:"Tencent LoL Pro League"}, "missing"],
      ["MVP des Worlds 2024",base,"missing"],
      ["résultats LJL",{...base,outOfScope:"LJL"},"out_of_scope"],
      ["timeline finale Worlds 2024 game 3",base,"tool"],
    ] as const) expect(routeQuestion(q,entities,schema,coverage).kind).toBe(kind);
  } finally { db.close(); }
});

test("years outside coverage receive a specific reason", () => {
  const now = new Date("2026-11-14");
  expect(periodProblem(2010,2010,now)).toContain("commence en 2011");
  expect(periodProblem(2031,2031,now)).toContain("future");
  expect(periodProblem(2031,2031,new Date("2031-06-01"))).toBeNull();
});
