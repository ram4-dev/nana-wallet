# Automatic embedding lifecycle specification

## Purpose

Durable indexing of confirmed owner data without changing wallet authority.

## Requirements

### Requirement: L1 Transactional automatic generation

After activation, both source types MUST create pending work atomically with committed eligible writes, without inference/network calls in wallet transactions.

#### Scenario: L1a Committed recipient and fact

- GIVEN activated indexing and valid confirmed recipient/fact inputs
- WHEN either is inserted directly or through the application without a vector
- THEN business data and one current-generation job commit together.

#### Scenario: L1b Transaction failure

- GIVEN a source mutation with its queued work
- WHEN its transaction rolls back or outbox persistence fails
- THEN neither source mutation nor new job commits.

### Requirement: L2 Independent lifecycle

Content, active status and target revision changes MUST advance indexing generation; completion MUST NOT change business versions/history, policy, grants or confirmation.

#### Scenario: L2a Changed or reactivated source

- GIVEN existing work for a source
- WHEN text, active status or target revision changes
- THEN previous work becomes unusable and active content requires fresh indexing.

#### Scenario: L2b Completion and deletion

- GIVEN current or deleted source data
- WHEN indexing finishes
- THEN only current indexing metadata changes; deleted data is never resurrected.

### Requirement: L3 Fenced worker authority

Success/failure MUST match owner, kind, ID, generation, target revision, active source and current unexpired claim token.

#### Scenario: L3a Late or forged result

- GIVEN an edited, archived, deleted or reclaimed source/job
- WHEN an old, wrong-owner or expired-token result arrives
- THEN neither the current source nor its newer work changes.

#### Scenario: L3b Current completion

- GIVEN matching active source and unexpired claim
- WHEN a valid result completes
- THEN exactly that generation becomes ready once.

### Requirement: L4 Bounded recovery

Jobs MUST survive crashes, retry transient errors at most five attempts per generation, and isolate permanent failures; global credential/quota faults MUST pause processing.

#### Scenario: L4a Crash and poison work

- GIVEN expired work and a permanently invalid row
- WHEN draining resumes
- THEN expired work is reclaimable and healthy rows progress independently.

#### Scenario: L4b Exhaustion or global fault

- GIVEN exhausted retries or invalid provider credentials
- WHEN another attempt is considered
- THEN exhausted rows stay failed or global claims pause; manual retry is explicit and fenced.

### Requirement: L5 Protected owner data

Normal clients MUST retain owner isolation and MUST NOT forge indexing metadata, access private jobs or execute worker operations.

#### Scenario: L5a Unauthorized mutation

- GIVEN another owner, missing owner context or a normal application/client role
- WHEN protected reads/writes or worker operations are attempted
- THEN access is denied without disclosing another owner's data.

### Requirement: L6 Safe expansion and promotion

Dormant expansion MUST preserve legacy vectors and writers/readers. Activation MUST follow verified complete components, fresh remote inventory and controlled writer pause.

#### Scenario: L6a Dormant compatibility

- GIVEN legacy rows/writers and disabled activation
- WHEN additive migrations and old writes run
- THEN old behavior/model identity survives and no worker claims start.

#### Scenario: L6b Changed inventory or rollback

- GIVEN new remote data, incomplete verification or an activation incident
- WHEN promotion or recovery is attempted
- THEN promotion stops or claims stop; data/jobs remain, and incompatible legacy readers stay disabled.
