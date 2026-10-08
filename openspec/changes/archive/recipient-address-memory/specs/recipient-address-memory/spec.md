# Recipient Address Memory Specification

## Purpose

Define user-scoped semantic recipient resolution for the existing Sepolia USD₮ transfer flow.

## Requirements

### Requirement: RAM-001 Durable, Isolated Memory

Recipients MUST durably retain stable ID, name, description, and exact address; facts MUST retain user-provided relationships. Every operation MUST enforce authenticated-user scope without revealing other users' data or existence.

#### Scenario: Cross-user isolation

- GIVEN two users each store Lucas
- WHEN one searches or resolves Lucas
- THEN only their records are observable

#### Scenario: Missing authentication

- GIVEN authentication is absent
- WHEN a memory tool runs
- THEN it returns or changes no data

### Requirement: RAM-002 Intent and Recipient Reference

The agent MUST detect transfer intent and extract a recipient reference from the turn and relevant context before retrieval. Unrelated requests MUST NOT trigger resolution.

#### Scenario: Current-turn name

- GIVEN “Send money to Lucas”
- WHEN intent is interpreted
- THEN the extracted recipient reference is `Lucas`

#### Scenario: Contextual reference

- GIVEN context identifies Lucas the electrician
- WHEN asked “Send him money”
- THEN that contextual reference is searched

### Requirement: RAM-003 Semantic Recipient Candidate Search

`search_recipients` MUST semantically search current-user names and descriptions. Similarity MUST only generate candidates. Results MUST contain stable IDs and minimal matching evidence; exact address payloads MUST NOT be embedded or returned.

#### Scenario: Description-qualified search

- GIVEN two Lucas records have different descriptions
- WHEN searching `Lucas the electrician`
- THEN matching evidence returns without addresses

#### Scenario: Candidate set is unsafe

- GIVEN multiple, weak, contradictory, or stale results
- WHEN evaluated
- THEN the agent asks description-based clarification
- AND does not call `get_recipient_address`

### Requirement: RAM-004 User-Relative Fact Retrieval

`search_user_memory` MUST return only minimal relevant current-user facts. A relational reference MAY search recipients directly or retrieve facts first; facts MUST remain candidate evidence, not identity proof.

#### Scenario: Grandson resolution path

- GIVEN confirmed memory says `Lucas is my grandson`
- WHEN asked “Send money to my grandson”
- THEN `Lucas` MAY become the search reference
- AND one recipient still MUST be resolved

#### Scenario: Conflicting relationship facts

- GIVEN facts name different grandsons
- WHEN `search_user_memory` runs
- THEN clarification occurs without address resolution

### Requirement: RAM-005 Confirmed Durable Writes

`write_user_memory` MUST persist only user-provided facts or recipients after explicit confirmation. Address creation or change MUST confirm the exact address. Rejection, missing confirmation, or invalid data MUST preserve memory unchanged.

#### Scenario: Confirmed relationship write

- GIVEN the user states Lucas is their grandson
- WHEN the displayed fact is confirmed
- THEN `write_user_memory` MAY persist it

#### Scenario: Unconfirmed address update

- GIVEN an address lacks exact confirmation
- WHEN writing is attempted
- THEN no record changes

### Requirement: RAM-006 Resolution Outcomes and Grounding

No match, failure, or insufficient evidence MUST stop resolution without address or preview. The agent MUST NOT recall, infer, guess, or substitute addresses. One stable record MUST precede `get_recipient_address`.

#### Scenario: No candidate

- GIVEN no usable candidate
- WHEN searches complete
- THEN no match, address, or preview results

#### Scenario: One grounded record

- GIVEN evidence identifies one stable ID
- WHEN resolution completes
- THEN only that ID MAY resolve an address

### Requirement: RAM-007 Exact Address Handoff and Compatibility

`get_recipient_address` MUST return the exact current address only for the authenticated user's resolved ID. Revalidation before preview and confirmation MUST invalidate changed, missing, invalid, or mismatched selections and approvals. Existing WDK MCP, explicit-address, Sepolia USD₮, dry-run, and approval behavior MUST remain unchanged.

#### Scenario: Revalidated transfer

- GIVEN a resolved record remains valid
- WHEN preparing preview
- THEN WDK `to` equals its exact address
- AND existing controls apply

#### Scenario: Record changes after selection

- GIVEN a selection changes before preview or confirmation
- WHEN revalidated
- THEN selection and approval are invalidated
- AND resolution repeats
