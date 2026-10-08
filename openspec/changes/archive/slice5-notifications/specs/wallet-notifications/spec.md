# Wallet notifications

## Purpose

Define the durable, authenticated activity feed for assistant operations and relevant wallet events.

## Requirements

### Requirement: Durable user-scoped notification feed

The system MUST persist notification projections for relevant assistant-initiated wallet operations and confirmed supported inbound wallet activity. Each record MUST be bound to the owning user and wallet, and MUST contain only fields approved for display. The feed MUST remain available when no voice session is active.

#### Scenario: Assistant transfer lifecycle is visible
- **GIVEN** an authenticated user initiates a transfer through an active grant or explicit confirmation
- **WHEN** the attempt reaches submitted, uncertain, confirmed, reverted, or receipt_invalid
- **THEN** the system persists one safe notification per canonical operation state
- **AND** assistant transfer state is sourced from its durable `conversation_transfer_attempts` record, not an in-process task event
- **AND** the status update and a retryable outbox event are committed atomically, so process failure cannot permanently lose the notification
- **AND** uncertain is displayed as unresolved; retryable not_dispatched attempts returned to previewed create no feed item
- **AND** the user can retrieve it from the feed outside LiveKit.

#### Scenario: Inbound event is recovered
- **GIVEN** a supported inbound event is confirmed for the user's enrolled wallet
- **WHEN** it is discovered by webhook or reconciliation
- **THEN** the same canonical notification is persisted and scoped to that wallet owner.

#### Scenario: Feed access is isolated
- **GIVEN** two authenticated users have notification records
- **WHEN** one user lists or marks notifications read
- **THEN** only that user's records may be returned or changed.

### Requirement: Safe display projection and read state

The system MUST omit webhook secrets, authorization material, signing data, raw provider payloads, and unnecessary counterparty details from feed responses. Users MUST be able to mark their own notifications read. The client MUST refresh visible feed state without a full-page reload.

#### Scenario: Notification refreshes without reload
- **GIVEN** the activity feed is open
- **WHEN** a new notification is persisted
- **THEN** the client refreshes by a 30-second visible-page HTTP interval, page focus, or an existing LiveKit revision signal.

#### Scenario: Read state is user-owned
- **GIVEN** a notification belongs to the authenticated user
- **WHEN** that user marks it read
- **THEN** the read timestamp is stored and reflected in subsequent feed reads.
