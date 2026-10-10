# Requirements
## Exact terminal result
The service MUST return the actual result produced by the financial task when resolveDecision waits for that task.
Scenario: Given a policy refusal and a financial task registry, when authenticated confirmation completes, then the caller receives policy_rejected and never transaction_receipt_invalid or a sent claim.
Scenario: Given a successful transfer, when the waiting task completes, then the caller receives the successful transaction result.
Scenario: Given uncertain dispatch, when the waiting task completes, then uncertainty remains uncertainty, and no redispatch occurs.
## Observation
Diagnostics MUST NOT include transcript text, tokens, keys or signatures. They MAY include timing, finality/authentication booleans, recognized decision and the gate outcome. The ordering and one-use invariant MUST remain unchanged.
