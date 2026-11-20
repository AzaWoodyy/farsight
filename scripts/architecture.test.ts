import { describe, expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { claimsBeyondFacts } from "../src/lib/agent/summary";
import { LEAGUES, detectLeague, eraLeague, leagueMembers } from "../src/lib/domain/leagues";
import { classifyTournament } from "./data/scope";
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

test("summary numbers preserve negative and positive signs", () => {
  const facts = "Chovy : écart d'or -500,5 ; XP +200.";
  expect(claimsBeyondFacts(facts, facts)).toEqual([]);
  expect(claimsBeyondFacts("Chovy : écart d'or −500,5 ; XP +200.", facts)).toEqual([]);

  for (const changed of [
    "Chovy : écart d'or 500,5 ; XP +200.",
    "Chovy : écart d'or +500,5 ; XP +200.",
    "Chovy : écart d'or -500,5 ; XP -200.",
    "Chovy : écart d'or -500,5 ; XP 200.",
  ]) expect(claimsBeyondFacts(changed, facts).length).toBeGreaterThan(0);
});

test("league cues choose the longest match and preserve all scope names", () => {
  expect(new Set(LEAGUES.map((l) => l.name)).size).toBe(LEAGUES.length);
  expect(detectLeague("LCK CL 2024").league).toBe("LCK Challengers League");
  expect(detectLeague("LTA North").league).toBe("League of Legends Championship of The Americas North");
  expect(detectLeague("EU LCS 2016").league).toBe("Europe League Championship Series");
});

test("First Stand is its own international event, apart from Worlds and MSI", () => {
  expect(detectLeague("Qui a gagné First Stand 2025 ?").league).toBe("First Stand");
  expect(detectLeague("Who won First Stand 2026?").league).toBe("First Stand");
  expect(detectLeague("qui a gagné les Worlds 2024").league).toBe("World Championship");
  expect(detectLeague("vainqueur du MSI 2025").league).toBe("Mid-Season Invitational");
  expect(detectLeague("first blood de T1 aux Worlds").league).toBe("World Championship");
  expect(classifyTournament("2025 First Stand", LEAGUES.find((l) => l.name === "First Stand")!)).toEqual({ stage: "main_event", eventPage: "2025 First Stand" });
});

describe("the Esports World Cup and the KeSPA Cup do not take the cues of Worlds", () => {
  test.each([
    ["EWC 2025 vainqueur", "Esports World Cup"],
    ["qui a gagné l'Esports World Cup 2024", "Esports World Cup"],
    ["who won the esports world cup 2026", "Esports World Cup"],
    ["LoL World Cup 2025 winner", "Esports World Cup"],
    ["vainqueur de la coupe du monde de l'esport 2025", "Esports World Cup"],
    ["KeSPA Cup 2025", "KeSPA Cup"],
    ["qui a gagné la kespa 2024", "KeSPA Cup"],
    ["qui a gagné les Worlds 2024", "World Championship"],
    ["world championship 2019", "World Championship"],
    ["résultats de Faker au mondial", "World Championship"],
    ["coupe du monde 2023", "World Championship"],
    ["Chovy at Worlds", "World Championship"],
    ["T1 en LCK 2025", "LoL Champions Korea"],
    ["LCK Cup 2025", "LoL Champions Korea"],
    ["vainqueur du MSI 2025", "Mid-Season Invitational"],
  ] as const)("%s", (question, league) => expect(detectLeague(question).league).toBe(league));

  test("the edition pages are the event itself", () => {
    const ewc = LEAGUES.find((l) => l.name === "Esports World Cup")!;
    const kespa = LEAGUES.find((l) => l.name === "KeSPA Cup")!;
    expect(classifyTournament("Esports World Cup 2025", ewc)).toEqual({ stage: "main_event", eventPage: "Esports World Cup 2025" });
    expect(classifyTournament("Esports World Cup 2026/Online Qualifiers/Korea", ewc)?.stage).toBe("qualifier");
    expect(classifyTournament("2025 LoL KeSPA Cup", kespa)?.stage).toBe("season");
  });
});

test("periods spanning renamings read both leagues in parameterized tool SQL", async () => {
  const db = new DatabaseSync(":memory:");

  try {
    createSchema(db); createQuerySchema(db);
    db.exec(`INSERT INTO teams(id,name) VALUES(1,'T1'),(2,'Gen.G');`);
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

test("an edition without its final placements says the final is not published yet", async () => {
  const db = new DatabaseSync(":memory:");

  try {
    createSchema(db); createQuerySchema(db);
    LEAGUES.forEach((l, i) => db.prepare("INSERT INTO leagues VALUES(?,?,?,?,?)").run(i+1,l.name,l.short,l.region,+l.international));
    const standings = bindTool(db, {tool:"tournament_standings", input:{league:"World Championship",yearFrom:2026,yearTo:2026,split:null,full:true}});

    const row = (team: string, place: string, place_number: number) =>
      ({year:2026,event_page:"Worlds 2026",tournament:"Worlds 2026",stage:"playoffs",team,place,place_number,prize_usd:null});

    const out = await standings.format(db, [row("T1","3-4",3), row("G2 Esports","5-8",5)]);

    expect(out.totals).toMatchObject({champion:"", teams:2, events:1});
    expect(out.facts).toContain("Worlds 2026 : finale pas encore publiée sur Leaguepedia.");
  } finally { db.close(); }
});

test("router prioritizes timeline, missing coverage, unsupported data and tools", () => {
  const db = new DatabaseSync(":memory:");

  try {
    createSchema(db); createQuerySchema(db);
    const schema = readSchema(db);
    const base: Entities = { players:[],teams:[],champion:null,unresolved:[],league:"World Championship",leagueShort:"Worlds",leagueMention:"Worlds",yearFrom:2024,yearTo:2024,split:null,outOfScope:null };
    const coverage = {league:()=>({games:100,ingame:0}),player:()=>({games:100,ingame:0}),team:()=>({games:100,ingame:0})};

    for (const [q, entities, kind] of [
      ["palmarès Worlds 2024", base, "tool"],
      ["first blood en LPL", {...base,league:"Tencent LoL Pro League"}, "missing"],
      ["MVP des Worlds 2024",base,"missing"],
      ["résultats LLA",{...base,outOfScope:"LLA"},"out_of_scope"],
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
