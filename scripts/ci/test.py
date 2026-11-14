"""Prove test isolation with stable, reproducible random orders."""
import subprocess

commands = [["bun", "test", "scripts"]]
commands += [["bun", "test", "scripts", "--randomize", f"--seed={seed}"] for seed in (2380133667, 0, 1, 42, 2026, 4294967295)]
failed = False
for command in commands:
    failed |= subprocess.run(command, check=False).returncode != 0
raise SystemExit(1 if failed else 0)
