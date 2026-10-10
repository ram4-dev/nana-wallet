# Requirements
## Exact terminal result
The service MUST return the actual result produced by the financial task when resolveDecision waits for that task.
Scenario: Given a policy refusal and a financial task registry, when authenticated confirmation completes, then the caller receives policy_rejected and never transaction_receipt_invalid or a sent claim.
Scenario: Given a successful transfer, when the waiting task completes, then the caller receives the successful transaction result.
Scenario: Given uncertain dispatch, when the waiting task completes, then uncertainty remains uncertainty, and no redispatch occurs.
## Observation
Diagnostics MUST NOT include transcript text, tokens, keys or signatures. They MAY include timing, finality/authentication booleans, recognized decision and the gate outcome. The ordering and one-use invariant MUST remain unchanged.
## Delayed final transcription
The voice decision tool MUST allow a bounded wait for final authenticated evidence already in flight instead of refusing merely because the tool call outran transcription. It MUST NOT authorize without that evidence, reuse consumed evidence, or accept speech before the preview.
Scenario: Given a persisted preview and a tool call 48 ms before final affirmative transcription, when final authenticated evidence arrives within the 2-second bound, then that same tool call completes confirmation once without another utterance.
Scenario: Given no qualifying final evidence, when the bound expires, then confirmation is refused without broadcast.
Scenario: Given preview replacement or clearing during a wait, when the old transcription arrives, then the old decision request is refused and never consumes the new preview's evidence.
Scenario: Given one consumed decision and another tool call or late duplicate event for that preview, then no second decision is authorized until a new preview exists.
