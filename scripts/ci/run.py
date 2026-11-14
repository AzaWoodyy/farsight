"""Run independent checks with two workers and collect every exit status."""
import concurrent.futures
import json
import os
from pathlib import Path
import signal
import subprocess

selected = json.loads(Path(os.environ["RUNNER_TEMP"], "ci-jobs.json").read_text())
questions = json.loads(Path("eval/questions.json").read_text())["questions"]
only = ",".join(q["id"] for q in questions if "timeline" not in q["tags"])
commands = {
    "build": ["bash", "-e", "-o", "pipefail", "-c", "bunx --no-install next build && bun run size"],
    "lint": ["bun", "run", "lint", "--deny-warnings"],
    "test": ["python3", "scripts/ci/test.py"],
    "eval": ["bun", "run", "eval", "--deterministic", "--strict", f"--only={only}"],
}


def run(name):
    log = Path(os.environ["RUNNER_TEMP"], f"ci-{name}.log")
    with log.open("w") as out:
        process = subprocess.Popen(commands[name], stdout=out, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            code = process.wait(timeout=240)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            code = 124
    return name, code, log


failed = False
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    for name, code, log in pool.map(run, [name for name in commands if name in selected]):
        print(f"::group::{name} (exit {code})", flush=True)
        print(log.read_text(), flush=True)
        print("::endgroup::", flush=True)
        failed |= code != 0
raise SystemExit(1 if failed else 0)
