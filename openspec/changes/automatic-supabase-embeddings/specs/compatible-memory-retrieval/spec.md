# Compatible memory retrieval specification

## Purpose

Honest search availability and safe recipient identity during asynchronous indexing.

## Requirements

### Requirement: R1 Provider-independent exact lookup

Exact folded-name lookup MUST run before inference, inspect every active owner match and preserve ambiguity regardless of indexing state or ranking limit.

#### Scenario: R1a Unique accented name during outage

- GIVEN one owner match for Sofía/Sofia while indexing/provider is unavailable
- WHEN that exact saved name is requested
- THEN lexical resolution succeeds without inference or a fabricated cosine score.

#### Scenario: R1b Duplicate beyond top five

- GIVEN multiple folded matches including one outside the semantic top five
- WHEN the name is requested
- THEN clarification is required without selecting a recipient.

### Requirement: R2 Complete compatible candidate snapshot

After query inference, each domain MUST evaluate readiness and candidates in one snapshot. Every active row MUST be ready with nonnull valid vector and actual=desired=requested revision; otherwise retrieval MUST be unavailable.

#### Scenario: R2a Competitor arrives during inference

- GIVEN an earlier successful precheck
- WHEN another connection inserts, reactivates or edits a competitor into pending before final selection
- THEN recipient and fact searches return unavailable from their final snapshots.

#### Scenario: R2b Complete snapshot control

- GIVEN only compatible ready active rows for the owner
- WHEN the final snapshot selects candidates
- THEN valid results may be returned without an open transaction during preceding HTTP.

### Requirement: R3 Honest failure and emptiness

Pending, failed, incompatible or provider-failed retrieval MUST NOT become successful empty evidence. Empty fact domains MAY return empty success.

#### Scenario: R3a Failed fact or query provider

- GIVEN failed/incompatible active facts or query inference failure
- WHEN facts are requested
- THEN unavailable is returned, with no claim that facts do not exist.

#### Scenario: R3b Empty domain

- GIVEN no active facts for the owner
- WHEN retrieval evaluates that snapshot
- THEN it may return empty success without using another owner's facts.

### Requirement: R4 Calibrated interpretation

Uncalibrated semantic selections MUST remain clarification-only. Approved name/description/prefix and relationship safeguards MUST remain effective after calibration.

#### Scenario: R4a Unvalidated thresholds

- GIVEN OpenAI vectors without accepted Spanish corpus evidence
- WHEN a semantic candidate ranks first
- THEN ranking alone cannot authorize recipient selection.

#### Scenario: R4b Ambiguous relationship

- GIVEN competing identities or unrelated distractors in a complete compatible domain
- WHEN semantic matching runs
- THEN corpus-approved thresholds/margins and relationship evidence prevent incorrect automatic selection.

### Requirement: R5 Wallet authority and interface preservation

Writes MUST retain explicit confirmation, policy transaction clients, idempotency and version checks. Candidates MUST omit addresses; selected recipient use MUST revalidate version/network before preview and explicit payment confirmation.

#### Scenario: R5a Save during provider outage

- GIVEN an authorized confirmed save with unavailable inference
- WHEN the business transaction commits
- THEN the save succeeds with pending indexing and unchanged confirmation/policy guarantees.

#### Scenario: R5b Recipient changes after selection

- GIVEN lexical or semantic selection of an ID/version
- WHEN the address/version changes before preview
- THEN existing revalidation prevents use of stale recipient information.

### Requirement: R6 Tenant and interface boundaries

Both retrieval domains MUST scope to the authenticated internal owner; rollout MUST preserve existing HTTP payloads and frontend/backend separation.

#### Scenario: R6a Cross-owner search

- GIVEN another owner's exact match or ready semantic candidate
- WHEN text or voice searches as the current owner
- THEN neither that row nor its address is returned.
