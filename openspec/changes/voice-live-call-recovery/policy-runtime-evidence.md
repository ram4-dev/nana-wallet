# Devnet policy evidence

Read-only SDK inspection found policy jb227q0o7d3hmf0ksbi3hj6e on additional signer np33q4k0i44p3g4kr2na0u9y for wallet mb8lz733x37gldmywtejfg14. The single ALLOW rule had Transfer.to IN only the wallet's own address, with Transfer.lamports LTE 10000000. Test1's persisted recipient is DFYT4RDcvr6vL46c7iVDmfBbEYQxAZhUxkgvwzuVHMEk, so it was not authorized even at 0.005 SOL.

User explicitly approved adding only Test1 through the pending permission question. An official SDK signed update was then applied using the existing sidecar. Before mutation, the current rules were asserted against the observed original to prevent replacing concurrent policy changes. Read-after-write verified exact rules and unchanged owner.

Current recipients: AfHaCDtRK27tYuDjUXE9Ch5QHHfiZBa3QEdDpQp8ZYGX and DFYT4RDcvr6vL46c7iVDmfBbEYQxAZhUxkgvwzuVHMEk. Single-transfer cap remains 10000000 lamports (0.01 SOL), method remains signAndSendTransaction. No transaction was broadcast by this update. No key material was read, printed or changed.

Rollback requires a separately authorized policy update removing only Test1; no automatic rollback or policy broadening is authorized.
