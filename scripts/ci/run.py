"""Run the selected checks as two chains side by side and collect every exit status."""
import concurrent.futures
import json
import os
from pathlib import Path
import signal
import subprocess
import time

selected = json.loads(Path(os.environ["RUNNER_TEMP"], "ci-jobs.json").read_text())
questions = json.loads(Path("eval/questions.json").read_text())["questions"]
only = ",".join(q["id"] for q in questions if "timeline" not in q["tags"])
commands = {
    "load": ["bun", "run", "db:load", "--allow-older-summaries"],
    "typecheck": ["bun", "run", "typecheck", "--incremental", "false"],
    "build": ["bash", "-e", "-o", "pipefail", "-c", "bunx --no-install next build && bun run size"],
    "lint": ["bun", "run", "lint", "--deny-warnings"],
    "test": ["python3", "scripts/ci/test.py"],
    "eval": ["bun", "run", "eval", "--deterministic", "--strict", "--follow-ups", f"--only={only}"],
}
# The tests create their own schemas and never read the loaded rows: they start at once, beside the load the type
# check, the build and the eval wait for (docs/adr/0113-ci-check-scheduling.md).
readers = [name for name in ("typecheck", "build", "eval") if name in selected]
chains = [
    [name for name in ("lint", "test") if name in selected],
    (["load"] if readers else []) + readers,
]


def run(name):
    log = Path(os.environ["RUNNER_TEMP"], f"ci-{name}.log")
    started = time.monotonic()
    with log.open("w") as out:
        process = subprocess.Popen(commands[name], stdout=out, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            code = process.wait(timeout=480)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            code = 124
    return name, code, log, round(time.monotonic() - started)


def run_chain(names):
    results = []
    for name in names:
        if name in readers and any(done == "load" and code != 0 for done, code, _, _ in results):
            results.append((name, None, None, 0))
        else:
            results.append(run(name))
    return results


failed = False
with concurrent.futures.ThreadPoolExecutor(max_workers=len(chains)) as pool:
    for results in pool.map(run_chain, chains):
        for name, code, log, seconds in results:
            if code is None:
                print(f"{name}: not run, the database did not load", flush=True)
                failed = True
                continue
            print(f"::group::{name} (exit {code}, {seconds} s)", flush=True)
            print(log.read_text(), flush=True)
            print("::endgroup::", flush=True)
            failed |= code != 0
raise SystemExit(1 if failed else 0)
