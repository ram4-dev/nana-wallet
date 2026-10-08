# Requirements

## Private provisioning

The setup MUST accept only a Circle test API key. It MUST NOT print secrets,
commit them, replace an existing entity secret, or use another project's keys.
It MUST persist generated secrets privately before registration, preserve the
recovery file, and reuse persisted idempotency keys for wallet creation.
It MUST stop after an ambiguous registration result until checked manually.

## Testnet wallet

The wallet MUST be an EOA on ARC-TESTNET. The setup MUST print only public wallet
metadata. It MUST NOT transfer funds. Funding is performed by the user.

## Subsequent payment demo

Payments MUST require preview, explicit confirmation, a permitted recipient,
a small amount limit and idempotency. Confirmation MUST require chain evidence.
Unknown execution MUST NOT be reported as a definite failure or retried as a
new payment. Full modular wallet integration is out of scope for this demo.
