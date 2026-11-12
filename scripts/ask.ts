/**
 * Ask the agent from the terminal and print the graph trace + answer.
 *   bun run ask "résultats de Chovy à tous les Worlds"
 */
import { runAgent } from "../src/lib/agent/graph";

const question = process.argv.slice(2).join(" ") || "résultats de Chovy à tous les Worlds";
console.log(`? ${question}\n`);

for await (const update of runAgent(question)) {
  for (const e of update.trace) {
    console.log(`[${e.node}] ${e.status.toUpperCase()} ${e.title}`);
    if (e.detail) console.log(e.detail.replace(/^/gm, "    "));
  }
  if (update.answer) {
    const a = update.answer;
    console.log(`\n# ${a.title}\n`);
    console.table(
      a.rows.map((r) => ({
        année: r.year,
        équipe: r.team,
        place: r.place ? `${r.placeLabel} (${r.place})` : r.placeLabel,
        "V-D": `${r.wins}-${r.losses}`,
        champions: r.champions.map((c) => `${c.name} ×${c.games}`).join(", "),
      })),
    );
    console.log(`\n${a.summary}\n`);
    for (const n of a.notes) console.log(`note: ${n}`);
    console.log("sources:");
    for (const s of a.sources) console.log(`  - ${s.label}: ${s.url}`);
    console.log("suites possibles:");
    for (const f of a.followUps) console.log(`  - ${f}`);
  }
}
