import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { affected, attribution, CHECKS } from "./affected";

const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH!, "utf8"));
let selected = new Set(CHECKS);

if (event.pull_request) {
  const pr = event.pull_request;
  const base = pr.base.sha;
  const head = pr.head.sha;

  if (![base, head].every(sha => /^[a-f0-9]{40}$/.test(sha))) throw new Error("Invalid commit SHA");
  const commits = execFileSync("git", ["log", "--format=%an <%ae>%n%cn <%ce>%n%B", `${base}..${head}`], { encoding: "utf8" });

  if (attribution.test(`${commits}\n${pr.title ?? ""}\n${pr.body ?? ""}`)) throw new Error("Generation attribution in commit or PR metadata");
  const paths = execFileSync("git", ["diff", "--no-renames", "--name-only", "-z", `${base}...${head}`], { encoding: "utf8" }).split("\0").filter(Boolean);
  selected = affected(paths);
} else if (event.before && event.after && /^[a-f0-9]{40}$/.test(event.before) && !/^0+$/.test(event.before) && /^[a-f0-9]{40}$/.test(event.after)) {
  // main uses the pushed range, so unrelated merges also keep the pinned DB.
  const paths = execFileSync("git", ["diff", "--no-renames", "--name-only", "-z", `${event.before}..${event.after}`], { encoding: "utf8" }).split("\0").filter(Boolean);
  selected = affected(paths);
}

for (const check of CHECKS) appendFileSync(process.env.GITHUB_OUTPUT!, `${check}=${selected.has(check)}\n`);

appendFileSync(process.env.GITHUB_OUTPUT!, `any=${selected.size > 0}\n`);

writeFileSync(join(process.env.RUNNER_TEMP!, "ci-jobs.json"), JSON.stringify([...selected]));

console.log(`Selected checks: ${[...selected].join(", ") || "metadata only"}`);
