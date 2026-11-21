import { runAgent } from "../src/lib/agent/run";
import type { StepPart } from "../src/lib/agent/types";

const question = process.argv.slice(2).join(" ") || "résultats de Chovy à tous les Worlds";

console.log(`? ${question}\n`);

const printed = new Map<string, number>();
const t0 = performance.now();

const answer = await runAgent(question, (event) => {
  if (event.type !== "step") return;
  const part: StepPart = event.part;

  if (!printed.has(part.step)) console.log(`── ${part.step}`);
  const seen = printed.get(part.step) ?? 0;

  for (const e of part.entries.slice(seen)) {
    const level = e.level ? ` [${e.level}${e.confidence != null ? ` ${e.confidence.toFixed(2)}` : ""}]` : "";
    console.log(`   ${e.status.toUpperCase()}${level} ${e.title}`);

    if (e.detail) console.log(e.detail.replace(/^/gm, "       "));
  }

  printed.set(part.step, part.entries.length);

  if (part.state === "done")
    console.log(`   => ${part.status.toUpperCase()} ${part.title} (${Math.round(performance.now() - t0)} ms)\n`);
});

console.log(`# ${answer.title}\n`);

if (answer.rows.length)
  console.table(
    answer.rows.map((r) => ({
      année: r.year,
      équipe: r.team,
      place: r.place ? `${r.placeLabel} (${r.place})` : r.placeLabel,
      "V-D": `${r.wins}-${r.losses}`,
      champions: r.champions.map((c) => `${c.name} ×${c.games}`).join(", "),
    })),
  );

if (answer.table) console.table(answer.table.rows.map((r) => Object.fromEntries(answer.table!.columns.map((c, i) => [c, r[i]]))));

console.log(`\n${answer.summary}\n`);

for (const n of answer.notes) console.log(`note: ${n}`);

console.log("sources:");

for (const s of answer.sources) console.log(`  - ${s.label}: ${s.url}`);

console.log("suites possibles:");

for (const f of answer.followUps) console.log(`  - ${f}`);
