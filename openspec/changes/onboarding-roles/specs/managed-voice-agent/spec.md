# Managed Voice Agent Specification

## Purpose

Define invitation narration and responsible-person voice capabilities without sharing confirmation state or exposing money movement.

## Requirements

### Requirement: MVA-001 Nani narrates canonical invitations before greeting

When voice is available and a pending invitation exists, the backend MUST select the canonical invitation and MUST play server-authored inviter identity and scope before the normal greeting or balance. The model MUST NOT invent or paraphrase the authoritative invitation content.

#### Scenario: Pending invitation at startup

- GIVEN an authenticated beneficiary enters a voice session with a pending invitation
- WHEN startup completes
- THEN Nani MUST audibly identify the inviter and requested scope before the normal greeting
- AND the same invitation MUST remain visible in the screen card

#### Scenario: Multiple invitations

- GIVEN several pending invitations match the beneficiary
- WHEN voice startup selects one
- THEN the system MUST present them one at a time in creation order

### Requirement: MVA-002 Invitation decisions require verified playout

The system MUST open a typed `invitation` decision window only after verified completion of the matching TTS playout. The window MUST bind invitation ID and version, actor, conversation, and authenticated participant, and MUST be exclusive with `transfer` and `contact` windows.

#### Scenario: Affirmative after narration

- GIVEN the canonical invitation finished audible playout and its invitation window is open
- WHEN the bound participant produces a final affirmative transcript
- THEN the system MUST submit one invitation acceptance through the canonical decision service
- AND MUST consume the window exactly once

#### Scenario: Transcript belongs elsewhere

- GIVEN a transcript is pre-playout, non-final, from another participant, repeated, or belongs to a transfer or contact window
- WHEN the invitation gate evaluates it
- THEN it MUST NOT decide the invitation or any other operation

### Requirement: MVA-003 Voice failure falls back safely

An interruption, missing TTS capability, audio error, or unverified playout MUST leave the invitation undecided and MUST NOT open its decision window. The persisted screen card MUST remain available for acceptance or decline.

#### Scenario: Narration is interrupted

- GIVEN invitation narration starts but verified playout does not complete
- WHEN the session continues or ends
- THEN the invitation MUST remain pending
- AND the screen decision path MUST remain usable

### Requirement: MVA-004 Responsible tool catalog excludes money movement

Nani MUST construct a dedicated responsible-person tool catalog bound to the selected authorized subject. It MAY expose approved managed reads, but MUST NOT expose transfer, transfer-confirmation, signing, grant, signer, wallet reassignment, or room-token tools. Every exposed tool MUST reauthorize actor, subject, relationship state, version, and capability when called.

#### Scenario: Responsible person asks Nani to transfer

- GIVEN Nani is operating in a responsible-person context
- WHEN the actor asks to send or confirm beneficiary funds
- THEN Nani MUST refuse without invoking a money-moving tool
- AND the backend MUST reject any forged direct invocation

#### Scenario: Relationship changes during session

- GIVEN a responsible-person voice session is bound to an accepted relationship
- WHEN that relationship begins revocation before the next tool call
- THEN the tool call MUST be denied and MUST return no beneficiary data

### Requirement: MVA-005 Owner voice transfer behavior remains compatible

Invitation handling MUST remain isolated from the beneficiary's existing Solana-devnet transfer gate. An invitation response MUST NOT satisfy transfer confirmation, and normal owner transfer voice behavior MUST retain preview, authenticated post-preview agreement, and one-use counting.

#### Scenario: Invitation and transfer both exist

- GIVEN an invitation and a transfer could each require a decision
- WHEN the participant says an ordinary affirmative
- THEN only the single currently open typed window MAY consume it
- AND the other operation MUST remain undecided
