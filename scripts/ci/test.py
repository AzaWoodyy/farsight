"""Prove test isolation: one process per file, in the written order, then in a random order drawn for this run."""
import random
import subprocess
import sys
import time

seed = int(sys.argv[1]) if len(sys.argv) > 1 else random.SystemRandom().randrange(2**32)
commands = [["bun", "run", "test"], ["bun", "run", "test", "--randomize", f"--seed={seed}"]]
failed = False
for command in commands:
    started = time.monotonic()
    code = subprocess.run(command, check=False).returncode
    failed |= code != 0
    print(f"{' '.join(command[3:]) or 'written order'}: exit {code}, {round(time.monotonic() - started)} s", flush=True)
print(f"Replay this random order: python3 scripts/ci/test.py {seed}", flush=True)
raise SystemExit(1 if failed else 0)
