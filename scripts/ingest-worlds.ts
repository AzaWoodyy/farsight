/**
 * Ingest every League of Legends World Championship (2011 -> latest) from
 * Leaguepedia's Cargo tables into the local SQLite cache.
 *
 *   bun run ingest:worlds
 *
 * Re-runnable: rows are upserted and raw responses are cached in data/raw,
 * so a second run makes no network calls (delete data/raw to refresh).
 */
import { normalizeAlias } from "../src/lib/aliases";
import { DB_PATH, openDb } from "../src/lib/db";
import { fetchChampions } from "../src/lib/sources/ddragon";
import { cargoQuery, cargoString } from "../src/lib/sources/leaguepedia";

const LEAGUE = "World Championship";
// "2024 Season World Championship/Main Event", "Season 3 World Championship", ...
const WORLDS_PAGE =
  /^(?:(\d{4}) Season|Season (\d)) World Championship(?:\/(Main Event|Play-In))?$/;

const str = (v: unknown) => (v == null || v === "" ? null : String(v));
const num = (v: unknown) =>
  v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v);
const inList = (field: string, values: string[]) =>
  `${field} IN (${values.map(cargoString).join(",")})`;
const chunks = <T>(arr: T[], size: number) =>
  Array.from({ length: Math.ceil(arr.length / size) }, (_, i) =>
    arr.slice(i * size, i * size + size),
  );

async function main() {
  const db = openDb();
  const startedAt = new Date().toISOString();
  console.log(`SQLite cache: ${DB_PATH}`);

  // 1. Tournaments -----------------------------------------------------------
  console.log("1/5 tournaments");
  const tournamentRows = await cargoQuery({
    tables: "Tournaments",
    fields: [
      "Tournaments.Name=Name",
      "Tournaments.OverviewPage=OverviewPage",
      "Tournaments.Year=Year",
      "Tournaments.DateStart=DateStart",
    ],
    where: `Tournaments.League=${cargoString(LEAGUE)}`,
    orderBy: "Tournaments.DateStart",
  });

  type Stage = {
    page: string;
    eventPage: string;
    name: string;
    year: number;
    phase: string | null;
    dateStart: string | null;
  };
  const candidates: Stage[] = [];
  for (const r of tournamentRows) {
    const page = String(r.OverviewPage);
    const m = WORLDS_PAGE.exec(page);
    if (!m) continue; // regional finals / qualifiers share the league label
    // Sub-stages (2017+) carry Year on the stage page; a parent page with no
    // Year and no stages is an announced, not-yet-played edition.
    if (r.Year == null && !m[3]) continue;
    const year = m[1] ? Number(m[1]) : 2010 + Number(m[2]);
    candidates.push({
      page,
      eventPage: page.split("/")[0],
      name: String(r.Name),
      year,
      phase: m[3] ?? null,
      dateStart: str(r.DateStart),
    });
  }
  // A parent page with sub-stages (2017+) is only a container: the games live
  // on /Play-In and /Main Event. Single-stage years keep the parent page.
  const withStages = new Set(
    candidates.filter((c) => c.phase).map((c) => c.eventPage),
  );
  const stages = candidates.filter(
    (c) => c.phase !== null || !withStages.has(c.eventPage),
  );
  const eventPages = [...new Set(stages.map((s) => s.eventPage))];
  console.log(
    `  ${stages.length} stages across ${eventPages.length} Worlds editions`,
  );

  // 2. Final standings (held on the parent event page) -----------------------
  console.log("2/5 tournament results");
  const results = await cargoQuery({
    tables: "TournamentResults",
    fields: [
      "TournamentResults.OverviewPage=OverviewPage",
      "TournamentResults.Team=Team",
      "TournamentResults.Place=Place",
      "TournamentResults.Place_Number=PlaceNumber",
      "TournamentResults.LastResult=LastResult",
      "TournamentResults.Prize_USD=PrizeUSD",
    ],
    where: inList("TournamentResults.OverviewPage", eventPages),
  });

  // 3. Per-game player lines -------------------------------------------------
  console.log("3/5 scoreboards");
  const games: Record<string, unknown>[] = [];
  for (const stage of stages) {
    const rows = await cargoQuery({
      tables: "ScoreboardPlayers",
      fields: [
        "ScoreboardPlayers.GameId=GameId",
        "ScoreboardPlayers.OverviewPage=OverviewPage",
        "ScoreboardPlayers.Link=Link",
        "ScoreboardPlayers.Name=Name",
        "ScoreboardPlayers.Team=Team",
        "ScoreboardPlayers.Role=Role",
        "ScoreboardPlayers.Champion=Champion",
        "ScoreboardPlayers.PlayerWin=PlayerWin",
        "ScoreboardPlayers.DateTime_UTC=DateUtc",
        "ScoreboardPlayers.Kills=Kills",
        "ScoreboardPlayers.Deaths=Deaths",
        "ScoreboardPlayers.Assists=Assists",
      ],
      where: `ScoreboardPlayers.OverviewPage=${cargoString(stage.page)}`,
      orderBy: "ScoreboardPlayers.GameId,ScoreboardPlayers.Link",
    });
    console.log(`  ${stage.page}: ${rows.length} player-games`);
    games.push(...rows);
  }

  // 4. Players + aliases -------------------------------------------------------
  console.log("4/5 players and aliases");
  const playerLinks = [
    ...new Set(
      games.map((g) => str(g.Link) ?? str(g.Name)).filter(Boolean) as string[],
    ),
  ];
  const players: Record<string, unknown>[] = [];
  const redirects: Record<string, unknown>[] = [];
  for (const batch of chunks(playerLinks, 100)) {
    players.push(
      ...(await cargoQuery({
        tables: "Players",
        fields: [
          "Players.OverviewPage=OverviewPage",
          "Players.ID=ID",
          "Players.Name=Name",
          "Players.NativeName=NativeName",
          "Players.Country=Country",
          "Players.Role=Role",
          "Players.Team=Team",
        ],
        where: inList("Players.OverviewPage", batch),
      })),
    );
    redirects.push(
      ...(await cargoQuery({
        tables: "PlayerRedirects",
        fields: [
          "PlayerRedirects.AllName=AllName",
          "PlayerRedirects.OverviewPage=OverviewPage",
        ],
        where: inList("PlayerRedirects.OverviewPage", batch),
      })),
    );
  }

  // 5. Champions from Data Dragon -----------------------------------------------
  console.log("5/5 Data Dragon champions");
  const { version, champions } = await fetchChampions();

  // Write everything in one transaction ---------------------------------------
  db.exec("BEGIN");
  try {
    // Replace this scope's stages so dropped pages don't linger.
    db.prepare("DELETE FROM tournaments WHERE league = ?").run(LEAGUE);
    const insTournament = db.prepare(
      `INSERT OR REPLACE INTO tournaments
       (overview_page, event_page, name, league, year, phase, date_start)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const s of stages)
      insTournament.run(
        s.page,
        s.eventPage,
        s.name,
        LEAGUE,
        s.year,
        s.phase,
        s.dateStart,
      );

    const insResult = db.prepare(
      `INSERT OR REPLACE INTO tournament_results
       (event_page, team, place, place_number, last_result, prize_usd)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const r of results) {
      if (!str(r.Team) || r.Place == null) continue;
      insResult.run(
        String(r.OverviewPage),
        String(r.Team),
        String(r.Place),
        num(r.PlaceNumber),
        str(r.LastResult),
        num(r.PrizeUSD),
      );
    }

    const insGame = db.prepare(
      `INSERT OR REPLACE INTO games_players
       (game_id, overview_page, player, name, team, role, champion, win,
        datetime_utc, kills, deaths, assists)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const g of games) {
      const player = str(g.Link) ?? str(g.Name);
      if (!player || !str(g.GameId) || !str(g.Team)) continue;
      insGame.run(
        String(g.GameId),
        String(g.OverviewPage),
        player,
        str(g.Name),
        String(g.Team),
        str(g.Role),
        str(g.Champion),
        g.PlayerWin === "Yes" ? 1 : 0,
        str(g.DateUtc),
        num(g.Kills),
        num(g.Deaths),
        num(g.Assists),
      );
    }

    const insPlayer = db.prepare(
      `INSERT OR REPLACE INTO players
       (player, real_name, native_name, country, role, team)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insAlias = db.prepare(
      `INSERT OR IGNORE INTO player_aliases (alias, raw_alias, player, source)
       VALUES (?, ?, ?, ?)`,
    );
    const addAlias = (raw: string | null, player: string, source: string) => {
      if (!raw) return;
      const alias = normalizeAlias(raw);
      if (alias.length >= 2) insAlias.run(alias, raw, player, source);
    };
    for (const p of players) {
      const player = String(p.OverviewPage);
      insPlayer.run(
        player,
        str(p.Name),
        str(p.NativeName),
        str(p.Country),
        str(p.Role),
        str(p.Team),
      );
      addAlias(player, player, "ign");
      addAlias(str(p.ID), player, "ign");
      addAlias(str(p.NativeName), player, "native_name");
      addAlias(str(p.Name), player, "real_name");
      // Korean/Chinese romanizations: also index the given name alone
      // ("Jeong Ji-hoon" -> "Ji-hoon").
      const realName = str(p.Name);
      if (realName && realName.includes(" "))
        addAlias(realName.split(" ").slice(1).join(" "), player, "real_name");
    }
    for (const r of redirects)
      addAlias(str(r.AllName), String(r.OverviewPage), "redirect");
    // Players without a Players row still get their in-game names.
    for (const g of games) {
      const player = str(g.Link) ?? str(g.Name);
      if (player) {
        addAlias(player, player, "ign");
        addAlias(str(g.Name), player, "ign");
      }
    }

    const insChampion = db.prepare(
      `INSERT OR REPLACE INTO champions (name, ddragon_id, image_url, version)
       VALUES (?, ?, ?, ?)`,
    );
    for (const c of champions) insChampion.run(c.name, c.id, c.imageUrl, version);

    const counts = {
      tournaments: stages.length,
      tournament_results: results.length,
      games_players: games.length,
      players: players.length,
      player_redirects: redirects.length,
      champions: champions.length,
    };
    db.prepare(
      `INSERT INTO ingest_runs (scope, source, started_at, finished_at, row_counts)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      "worlds",
      "Leaguepedia Cargo (lol.fandom.com, CC BY-SA 3.0) + Riot Data Dragon",
      startedAt,
      new Date().toISOString(),
      JSON.stringify(counts),
    );
    db.exec("COMMIT");
    console.log("done", counts);
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
