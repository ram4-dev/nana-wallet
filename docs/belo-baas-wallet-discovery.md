# Belo BaaS wallet discovery

## Finding

The public Belo as a Service API is an organization-level API. An `ApiKey` identifies an organization and grants access to that organization's balances, deposit addresses, transfers, swaps, transactions, and Belo Pay links.

The public API does not document endpoints to:

- create or manage end users;
- create a wallet or subaccount for an end user;
- assign an address or balance to an end user;
- manage private keys, signing, recovery, or wallet lifecycle;
- submit KYC data or read an end user's KYC status.

Nana must not treat the public BaaS API as a confirmed per-user wallet platform. It currently supports an organization treasury, payout, swap, or payment-link integration.

## Product requirement

Nana requires a wallet or account segregated and attributable to each user. An organization omnibus account with an internal ledger does not meet that requirement.

The integration can use Belo for user wallets only if Belo confirms, in the production agreement and a testable API contract, that it supports per-user wallets or accounts. The confirmation must cover provisioning, ownership, custody, lifecycle, balances, transaction history, limits, KYC, and reconciliation.

If Belo does not offer that product, Nana needs a provider that does. WDK can remain a development and testing tool, but a local WDK wallet does not solve the production account, KYC, fiat, or compliance model.

## Agentic operations

An agent can prepare and submit a BaaS operation on behalf of the organization. The agent must not receive the Belo `ApiKey` or operate directly from the browser.

The server flow is:

1. Authenticate the user and load their assigned wallet or account.
2. Enforce permissions, recipient checks, supported rails, and per-user limits.
3. Request a provider preview and store its expiry and idempotency key.
4. Show the preview and collect explicit user confirmation.
5. Confirm from the backend with the stored idempotency key.
6. Persist the provider transaction ID and reconcile `pending`, `success`, or `failed` states.

This flow is valid only after the provider confirms that the requested operation is authorized for the user's individual wallet or account. The public BaaS API does not establish that relationship today.

## KYC and regulatory questions

Belo's consumer product has a personal Cuenta Belo and identity verification. That is separate from the public BaaS API. It does not establish that Belo provides KYC as a service or that an integrator can create a consumer account for a Nana user.

Before handling user funds or enabling withdrawals, obtain written answers from Belo and Argentine counsel on:

- Whether BaaS supports per-user accounts or wallets, and which legal entity contracts with the user.
- Which party performs KYC, re-KYC, PEP and sanctions screening, source-of-funds checks, transaction monitoring, Travel Rule handling, record retention, and suspicious activity reporting.
- Which party has custody or key control, and how user assets and records are segregated and reconciled.
- Whether Nana or its operating entity must register as a PSAV for the planned activities. Belo's PSAV registration does not automatically cover the integrator.
- For ARS payment accounts, which PSPCP provides the account and which disclosures and operational restrictions apply.

This is an architecture and regulatory-risk note, not legal advice. The result depends on the final contracts and the actual control of funds, keys, balances, and transaction execution.

## Sources

- [Belo BaaS OpenAPI](https://b2b.stgbelo.app/api-docs-json)
- [Belo account creation](https://help.belo.app/es/articles/5717229-como-crear-una-cuenta-en-belo)
- [Belo general terms](https://help.belo.app/es/articles/5362779-terminos-y-condiciones-generales)
- [Law 25.246](https://www.argentina.gob.ar/normativa/nacional/ley-25246-62977/actualizacion)
- [CNV Resolution 1058](https://www.argentina.gob.ar/normativa/nacional/resoluci%C3%B3n-1058-2025-410635/texto)
- [UIF Resolution 49/2024](https://www.argentina.gob.ar/normativa/nacional/resoluci%C3%B3n-49-2024-397597/texto)
- [BCRA payment service provider rules](https://www.bcra.gob.ar/Pdfs/Texord/t-snp-psp.pdf)
