import { describe, expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { guardQuery } from "../src/lib/agent/guard";
import { routeQuestion } from "../src/lib/agent/query";
import { bindTool } from "../src/lib/agent/tools";
import type { Entities } from "../src/lib/agent/types";
import { readSchema } from "../src/lib/db";
import { createQuerySchema, createSchema } from "../src/lib/db/schema";
import { enchantedKind, type ItemKind, type ItemMeta, itemKinds } from "../src/lib/domain/items";
import { LEAGUES } from "../src/lib/domain/leagues";

describe("item kinds from Data Dragon", () => {
  // Shapes taken from item.json 16.22.1 and 13.24.1 (Ornn upgrade, transformation, null recipe entries).
  const catalog = {
    "1036": { tags: ["Damage", "Lane"], into: ["3031", "6672"], gold: { total: 350, purchasable: true } },
    "1038": { tags: ["Damage"], into: ["3031"], gold: { total: 1300, purchasable: true } },
    "3031": { tags: ["CriticalStrike", "Damage"], from: ["1038", "1036"], depth: 2, gold: { total: 3500, purchasable: true } },
    "6672": { tags: ["Damage", "AttackSpeed"], from: ["1036"], depth: 3, gold: { total: 3000, purchasable: true } },
    "6655": { tags: ["SpellDamage"], into: ["7013"], from: ["1036"], depth: 3, gold: { total: 3200, purchasable: true } },
    "7013": { tags: ["SpellDamage"], from: ["6655"], gold: { total: 3200, purchasable: false }, requiredAlly: "Ornn" },
    "3042": { tags: ["Damage", "Mana"], gold: { total: 2900, purchasable: false } },
    "1055": { tags: ["Health", "Damage", "Lane"], gold: { total: 450, purchasable: true } },
    "1082": { tags: ["Health", "SpellDamage", "Lane"], into: ["3041"], gold: { total: 350, purchasable: true } },
    "1102": { tags: ["Jungle"], gold: { total: 450, purchasable: true } },
    "3865": { tags: ["Health", "GoldPer", "Lane"], gold: { total: 400, purchasable: true } },
    "2055": { tags: ["Consumable", "Lane", "Vision"], gold: { total: 75, purchasable: true } },
    "3363": { tags: ["Active", "Trinket", "Vision"], gold: { total: 0, purchasable: true } },
    "4638": { tags: ["Health", "Vision"], into: ["4643"], gold: { total: 1100, purchasable: true } },
    // Relic Shield → Targon's Buckler → Bulwark of the Mountain (13.24.1): only the last stage is completed.
    "3858": { tags: ["Health", "GoldPer", "Lane"], gold: { total: 400, purchasable: true } },
    "3859": { tags: ["Health", "GoldPer", "Lane"], gold: { total: 400, purchasable: false }, specialRecipe: 3858 },
    "3860": { tags: ["Health", "GoldPer", "Lane"], gold: { total: 400, purchasable: false }, specialRecipe: 3859 },
    "1001": { tags: ["Boots"], into: ["3047"], gold: { total: 300, purchasable: true } },
    "3047": { tags: ["Armor", "Boots"], into: ["3174"], from: ["1001"], depth: 2, gold: { total: 1200, purchasable: true } },
  } satisfies Record<string, ItemMeta>;

  test.each([
    ["1036", "component"],
    ["1038", "component"],
    ["3031", "complete"],
    ["6672", "complete"],
    // Luden's Tempest builds only into Ornn's upgrade: completed.
    ["6655", "complete"],
    ["7013", "complete"],
    // Muramana: a transformation, no recipe depth.
    ["3042", "complete"],
    ["1055", "starter"],
    ["1082", "starter"],
    ["1102", "starter"],
    ["3865", "starter"],
    ["2055", "consumable"],
    ["3363", "consumable"],
    // Watchful Wardstone: Data Dragon marks it `consumed`, it is a component of the Vigilant Wardstone.
    ["4638", "component"],
    ["3858", "starter"],
    ["3859", "starter"],
    ["3860", "complete"],
    ["1001", "boots"],
    ["3047", "boots"],
  ] as const)("%s → %s", (id, kind) => expect(itemKinds(catalog)[id]).toBe(kind));

  test("an enchanted Leaguepedia name takes its base item, completed", () => {
    const base = new Map<string, ItemKind>([["Mercury's Treads", "boots"], ["Skirmisher's Sabre", "component"]]);
    const kindOf = (n: string) => base.get(n);

    expect(enchantedKind("Mercury's Treads - Homeguard", kindOf)).toBe("boots");
    expect(enchantedKind("Skirmisher's Sabre - Warrior", kindOf)).toBe("complete");
    expect(enchantedKind("Lord Dominik's Regard", kindOf)).toBeUndefined();
  });
});

/**
 * Worlds 2026, four games of Yunara in the bot lane (three with an inventory), and MSI 2023 first dragons:
 * T1 takes it in two of its three games, Gen.G in one.
 */
function seed(db: DatabaseSync) {
  createSchema(db);
  createQuerySchema(db);
  LEAGUES.forEach((l, i) => db.prepare("INSERT INTO leagues VALUES(?,?,?,?,?)").run(i + 1, l.name, l.short, l.region, +l.international));
  const worlds = Number(db.prepare("SELECT id FROM leagues WHERE name = 'World Championship'").get()!.id);
  const msi = Number(db.prepare("SELECT id FROM leagues WHERE name = 'Mid-Season Invitational'").get()!.id);
  const icon = (id: number) => `https://ddragon.leagueoflegends.com/cdn/16.22.1/img/item/${id}.png`;

  db.prepare("INSERT INTO tournaments(id,page,event_page,stage,league_id,year) VALUES (1,'W26/Main Event','W26','main_event',?,2026),(2,'MSI23','MSI23','main_event',?,2023)").run(worlds, msi);
  db.exec(`
    INSERT INTO teams VALUES (1,'T1'),(2,'Gen.G');
    INSERT INTO players(id,page) VALUES (1,'Gumayusi'),(2,'Ruler');
    INSERT INTO champions VALUES (1,'Yunara',NULL),(2,'Jinx',NULL);
    INSERT INTO items VALUES (1,'Infinity Edge','${icon(3031)}','complete'),(2,'Long Sword','${icon(1036)}','component'),
      (3,'Control Ward','${icon(2055)}','consumable'),(4,'Kraken Slayer','${icon(6672)}','complete'),(5,'Mystery Item','/icons/item-fallback.svg',NULL);
    INSERT INTO games(id,tournament_id,blue_team_id,red_team_id,winner_side,played_at)
      VALUES (1,1,1,2,1,100),(2,1,2,1,1,200),(3,1,1,2,1,300),(4,1,2,1,2,400),(5,2,1,2,1,50),(6,2,1,2,2,60),(7,2,2,1,2,70);
    -- game_id, player_id, team_id, side, role, champion_id, win
    INSERT INTO game_players(game_id,player_id,team_id,side,role,champion_id,win) VALUES
      (1,1,1,1,'Bot',1,1),(1,2,2,2,'Bot',2,0),
      (2,1,1,2,'Bot',1,0),(2,2,2,1,'Bot',2,1),
      (3,2,2,2,'Bot',1,0),(3,1,1,1,'Bot',2,1),
      (4,1,1,2,'Bot',1,1),(4,2,2,1,'Bot',2,0);
    -- Two Long Swords in game 1 count once; game 4 has no inventory.
    INSERT INTO game_player_items VALUES (1,1,1,1),(1,1,2,2),(1,1,3,2),(1,1,4,4),(2,1,1,1),(2,1,2,3),(3,2,1,1),(3,2,2,4),(3,2,3,5);
    INSERT INTO game_riot VALUES (5,'K5','V5 data:K5',5,1,0),(6,'K6','V5 data:K6',5,1,0),(7,'K7','V5 data:K7',5,1,0);
    INSERT INTO game_team_stats(game_id,side,first_dragon) VALUES (5,1,1),(5,2,0),(6,1,1),(6,2,0),(7,1,1),(7,2,0);
  `);
}

async function run(db: DatabaseSync, call: Parameters<typeof bindTool>[1]) {
  const tool = bindTool(db, call);

  expect(guardQuery(db, readSchema(db), tool.sql).ok).toBe(true);

  return tool.format(db, db.prepare(tool.sql).all(tool.params));
}

describe("a champion's most built items", () => {
  test("games per item with two copies counted once, share of the games with an inventory, kinds and missing data", async () => {
    const db = new DatabaseSync(":memory:");

    try {
      seed(db);
      const out = await run(db, { tool: "champion_event_stats", input: { champion: "Yunara", league: "World Championship", yearFrom: 2026, yearTo: 2026 } });
      const items = out.champion!.items;

      expect(items.games).toBe(3);
      expect(items.items.map((i) => [i.item, i.kind, i.games, i.wins])).toEqual([
        ["Infinity Edge", "complete", 3, 1],
        ["Kraken Slayer", "complete", 2, 1],
        ["Control Ward", "consumable", 1, 0],
        ["Long Sword", "component", 1, 1],
        ["Mystery Item", null, 1, 0],
      ]);
      expect(items.notes).toEqual([
        "Inventaire connu pour 3 parties sur 4.",
        "Depuis 2026, les bottes des ADC (emplacement de quête de rôle) ne figurent pas dans l'inventaire listé par Leaguepedia.",
      ]);
      expect(out.facts).toContain("Infinity Edge (3/3 parties, 100 %), Kraken Slayer (2/3 parties, 67 %)");
      expect(out.totals).toMatchObject({ item_games: 3, top_item: "Infinity Edge", top_item_games: 3 });
      expect(out.sources.map((s) => s.label)).toContain("Leaguepedia — inventaires de fin de partie (ScoreboardPlayers)");
    } finally {
      db.close();
    }
  });

  test("no inventory in the scope: an empty list and the reason", async () => {
    const db = new DatabaseSync(":memory:");

    try {
      seed(db);
      db.exec("DELETE FROM game_player_items");
      const out = await run(db, { tool: "champion_event_stats", input: { champion: "Yunara", league: "World Championship", yearFrom: 2026, yearTo: 2026 } });

      expect(out.champion!.items).toMatchObject({ games: 0, items: [] });
      expect(out.champion!.items.notes[0]).toBe("Leaguepedia ne liste aucun inventaire de fin de partie pour ces parties.");
    } finally {
      db.close();
    }
  });

  test("an item question about a champion goes to its profile, decided by the rules", () => {
    const e: Entities = {
      players: [], teams: [], champion: { mention: "Yunara", champion: "Yunara" }, unresolved: [], league: "World Championship", leagueShort: "Worlds",
      leagueMention: "Worlds", yearFrom: 2026, yearTo: 2026, split: null, outOfScope: null,
    };

    const coverage = { league: () => ({ games: 100, ingame: 100 }), player: () => ({ games: 100, ingame: 100 }), team: () => ({ games: 100, ingame: 100 }) };

    for (const q of ["Items de Yunara aux Worlds 2026", "build Yunara worlds 2026", "yunara worlds 2026"])
      expect(routeQuestion(q, e, { v_games: ["game_id"] }, coverage)).toMatchObject({ kind: "tool", confidence: 0.9, call: { tool: "champion_event_stats", input: { champion: "Yunara" } } });
  });
});

describe("rate leaderboards show the count beside the share", () => {
  test("first dragon: games, first dragons, %", async () => {
    const db = new DatabaseSync(":memory:");

    try {
      seed(db);

      const out = await run(db, {
        tool: "ingame_leaderboard",
        input: { subject: "team", metric: "first_dragon", minute: null, league: "Mid-Season Invitational", yearFrom: 2023, yearTo: 2023, role: null, minGames: 1 },
      });

      expect(out.table!.columns).toEqual(["Rang", "Équipe", "Parties", "Nombre", "%"]);
      expect(out.table!.rows).toEqual([[1, "T1", 3, 2, 66.7], [2, "Gen.G", 3, 1, 33.3]]);
      expect(out.facts).toContain("1. T1 (2 sur 3 parties, 66.7 %), 2. Gen.G (1 sur 3 parties, 33.3 %)");
      expect(out.totals).toMatchObject({ leader: "T1", leader_value: 66.7, leader_count: 2 });
    } finally {
      db.close();
    }
  });
});
