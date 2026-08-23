import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Config propia y separada de vite.config.ts a proposito: la config de la app arrastra
// el plugin de TanStack Start y el build de nitro, que no hacen falta para tests unitarios
// y solo agregan formas de romperse.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
