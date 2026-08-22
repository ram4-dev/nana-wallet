# Proposal: Recipient Address Memory

## Intent and Outcome

Allow the conversational agent to understand recipient references such as "Lucas," "Lucas the electrician," or "my grandson," retrieve user-scoped long-term memory, and resolve one stored recipient before preparing a transfer. Ambiguous or weak semantic matches require clarification using human-readable descriptions.

## Scope

### In Scope

- Durable, user-scoped recipient records containing name, description, and address.
- A semantic index over recipient name and description, with the exact address retained as payload.
- User-scoped long-term facts for relationships and stable references such as "Lucas is my grandson."
- Agent tools for semantic recipient search, long-term-memory retrieval, and selected-address resolution.
- Intent interpretation and conversational disambiguation before transfer preview or confirmation.
- Traceability from the selected recipient record to the WDK `to` value.

### Out of Scope / Non-goals

- Unconfirmed creation or mutation of recipient records or durable user facts.
- Address-book imports, relationship graphs, or cross-user retrieval.
- Mainnet, cross-chain address selection, or changes to the WDK MCP boundary.
- Broadcasting a transfer without the existing preview and approval controls.

## Business Rules and Constraints

- Memory is durable application data scoped to the authenticated user, not hidden model memory.
- Before retrieval, the LLM MUST determine that the user intends a transfer and extract the recipient reference from the turn and relevant conversation context.
- `search_recipients` MUST semantically search name plus description. For relational phrases such as "my grandson," the agent MAY search recipients directly or call `search_user_memory` first, then search recipients using the resolved identity.
- Semantic similarity is candidate generation, not identity proof. Multiple or insufficient-confidence matches MUST require clarification.
- Candidate search MUST withhold addresses. Only `get_recipient_address` for the user-selected stable record MAY return the current exact address.
- Durable facts MAY be written only from user-provided information with explicit confirmation; payment addresses require explicit confirmation on create or update.
- The selected address MUST flow unchanged into the existing Sepolia USD₮ transfer candidate and remain subject to preview and confirmation.

## Capabilities

### New Capabilities

- `recipient-address-memory`: user-scoped long-term facts, semantic recipient retrieval, ambiguity handling, exact address resolution, and transfer handoff.

### Modified Capabilities

- None.

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| Application persistence | New | User facts and vector-indexed recipient records |
| Agent tools | New | Semantic memory search and exact address resolution |
| Conversation flow | New | Intent, relational references, and ambiguity handling |
| Transfer orchestration | Integration | Selected address becomes WDK `to` |

## Risks

| Risk | Mitigation |
|---|---|
| Wrong person selected by similarity | Never treat vector score as proof; clarify weak or multiple matches |
| Cross-user memory leak | Enforce authenticated-user scope on every memory operation |
| Hallucinated or stale address | Resolve exact payload by stable record only after selection |
| Sensitive facts exposed | Return only minimal matching descriptions and facts |

## Rollback Plan

Disable the lookup tool and name-based transfer intent, leaving explicit-address transfers unchanged. Retain recipient records for export or remove them through a separate, explicitly approved data operation.

## Success Criteria

- [ ] "Mandale plata a Lucas" semantically retrieves a unique Lucas and supplies only his current stored address to the transfer flow.
- [ ] "Mandale plata a mi nieto" uses recipient descriptions or user long-term memory to identify candidates.
- [ ] Multiple or weak matches cause a description-based clarification before any address lookup or preview.
- [ ] Missing recipients, invalid records, and cross-user data never produce a guessed address or transfer preview.
- [ ] The chosen record and exact address are traceable through transfer confirmation.
