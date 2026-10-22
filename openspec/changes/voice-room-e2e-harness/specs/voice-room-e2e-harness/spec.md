# Voice Room End-to-End Requirements

## Requirement: A real conversation is exercised end to end

The suite MUST join a LiveKit room with a host-side client, complete the worker's `bind_conversation` RPC with a valid binding token, receive the agent's audio, and publish caller audio that the agent acts on. A run that only creates a room or dispatches an agent MUST NOT be counted as voice-path coverage, because the worker awaits `ctx.waitForParticipant()` and then blocks on the binding RPC, so a dispatched but unjoined room produces the same result whether the agent works or not. The suite MUST NOT assert on the fact that the agent spoke as a substitute for asserting what the conversation did.

### Scenario: A published turn reaches the agent and is answered

- **GIVEN** a running isolated stack and a seeded fixture conversation
- **WHEN** the harness joins, binds, publishes a recorded user turn, and waits
- **THEN** the captured agent audio for both the greeting and the answer is non-silent
- **AND** the room transcript shows the caller's turn was heard

### Scenario: A dispatched but unjoined room proves nothing

- **GIVEN** an agent dispatched to a room with no other participant
- **WHEN** the run asserts on the dispatch identifier alone
- **THEN** that run MUST NOT be reported as covering the voice path

## Requirement: Turn boundaries are detected from the signal

Turn end MUST be derived from measured audio, never from a fixed delay. The decision MUST be a pure function of the captured frames, an energy threshold, and a trailing-silence duration, and it MUST have direct unit coverage independent of the room.

### Scenario: A turn ends on trailing silence

- **GIVEN** a window of captured frames whose energy exceeds the threshold and then falls to silence
- **WHEN** the detector evaluates the window
- **THEN** it reports the turn ended after the configured trailing silence
- **AND** it reports the offset of the first speech frame

### Scenario: A pause shorter than the threshold does not end the turn

- **GIVEN** a window whose silence never reaches the configured duration
- **WHEN** the detector evaluates it
- **THEN** it reports the turn has not ended

## Requirement: Credentials are injected explicitly

The suite MUST inject its credentials from the worktree environment file and MUST NOT depend on ambient values, because the root test isolation setup deletes those keys on purpose so ambient files cannot silently change behaviour.

### Scenario: Missing credentials fail loudly

- **GIVEN** no environment file and no ambient credentials
- **WHEN** the suite runs
- **THEN** it fails naming every missing key
- **AND** it MUST NOT skip

### Scenario: An unreachable stack names the fix

- **GIVEN** credentials present and the stack down
- **WHEN** the suite runs
- **THEN** it fails identifying the unreachable LiveKit address
- **AND** it prints the command that starts the isolated stack

## Requirement: A transfer is judged by the state it leaves

The suite SHALL judge a spoken transfer by the persisted state, not by the agent's narration. Asserting that the agent spoke cannot distinguish a transfer that happened from one that was narrated and never broadcast.

### Scenario: A confirmed transfer settles

- **GIVEN** a spoken transfer the user confirms
- **WHEN** the conversation ends
- **THEN** exactly one attempt row is at status `confirmed` and carries a transaction hash
- **AND** no attempt row is left in an active status

### Scenario: A cancelled transfer leaves nothing behind

- **GIVEN** a spoken transfer the user cancels
- **WHEN** the conversation ends
- **THEN** no attempt row is in an active status
- **AND** no attempt row reached `confirmed`

### Scenario: Cancellation assertions are non-vacuous

- **GIVEN** a cancellation scenario whose request turn never previewed a transfer
- **WHEN** the assertions run
- **THEN** the scenario MUST fail, because doing nothing MUST NOT read as a clean cancellation

### Scenario: Settlement is awaited, not assumed

- **GIVEN** the agent has acknowledged a confirmation
- **WHEN** the suite reads backend state
- **THEN** it waits for that state to stop changing while the room is still open
- **AND** it MUST NOT tear the session down or sleep a fixed interval in place of observing the state

## Requirement: Barge-in uses the application's own contract

Barge-in MUST be exercised through the `interrupt_agent` RPC the frontend calls, because in this product barge-in is a deliberate user action rather than acoustic detection. Assertions MUST cover both that the agent stopped and that the session survived; an interrupt that cuts audio while killing the session looks like success. Acoustic interruption belongs to the provider's voice activity detection and MUST NOT be asserted on; it MAY be recorded as evidence.

### Scenario: The agent yields mid-speech

- **GIVEN** the agent is speaking and has accumulated real speech
- **WHEN** the harness calls `interrupt_agent`
- **THEN** the RPC is accepted
- **AND** the agent's audio falls silent within the configured window

### Scenario: The conversation survives the interrupt

- **GIVEN** an interrupt was accepted and the agent fell silent
- **WHEN** the harness publishes a further recorded turn
- **THEN** the agent answers it with speech

### Scenario: Interrupting nothing proves nothing

- **GIVEN** the agent has not yet produced speech
- **WHEN** the harness evaluates whether to interrupt
- **THEN** it MUST wait for speech to accumulate before interrupting, so the scenario cannot pass without something to cut

## Requirement: The fixture database matches what the application expects

The fixture MUST reproduce the schema state the application is written against. The application connects with a search path over `public` and `extensions`, and schema-qualifies extension calls, so the fixture MUST create that schema, install the extensions into it, grant it to the restricted runtime role, and use the same search path, before applying migrations.

### Scenario: Transfers can confirm on a freshly built database

- **GIVEN** an empty database volume
- **WHEN** the fixture prepares it and a transfer is confirmed
- **THEN** no schema, permission, or missing-function error occurs
- **AND** the attempt reaches `confirmed`

### Scenario: The wallet stays in fixture mode

- **GIVEN** the isolated stack
- **WHEN** the harness runs
- **THEN** `WDK_TOOLS_SOURCE=live` is never set
- **AND** the fixture wallet seam MUST refuse to activate in combination with it

## Requirement: Caller fixtures represent a real caller

Recorded caller audio MUST include a trailing pause after speech. A buffer that ends on the last phoneme is a condition no microphone produces, and it distorts what the decision gate observes because input transcription is asynchronous and would otherwise race the model's own tool call.

### Scenario: Fixtures end on a pause

- **GIVEN** the committed user-turn fixtures
- **WHEN** they are inspected or regenerated
- **THEN** each carries trailing silence after its speech
- **AND** the speech audio itself is not altered by that addition
