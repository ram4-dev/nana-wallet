# Authenticated embedding inference specification

## Purpose

One bounded remote model contract for documents and queries.

## Requirements

### Requirement: I1 Complete model identity

Documents and queries MUST use OpenAI text-embedding-3-small, dimensions=384, canonical text revision nana-text-v1, L2 normalization and epoch1; incompatible vectors MUST NOT mix.

#### Scenario: I1a Compatible request

- GIVEN recipient, fact and query text
- WHEN inference is requested
- THEN fixed model/dimensions and revisioned canonicalization apply to each input.

#### Scenario: I1b Invalid provider result

- GIVEN wrong model/index/count/dimensions, nonfinite values or zero norm
- WHEN a provider response arrives
- THEN it is rejected without making a source ready or authorizing search.

### Requirement: I2 Text bounds and privacy

Inference MUST accept only nonempty canonical text up to 6000 UTF-8 bytes without truncation. Dedicated addresses, wallet fields and provenance MUST be excluded.

#### Scenario: I2a Canonical parity

- GIVEN accented/decomposed Spanish names, whitespace or empty descriptions
- WHEN document/query canonicalization runs
- THEN approved normalization/redaction is deterministic and accent-preserving.

#### Scenario: I2b Oversize or empty text

- GIVEN empty or oversized canonical input
- WHEN indexing or query inference runs
- THEN indexing fails safely or retrieval is unavailable; saved business data remains intact.

### Requirement: I3 Function-scoped authentication

Query and drain MUST authenticate distinct credentials before parsing or side effects. Callers MUST NOT choose provider, model, table or URL.

#### Scenario: I3a Wrong-scope credential

- GIVEN absent, incorrect or opposite-function credentials
- WHEN either endpoint receives a request
- THEN authentication fails before parsing, provider calls or job claims.

#### Scenario: I3b Arbitrary execution input

- GIVEN authenticated input specifying unsupported fields or a destination
- WHEN a handler validates it
- THEN it rejects the request without performing arbitrary work.

### Requirement: I4 Bounded resource use

Query MUST finish within three seconds without unbounded retries. Drain MUST bound batch4, concurrency2, provider15s, invocation45s and lease90s, with one globally leased run.

#### Scenario: I4a Slow provider and concurrent wakes

- GIVEN a hanging provider and duplicate drain invocations
- WHEN work starts
- THEN deadlines/cancellation apply, only the leased run claims, and late writes remain fenced.

#### Scenario: I4b Shared capacity exhausted

- GIVEN exhausted shared capacity or a global provider fault
- WHEN new query/drain work arrives
- THEN work is refused/deferred safely and drain cannot consume reserved query capacity.

### Requirement: I5 Secret and diagnostic separation

Only Edge MUST hold provider/admin credentials; backend and scheduler MUST receive only their scoped credentials. Diagnostics MUST exclude raw text, vectors and credentials.

#### Scenario: I5a Safe failure diagnostics

- GIVEN an error containing provider bodies or authorization data
- WHEN diagnostics are emitted
- THEN only allowlisted codes/counts/latencies are retained.

### Requirement: I6 Portable verification and remote wake

Local checks MUST cover the Edge tree and real handler lifecycle without live services. Remote scheduling MUST use one drain-only authenticated wake after verification.

#### Scenario: I6a Local complete path

- GIVEN isolated SQL and controlled inference
- WHEN recipient and fact jobs traverse the real handler
- THEN ready vectors are produced without remote database/provider access.

#### Scenario: I6b Hosted acceptance

- GIVEN approved concrete deployment and verified capacity/authentication
- WHEN bounded synthetic rows are indexed by the scheduler and queried
- THEN both types match compatibly, cleanup is proven and no payment occurs.
