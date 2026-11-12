import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { openDb, readSchema } from "../db";
import { DDRAGON_BASE } from "../sources/ddragon";
import { wikiUrl } from "../sources/leaguepedia";
import { guardQuery } from "./guard";
import { getChatModel } from "./llm";
import { buildPlayerEventHistory } from "./query";
import type {
  Answer,
  ChampionPlay,
  Entities,
  QueryPlan,
  ResultRow,
  Source,
  TraceEntry,
} from "./types";
import { understandQuestion } from "./understand";

const MAX_ATTEMPTS = 3;

const State = Annotation.Root({
  question: Annotation<string>(),
  entities: Annotation<Entities | null>({ reducer: (_, b) => b, default: () => null }),
  plan: Annotation<QueryPlan | null>({ reducer: (_, b) => b, default: () => null }),
  guardIssues: Annotation<string[]>({ reducer: (_, b) => b, default: () => [] }),
  rows: Annotation<Record<string, unknown>[] | null>({ reducer: (_, b) => b, default: () => null }),
  execError: Annotation<string | null>({ reducer: (_, b) => b, default: () => null }),
  notes: Annotation<string[]>({ reducer: (a, b) => [...a, ...b], default: () => [] }),
  exhausted: Annotation<boolean>({ reducer: (_, b) => b, default: () => false }),
  answer: Annotation<Answer | null>({ reducer: (_, b) => b, default: () => null }),
  trace: Annotation<TraceEntry[]>({ reducer: (a, b) => [...a, ...b], default: () => [] }),
});
type S = typeof State.State;

const t = (e: Omit<TraceEntry, "at">): TraceEntry => ({ ...e, at: new Date().toISOString() });

// 1. Understand ----------------------------------------------------------------
async function understand(state: S): Promise<Partial<S>> {
  const db = openDb();
  const { entities, method, llmError } = await understandQuestion(db, state.question);
  const ingested = (
    db.prepare("SELECT DISTINCT league FROM tournaments").all() as { league: string }[]
  ).map((r) => r.league);
  const trace: TraceEntry[] = [];
  const notes: string[] = [];

  if (llmError)
    trace.push(t({ node: "understand", status: "warn", title: "LLM indisponible, analyse par règles", detail: llmError }));

  if (!entities.league) {
    entities.league = "World Championship";
    notes.push("Aucune compétition précisée : recherche sur les Worlds (seule compétition ingérée).");
  } else if (!ingested.includes(entities.league)) {
    notes.push(`${entities.league} n'est pas encore dans le cache local (jalon actuel : Worlds).`);
  }

  if (entities.players.length > 1)
    notes.push(
      `Plusieurs joueurs reconnus : seul ${entities.players[0].player} est traité (les comparaisons arrivent dans un prochain jalon).`,
    );

  const lines = [
    ...entities.players.map((p) => {
      const ids = [p.realName, p.nativeName].filter(Boolean).join(" · ");
      const via = p.mention === p.player ? "" : ` via l'alias « ${p.matchedAlias} » (${p.aliasSource})`;
      return `joueur « ${p.mention} » → ${p.player}${ids ? ` (${ids})` : ""}${via}`;
    }),
    ...entities.unresolved.map((m) => `« ${m} » : aucun joueur connu`),
    `compétition → ${entities.league}${entities.leagueMention ? ` (« ${entities.leagueMention} »)` : " (par défaut)"}`,
    `période → ${entities.yearFrom ?? "début"} – ${entities.yearTo ?? "aujourd'hui"}`,
  ];
  const ok = entities.players.length > 0;
  trace.push(
    t({
      node: "understand",
      status: ok ? "ok" : "error",
      title: ok
        ? `Entités reconnues (${method === "llm" ? "LLM" : "règles + table d'alias"})`
        : "Aucun joueur reconnu dans la question",
      detail: lines.join("\n"),
      data: entities,
    }),
  );
  return { entities, trace, notes };
}

// 2. Build query ---------------------------------------------------------------
function buildQuery(state: S): Partial<S> {
  const plan = buildPlayerEventHistory(state.entities!, { period: true }, 1);
  return {
    plan,
    trace: [
      t({
        node: "build_query",
        status: "ok",
        title: "Requête construite (historique joueur × compétition)",
        detail: plan.sql,
        data: plan.params,
      }),
    ],
  };
}

// 3a. Guard --------------------------------------------------------------------
function guard(state: S): Partial<S> {
  const db = openDb();
  const result = guardQuery(db, readSchema(db), state.plan!.sql);
  if (result.ok)
    return {
      guardIssues: [],
      trace: [t({ node: "guard", status: "ok", title: "Schéma validé : tables et colonnes connues, lecture seule" })],
    };
  return {
    guardIssues: result.issues,
    trace: [t({ node: "guard", status: "error", title: "Requête rejetée par le garde-fou", detail: result.issues.join("\n") })],
  };
}

// 3b. Execute ------------------------------------------------------------------
function execute(state: S): Partial<S> {
  const db = openDb();
  const started = performance.now();
  try {
    const rows = db.prepare(state.plan!.sql).all(state.plan!.params) as Record<string, unknown>[];
    const ms = Math.round(performance.now() - started);
    return {
      rows,
      execError: null,
      trace: [
        t({
          node: "execute",
          status: rows.length ? "ok" : "warn",
          title: rows.length ? `${rows.length} ligne(s) en ${ms} ms` : `Résultat vide (${ms} ms)`,
        }),
      ],
    };
  } catch (err) {
    const message = (err as Error).message;
    return {
      rows: null,
      execError: message,
      trace: [t({ node: "execute", status: "error", title: "Erreur SQLite", detail: message })],
    };
  }
}

// 3c. Self-correct -------------------------------------------------------------
async function correct(state: S): Promise<Partial<S>> {
  const plan = state.plan!;
  if (plan.attempt >= MAX_ATTEMPTS)
    return {
      exhausted: true,
      trace: [t({ node: "correct", status: "error", title: `Abandon après ${plan.attempt} tentatives` })],
    };

  const problem = state.guardIssues.length
    ? state.guardIssues.join("\n")
    : state.execError ?? "résultat vide";

  // Broken SQL: ask the LLM to repair it if one is configured, otherwise
  // rebuild from the template.
  if (state.guardIssues.length || state.execError) {
    const llm = await getChatModel();
    if (llm) {
      const db = openDb();
      const schema = Object.entries(readSchema(db))
        .map(([tbl, cols]) => `${tbl}(${cols.join(", ")})`)
        .join("\n");
      const reply = await llm.model.invoke([
        {
          role: "system",
          content: `Fix this SQLite query. Schema:\n${schema}\nKeep the same named parameters. Reply with SQL only.`,
        },
        { role: "user", content: `Query:\n${plan.sql}\n\nProblem:\n${problem}` },
      ]);
      const sql = String(reply.content).replace(/^```\w*\n?|```$/g, "").trim();
      return {
        plan: { ...plan, sql, attempt: plan.attempt + 1 },
        trace: [t({ node: "correct", status: "fix", title: "Requête réparée par le LLM", detail: `${problem}\n→\n${sql}` })],
      };
    }
    const rebuilt = buildPlayerEventHistory(state.entities!, plan.filters, plan.attempt + 1);
    return {
      plan: rebuilt,
      trace: [t({ node: "correct", status: "fix", title: "Requête reconstruite depuis le modèle", detail: problem })],
    };
  }

  // Empty result: relax the narrowest filter first.
  if (plan.filters.period) {
    const e = state.entities!;
    const relaxed = buildPlayerEventHistory(e, { period: false }, plan.attempt + 1);
    return {
      plan: relaxed,
      notes: [
        `Aucune participation de ${e.players[0].player} entre ${e.yearFrom ?? "…"} et ${e.yearTo ?? "…"} : affichage de toutes les éditions.`,
      ],
      trace: [
        t({
          node: "correct",
          status: "fix",
          title: "Auto-correction : filtre de période retiré",
          detail: `Aucune ligne pour ${e.yearFrom ?? "…"}–${e.yearTo ?? "…"} ; nouvelle tentative sans contrainte d'année.`,
        }),
      ],
    };
  }

  return {
    exhausted: true,
    trace: [t({ node: "correct", status: "error", title: "Aucune correction possible", detail: problem })],
  };
}

// 4. Format --------------------------------------------------------------------
function placeLabel(place: string | null): string {
  if (!place) return "Classement non publié";
  if (place === "1") return "Champion";
  if (place === "2") return "Finaliste";
  if (place === "3-4") return "Demi-finale";
  if (place === "5-8") return "Quart de finale";
  return `Éliminé (${place}e)`;
}

async function format(state: S): Promise<Partial<S>> {
  const db = openDb();
  const e = state.entities;
  const player = e?.players[0];

  if (!player || !state.rows?.length) {
    const answer: Answer = {
      title: player ? `${player.player} — ${e?.league}` : "Pas de résultat",
      summary: player
        ? `Aucune partie de ${player.player} trouvée pour ${e?.league} dans le cache local.`
        : "Je n'ai reconnu aucun joueur dans la question. Essaie avec un pseudo (Faker), un nom réel (Lee Sang-hyeok) ou en hangul (이상혁).",
      rows: [],
      sources: [],
      followUps: ["Résultats de Chovy à tous les Worlds", "Résultats de Faker à tous les Worlds"],
      notes: state.notes,
    };
    return { answer, trace: [t({ node: "format", status: "warn", title: "Réponse vide mise en forme" })] };
  }

  const icons = new Map(
    (db.prepare("SELECT name, image_url FROM champions").all() as { name: string; image_url: string }[]).map(
      (c) => [c.name.toLowerCase(), c.image_url],
    ),
  );
  const rows: ResultRow[] = state.rows.map((r) => {
    const champions = (JSON.parse(String(r.champions)) as Omit<ChampionPlay, "imageUrl">[]).map((c) => ({
      ...c,
      imageUrl: icons.get(String(c.name).toLowerCase()) ?? null,
    }));
    const place = r.place == null ? null : String(r.place);
    return {
      year: Number(r.year),
      event: String(r.event_page),
      team: String(r.team),
      place,
      placeLabel: placeLabel(place),
      placeNumber: r.place_number == null ? null : Number(r.place_number),
      wins: Number(r.wins),
      losses: Number(r.losses),
      champions,
    };
  });

  const wins = rows.reduce((n, r) => n + r.wins, 0);
  const losses = rows.reduce((n, r) => n + r.losses, 0);
  const teams = [...new Set(rows.map((r) => r.team.replace(/\s*\(.*?\)\s*$/, "")))];
  const ranked = rows.filter((r) => r.placeNumber != null);
  const best = ranked.length ? Math.min(...ranked.map((r) => r.placeNumber!)) : null;
  const bestRows = ranked.filter((r) => r.placeNumber === best);
  const years = rows.map((r) => r.year);
  const unranked = rows.filter((r) => r.place == null);

  let summary =
    `${player.player} a disputé ${new Set(years).size} Worlds (${Math.min(...years)}–${Math.max(...years)}) ` +
    `avec ${teams.length} équipe${teams.length > 1 ? "s" : ""} (${teams.join(", ")}), ` +
    `pour un bilan de ${wins} victoires et ${losses} défaites en parties (${Math.round((100 * wins) / (wins + losses))} %).`;
  if (bestRows.length)
    summary += ` Meilleur résultat : ${placeLabel(bestRows[0].place).toLowerCase()} en ${bestRows
      .map((r) => `${r.year} (${r.team.replace(/\s*\(.*?\)\s*$/, "")})`)
      .join(", ")}.`;
  if (unranked.length)
    summary += ` Classement final ${unranked.map((r) => r.year).join(", ")} pas encore publié sur Leaguepedia.`;

  // Follow-ups stay within what the graph supports: teammates of the latest run.
  const latest = rows[rows.length - 1];
  const teammates = (
    db
      .prepare(
        `SELECT gp.player, COUNT(*) AS n FROM games_players gp
         JOIN tournaments t ON t.overview_page = gp.overview_page
         WHERE t.event_page = ? AND gp.team = ? AND gp.player <> ?
         GROUP BY gp.player ORDER BY n DESC LIMIT 2`,
      )
      .all(latest.event, latest.team, player.player) as { player: string }[]
  ).map((r) => r.player);

  const llm = await getChatModel();
  let summaryBy = "modèle de phrase";
  if (llm) {
    try {
      const reply = await llm.model.invoke([
        {
          role: "system",
          content:
            "Rédige une seule phrase de synthèse en français à partir de ces données. N'ajoute aucun fait absent des données.",
        },
        { role: "user", content: JSON.stringify({ question: state.question, facts: summary, rows }) },
      ]);
      summary = String(reply.content).trim();
      summaryBy = `LLM (${llm.info?.model})`;
    } catch {
      // keep the templated summary
    }
  }

  const sources: Source[] = [
    { label: `Leaguepedia — ${player.player}`, url: wikiUrl(player.player) },
    ...[...new Set(rows.map((r) => r.event))].map((page) => ({ label: `Leaguepedia — ${page}`, url: wikiUrl(page) })),
    { label: "Riot Data Dragon — champions", url: `${DDRAGON_BASE}/api/versions.json` },
  ];

  const answer: Answer = {
    title: `${player.player} aux ${e!.league === "World Championship" ? "Worlds" : e!.league}`,
    summary,
    rows,
    sources,
    followUps: [
      `${player.player} aux Worlds ${bestRows[0]?.year ?? rows[rows.length - 1].year}`,
      ...teammates.map((m) => `Résultats de ${m} à tous les Worlds`),
    ],
    notes: state.notes,
  };
  return {
    answer,
    trace: [
      t({
        node: "format",
        status: "ok",
        title: `Tableau de ${rows.length} lignes, synthèse (${summaryBy}), ${sources.length} sources`,
      }),
    ],
  };
}

// Wiring -----------------------------------------------------------------------
export const graph = new StateGraph(State)
  .addNode("understand", understand)
  .addNode("build_query", buildQuery)
  .addNode("guard", guard)
  .addNode("execute", execute)
  .addNode("correct", correct)
  .addNode("format", format)
  .addEdge(START, "understand")
  .addConditionalEdges("understand", (s: S) => (s.entities?.players.length ? "build_query" : "format"), [
    "build_query",
    "format",
  ])
  .addEdge("build_query", "guard")
  .addConditionalEdges("guard", (s: S) => (s.guardIssues.length ? "correct" : "execute"), ["correct", "execute"])
  .addConditionalEdges("execute", (s: S) => (s.execError || !s.rows?.length ? "correct" : "format"), [
    "correct",
    "format",
  ])
  .addConditionalEdges("correct", (s: S) => (s.exhausted ? "format" : "guard"), ["guard", "format"])
  .addEdge("format", END)
  .compile();

export type GraphUpdate = { node: string; trace: TraceEntry[]; answer: Answer | null };

/** Streams one event per executed node. */
export async function* runAgent(question: string): AsyncGenerator<GraphUpdate> {
  const stream = await graph.stream({ question }, { streamMode: "updates", recursionLimit: 25 });
  for await (const chunk of stream) {
    for (const [node, update] of Object.entries(chunk as Record<string, Partial<S>>)) {
      yield { node, trace: update.trace ?? [], answer: update.answer ?? null };
    }
  }
}
