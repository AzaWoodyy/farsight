export type Schedule = {
  pick<T extends string>(at: string, options: readonly [T, ...T[]]): T;
  fault<T extends string>(at: string, healthy: T, faults: readonly T[]): T;
};

export type Counterexample = { steps: string[]; error: Error };

export type Exploration = { schedules: number; counterexample: Counterexample | null };

type Taken = { index: number; options: number; step: string };

export async function explore(faultBudget: number, limit: number, run: (schedule: Schedule) => Promise<void>): Promise<Exploration> {
  let prefix: number[] = [];

  for (let schedules = 1; schedules <= limit; schedules++) {
    const taken: Taken[] = [];
    let faultsLeft = faultBudget;

    const choose = <T extends string>(at: string, options: readonly T[]): T => {
      const index = prefix[taken.length] ?? 0;
      const chosen = options[index]!;
      taken.push({ index, options: options.length, step: `${at}: ${chosen}` });

      return chosen;
    };

    const schedule: Schedule = {
      pick: (at, options) => choose(at, options),
      fault: (at, healthy, faults) => {
        if (faultsLeft === 0 || faults.length === 0) return healthy;
        const chosen = choose(at, [healthy, ...faults]);

        if (chosen !== healthy) faultsLeft--;

        return chosen;
      },
    };

    try {
      await run(schedule);
    } catch (error) {
      return { schedules, counterexample: { steps: taken.map((t) => t.step), error: error instanceof Error ? error : new Error(String(error)) } };
    }

    let last = taken.length - 1;

    while (last >= 0 && taken[last]!.index + 1 >= taken[last]!.options) last--;

    if (last < 0) return { schedules, counterexample: null };
    prefix = [...taken.slice(0, last).map((t) => t.index), taken[last]!.index + 1];
  }

  throw new Error(`more than ${limit} schedules: lower the bound of the model`);
}
