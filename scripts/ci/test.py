"""Prove test isolation: one process per file, then stable, reproducible random orders inside each file."""
import subprocess
import time

commands = [["bun", "run", "test"]]
commands += [["bun", "run", "test", "--randomize", f"--seed={seed}"] for seed in (2380133667, 0, 1, 42, 2026, 4294967295)]
failed = False
for command in commands:
    started = time.monotonic()
    failed |= subprocess.run(command, check=False).returncode != 0
    print(f"{' '.join(command[3:]) or 'normal order'}: {round(time.monotonic() - started)} s", flush=True)
raise SystemExit(1 if failed else 0)
