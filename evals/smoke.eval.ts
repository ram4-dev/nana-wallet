import { evalite } from "evalite";

/**
 * Smoke eval: verifies the evalite harness itself is wired up correctly
 * (config discovery, runner, scoring, persistence). Replace with real
 * agent/voice evals in later slices.
 */
evalite("Smoke: harness wiring", {
  data: [
    { input: "hello", expected: "hello" },
    { input: "nana", expected: "nana" },
  ],
  task: async (input: string) => input,
  scorers: [
    {
      name: "exact_match",
      scorer: ({ input, output }) => ({ score: output === input ? 1 : 0 }),
    },
  ],
});