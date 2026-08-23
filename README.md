# WDK Transaction Agent

Backend-only HTTP agent for the Aleph Hackathon 2026 WDK Track: reads a WDK
wallet and sends tokens from natural-language instructions, backed directly
by the bundled `wdk-mcp` MCP server and an AI SDK `ToolLoopAgent`. See
`docs/wdk-agent-development-plan.md` for the full design and
`docs/api.md` / `docs/demo-runbook.md` for usage.

## Setup

```bash
cp .env.example .env
npm install
npm run dev
```

Server listens on `PORT` (default `3000`).

## Environment variables

| Var | Purpose |
| --- | --- |
| `OPENCODE_GO_API_KEY` | API key for OpenCode Go (opencode.ai/auth), used as the model provider. |
| `OPENCODE_GO_BASE_URL` | Defaults to `https://opencode.ai/zen/go/v1`. |
| `OPENCODE_GO_MODEL` | Defaults to `deepseek-v4-flash`. |
| `WDK_WALLET_NAME`, `WDK_NETWORK`, `WDK_TOKEN` | Supplied by Developer A once the demo wallet is set up. |
| `WDK_TOOLS_SOURCE` | `fixture` (default, no WDK required) or `live` (spawns the real `wdk-mcp` process). |
| `PORT` | Fastify port, default `3000`. |

## Scripts

- `npm run dev` — watch mode (`tsx`).
- `npm run build` / `npm start` — compile then run the built server.
- `npm test` — unit + integration tests (vitest), all against fixtures — no
  WDK wallet or model API key required.

## Notes

- Sessions are in-memory only — restarting the server clears all
  conversations and pending transfer previews.
- `WDK_TOOLS_SOURCE=fixture` is the default so the API and agent can be
  developed and tested without a live WDK wallet; switch to `live` once
  Developer A confirms `wdk-mcp` starts cleanly with the demo wallet
  unlocked.
