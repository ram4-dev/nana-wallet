# syntax=docker/dockerfile:1

# ============================================================================
# Build stage — compile TypeScript and (optionally) bake the embedding model.
# Base image matches package.json "engines": node >=22.18.0.
# ============================================================================
FROM node:22.18-bookworm AS build
WORKDIR /app

# Install all dependencies (including dev) so `tsc` and `tsx` are available.
# The @tetherto/wdk-cli postinstall must run: package.json `allowScripts`
# whitelists it so its bundled CLI is usable at runtime (live mode).
COPY package.json package-lock.json ./
RUN npm ci

# Compile TS -> dist/ (tsconfig.json: outDir dist, rootDir src, module NodeNext).
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Optionally bake the recipient-memory embedding model so the image is
# self-contained and needs no network at runtime.
#   `npm run memory:prefetch` (src/memory/prefetch.ts) runs WITHOUT credentials:
#   readRecipientMemoryConfig() defaults RECIPIENT_MEMORY_ENABLED to false, so
#   no DATABASE_URL is required. It downloads the pinned model
#   into the default cache dir (.cache/recipient-memory-model).
#   Gated by a build arg because it pulls ~120MB from HuggingFace at build time.
ARG EMBED_MODEL_PREFETCH=0
RUN mkdir -p /app/.cache/recipient-memory-model
RUN if [ "$EMBED_MODEL_PREFETCH" = "1" ]; then npm run memory:prefetch; fi

# ============================================================================
# Runtime stage — slim node image, production deps only, dist + model cache.
# ============================================================================
FROM node:22.18-bookworm-slim AS runtime
WORKDIR /app

# NOTE: NODE_ENV is intentionally NOT set here. The API config
# (src/config/process.ts) treats NODE_ENV=production as a hard gate that
# requires DATABASE_URL, PRIVY_APP_ID + PRIVY_VERIFICATION_KEY, and
# LIVE_VOICE_BINDING_PRIVATE_KEY. The
# local compose dev flow must NOT hit that gate; the same image becomes
# production-ready when those vars are provided by a deployment.

# Production dependencies only. `npm ci --omit=dev` is a clean, reproducible
# install in the runtime base image (same linux/x64 arch as the build stage).
# The native prod modules here ship prebuilt binaries, so no toolchain is needed:
#   - @huggingface/transformers -> onnxruntime-node (prebuilt .node per platform)
#   - @livekit/agents -> @livekit/local-inference (platform optionalDependencies)
#   - sharp (transitive) -> @img/sharp-* prebuilt binaries
# The install still needs network at build time to fetch those prebuilt binaries.
# better-sqlite3 is a DEV-ONLY transitive dependency (pulled in by `evalite`,
# marked `dev: true` in package-lock.json); it is not needed by the production
# runtime and is therefore not installed here.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Build output and (optionally) the baked embedding model cache.
COPY --from=build /app/dist ./dist
COPY --from=build /app/.cache ./.cache

# Demo seed data (no credentials — see README). Used by dist/memory/seed.js.
COPY examples ./examples

# Entrypoint dispatches the single image between the API and the voice worker.
COPY docker/entrypoint.sh ./docker/entrypoint.sh
RUN chmod +x ./docker/entrypoint.sh

# The runtime writes to the model cache dir (lazy download when not baked);
# keep it owned by the non-root `node` user.
RUN mkdir -p /app/.cache/recipient-memory-model && chown -R node:node /app/.cache

USER node
EXPOSE 3000

ENTRYPOINT ["docker/entrypoint.sh"]
CMD ["api"]
