import { defineConfig } from "evalite/config";

// LLM-backed evals (real mode) need more than the 30s default.
export default defineConfig({
  scoreThreshold: 0,
  testTimeout: 300000,
});
