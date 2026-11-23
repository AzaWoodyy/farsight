import { writeFileSync } from "node:fs";
import { type HomeProof, HomeProofs, PROOF_KINDS, PROOF_QUESTIONS } from "../../src/app/home-proofs-data";
import { rulesOnly, runAgent } from "../../src/lib/agent/run";
import type { Answer } from "../../src/lib/agent/types";
import { LOCALES } from "../../src/lib/locale";

const out = process.argv[2];

if (!out) throw new Error("usage: bun scripts/home/proofs.ts <output file>");

const SHOWN_SERIES = 5;
const SHOWN_PLAYERS = 4;
const SHOWN_KEYSTONES = 5;

function missing(question: string, view: string): never {
  throw new Error(`"${question}" did not answer with ${view}`);
}

function proofOf(kind: HomeProof["kind"], question: string, answer: Answer): HomeProof {
  const shared = { question, title: answer.title, sources: answer.sources.slice(0, 2) };
  const logos = { icons: answer.icons, iconTones: answer.iconTones };

  if (kind === "duel") {
    const versus = answer.versus;

    if (!versus?.h2h || answer.profiles.length !== 2) return missing(question, "a head-to-head of two players");
    const latest = versus.games[0] ?? null;
    const side = ({ champion, championIcon, kills, deaths, assists }: (typeof versus.games)[number]["a"]) => ({ champion, championIcon, kills, deaths, assists });

    return { kind, ...shared, h2h: versus.h2h, lanes: versus.lanes, profiles: answer.profiles, latest: latest && { playedAt: latest.playedAt, a: side(latest.a), b: side(latest.b) } };
  }

  if (kind === "teams") {
    const teams = answer.teams;

    if (!teams?.seriesCount) return missing(question, "a head-to-head of two teams");
    const { teamA, teamB, seriesA, seriesB, gamesA, gamesB, seriesCount } = teams;
    const series = teams.series.slice(0, SHOWN_SERIES).map(({ playedAt, label, winsA, winsB }) => ({ playedAt, label, winsA, winsB }));

    return { kind, ...shared, ...logos, teamA, teamB, seriesA, seriesB, gamesA, gamesB, seriesCount, series };
  }

  if (kind === "series") {
    const series = answer.series?.series[0];

    if (!series?.games?.length) return missing(question, "a series with its games");
    const { teamA, teamB, winsA, winsB, bestOf, playedAt } = series;

    const games = series.games.map((g) => {
      const winnerTeam = g.winner && g[g.winner];

      return { n: g.n, winner: winnerTeam === teamA ? ("a" as const) : winnerTeam === teamB ? ("b" as const) : null, side: g.winner, durationS: g.durationS };
    });

    return { kind, ...shared, ...logos, teamA, teamB, winsA, winsB, bestOf, playedAt, games };
  }

  if (kind === "champion") {
    const champion = answer.champion;

    if (!champion?.picks) return missing(question, "a champion profile");
    const players = champion.players.slice(0, SHOWN_PLAYERS).map(({ player, team, games, wins }) => ({ player, team, games, wins }));

    return { kind, ...shared, champion: champion.champion, icon: champion.icon, games: champion.games, picks: champion.picks, bans: champion.bans, wins: champion.wins, kda: champion.kda, players };
  }

  const runes = answer.runes;
  const keystones = (runes?.runes ?? []).filter((r) => r.kind === "keystone").slice(0, SHOWN_KEYSTONES).map(({ rune, icon, games, wins }) => ({ rune, icon, games, wins }));

  if (!runes || !keystones.length) return missing(question, "a player's keystones");

  return { kind, ...shared, profile: answer.profiles[0] ?? null, player: runes.player, games: runes.games, wins: runes.wins, keystones };
}

const proofs: HomeProofs = { fr: [], en: [] };

for (const locale of LOCALES) {
  for (const kind of PROOF_KINDS) {
    const question = PROOF_QUESTIONS[kind][locale];
    const answer = await rulesOnly(() => runAgent(question, () => {}, new Date(), undefined, locale));

    try {
      proofs[locale].push(proofOf(kind, question, answer));
    } catch (err) {
      console.warn(`home proofs: ${err instanceof Error ? err.message : String(err)} (${locale}): left out of the home page`);
    }
  }
}

writeFileSync(out, JSON.stringify(HomeProofs.parse(proofs)));

process.exit(0);
