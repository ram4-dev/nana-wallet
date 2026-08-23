// @lovable.dev/vite-tanstack-config already includes the following. Do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

const isMobileBuild = process.env["NANA_MOBILE_BUILD"] === "1";

export default defineConfig({
  // The web build keeps Lovable's Cloudflare/Nitro output. Capacitor needs
  // TanStack's static client output so the native bundle contains index.html.
  ...(isMobileBuild ? { nitro: false } : {}),
  tanstackStart: {
    ...(isMobileBuild
      ? {
          spa: {
            enabled: true,
            prerender: { outputPath: "/index" },
          },
        }
      : {}),
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
});
