import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { affected, attribution, CHECKS, pushBase } from "./affected";

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
} else if (event.after && /^[a-f0-9]{40}$/.test(event.after)) {
  const after: string = event.after;
  let green: string[] = [];

  try {
    green = execFileSync("gh", ["api", `repos/${process.env.GITHUB_REPOSITORY}/actions/workflows/ci.yml/runs?branch=main&event=push&status=success&per_page=30`, "--jq", ".workflow_runs[].head_sha"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).split("\n").filter(Boolean);
  } catch (error) {
    console.log(`Could not list successful main runs: ${error instanceof Error ? error.message.split("\n")[0] : error}`);
  }

  const base = pushBase(green, after, sha => {
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", sha, after], { stdio: "ignore" });

      return true;
    } catch {
      return false;
    }
  }, sha => {
    try {
      return execFileSync("git", ["show", `${sha}:scripts/ci/select.ts`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).includes("pushBase(");
    } catch {
      return false;
    }
  });

  console.log(`Push range: ${base ?? "none"}..${after}`);

  if (base) selected = affected(execFileSync("git", ["diff", "--no-renames", "--name-only", "-z", `${base}..${after}`], { encoding: "utf8" }).split("\0").filter(Boolean));
  else console.log("No validated ancestor on main: every check runs.");
}

for (const check of CHECKS) appendFileSync(process.env.GITHUB_OUTPUT!, `${check}=${selected.has(check)}\n`);

appendFileSync(process.env.GITHUB_OUTPUT!, `any=${selected.size > 0}\n`);

writeFileSync(join(process.env.RUNNER_TEMP!, "ci-jobs.json"), JSON.stringify([...selected]));

console.log(`Selected checks: ${[...selected].join(", ") || "metadata only"}`);
