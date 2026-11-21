import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { LAB_VARIANTS } from "../../src/app/lab/catalog";
import { runAgent } from "../../src/lib/agent/run";
import type { Answer, StepName, StepPart } from "../../src/lib/agent/types";

const out = resolve(import.meta.dirname, "../../public/lab-fixtures");

rmSync(out, { recursive: true, force: true });

if (process.env.VERCEL_ENV === "production") {
  console.log("lab:build: production build, no fixtures");
  process.exit(0);
}

delete process.env.OPENROUTER_API_KEY;

mkdirSync(out, { recursive: true });

export type LabFixture = { question: string; steps: StepPart[]; answer: Answer | null; error: string | null };

let bytes = 0;

for (const v of LAB_VARIANTS) {
  const steps = new Map<StepName, StepPart>();
  let answer: Answer | null = null;
  let error: string | null = null;

  try {
    answer = await runAgent(v.question, (event) => {
      if (event.type === "step") steps.set(event.part.step, event.part);
    });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const fixture: LabFixture = { question: v.question, steps: [...steps.values()], answer, error };
  const json = JSON.stringify(fixture);

  bytes += json.length;
  writeFileSync(resolve(out, `${v.id}.json`), json);

  const shown = answer
    ? [
        answer.rows.length && "rows",
        answer.table && `table(${answer.table.rows.length})`,
        ...(["timeline", "scoreboard", "versus", "teams", "roster", "champion", "pool", "runes", "series"] as const).filter((k) => answer[k]),
      ]
        .filter(Boolean)
        .join("+") || "texte"
    : `erreur: ${error}`;

  console.log(`${v.id.padEnd(24)} ${(answer?.meta.route ?? "-").padEnd(22)} ${shown.padEnd(28)} ${(json.length / 1024).toFixed(0)} Ko`);
}

console.log(`lab:build: ${LAB_VARIANTS.length} fixtures, ${(bytes / 1024 / 1024).toFixed(2)} Mo`);
