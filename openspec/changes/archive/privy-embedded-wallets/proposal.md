# Proposal: Privy Embedded Wallets

Revision: 2026-09-08-r3. Product decisions confirmed by the user: limited backend signer, Privy recovery and Arc Testnet. Depends on privy-multi-user-foundation including PMU-020..026. Implementation explicitly authorized by the user on 2026-09-08. r3: the permission is indefinite and revocable; limits are 10 USDC per transfer and 50 USDC per rolling 3600 seconds, enforced only through Privy policy configuration (no local SQL spending cap; aggregate concurrency limitation accepted).

## Intent and Outcome

Each authenticated Nana user owns an embedded EVM wallet. Nana uses its verified binding for wallet reads and agent payments. The user grants a bounded, revocable backend signer; every payment still requires preview and explicit confirmation. Recovery uses Privy and preserves the wallet.

## Scope

- Idempotent creation/recovery, server-verified ownership and RLS-protected binding.
- Separate signer enrollment with the indefinite revocable permission: 10 USDC per transfer and 50 USDC per rolling 3600 seconds, recipients and gas ceiling, all enforced through Privy policy configuration; revocation and policy integrity checks.
- Arc Testnet only, chain 5042002: USDC ERC-20 interface at 0x3600000000000000000000000000000000000000, 6 decimals; native gas accounting uses 18 decimals.
- Durable user/wallet-scoped preview, confirmation, signing, broadcast and reconciliation; no fallback to shared funded providers.
- Text/voice parity, account-transition isolation and deterministic plus live verification.

## Non-goals

Per-payment browser signing, mainnet, ZeroDev, offline autonomous payments, migration of existing WDK/Circle funds, Nana-managed recovery secrets and Capacitor certification. Signing authorization does not permit private-key export or policy escalation.

## Delivery and Rollback

Identity foundation must be verified first. A bounded SDK/policy/Arc compatibility probe precedes the provider implementation. Use chained slices with applicable checks per slice and final browser/live evidence. If an essential provider restriction is unsupported, stop enabling that capability and record the blocker; do not replace it with unlimited signing.

Rollback disables new grants/payments and revokes the backend signer where possible; retain bindings and reconcile already signed/submitted attempts. Never delete users/wallets, change owners, replay uncertain payments or fall back to the singleton wallet. Fixtures remain explicitly selectable.
