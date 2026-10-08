-- 014_session_floor.sql
-- Mirror of src/db/migrations/014_session_floor.sql (public schema).
-- Server-side session invalidation (session floor).
--
-- Our backend verifies Privy access tokens OFFLINE (signature, issuer,
-- audience, exp). Logging out only clears the client session, so the access
-- token keeps being accepted until its own `exp`. This additive column gives
-- each user ONE durable revocation instant: on logout we set it to now(), and
-- every authenticated request rejects a token whose `iat` is earlier than the
-- floor. NULL means "no floor" (no session was ever revoked).
--
-- One column, no new table: a soft revocation timestamp on the existing owner
-- row is the whole state. The semantics are intentionally user-wide — revoking
-- every session of the same user is the desired behaviour for a personal
-- wallet. The floor must be durable (never an in-memory set), or a restart
-- would silently un-revoke tokens.
--
-- No new privileges are needed: the existing GRANT UPDATE ON users covers the
-- column, and the row-level `user_self_isolation` policy keeps the write
-- scoped to the owner row.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS session_floor_at TIMESTAMPTZ;
