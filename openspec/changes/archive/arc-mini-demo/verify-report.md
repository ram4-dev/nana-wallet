# Mini demo verification

- `npm ci --ignore-scripts --no-audit --no-fund` completed successfully.
- Isolated demo tests: 21 passed, no skipped or failed tests.
- Node syntax checks passed for all demo modules and browser JavaScript.
- Final server restart preserved the confirmed proof without another send.
  A stale process lock from the prior stop was removed only after checking
  that no server process or port listener remained. The payment diary was kept.

- The browser preview required explicit confirmation before dispatch.
- One approved transfer of 0.000001 USDC was confirmed on Arc Testnet.
- Hash: `0xc1176e910751c6851109a62642fbb0e34a105c184dae35c6599bb08964c96bc0`.
- Independent RPC checked chain ID 5042002, receipt status 0x1, sender, USDC
  contract, destination and ERC20 calldata amount 1 (six decimal places).
- Sender nonce after this proof was 1. No additional payment was needed.
- Browser screenshots of initial and confirmed desktop states were opened and
  visually inspected. Browser error collection was empty.
- Backend suite: 329 passed, 19 skipped, 64 files passed and 9 skipped.
- Backend lint and typecheck passed. Lint covers the existing src/tests scope;
  isolated demo scripts are covered separately by Node tests and syntax checks.
- Fixture evals: 16 across 7 files, score 100%. Real voice calls were skipped.
- Database-dependent tests were skipped without the local database. No database
  integration or main product frontend code was changed.
- A missing LiveKit platform binding initially prevented three backend suites
  from loading. The lockfile preserves all original optional binding entries;
  installation and validation were repeated after restoring them.
- Local secrets and recovery remain ignored by Git with private permissions.
- Partner setup reuses existing wallet metadata and entity secret. It does not
  register another secret or provision additional wallets.

Scope: isolated guided written UI, not an LLM, voice integration, modular wallet,
or full migration of the existing WalletProvider. WDK remains unchanged.
