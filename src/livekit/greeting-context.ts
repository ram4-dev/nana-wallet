import type { ConversationRepository } from "../conversations/repository.js";
import type { DatabaseClient } from "../db/client.js";

export type VoiceGreetingDependencies = {
  database: DatabaseClient;
  conversations: ConversationRepository;
};

export type VoiceGreetingBinding = {
  userId: string;
  conversationId: string;
};

/**
 * Characters a display name may carry: letters (any script), combining marks and
 * the three separators a real name uses. Everything else — digits, quotes,
 * colons, brackets, control characters, line breaks — is refused, because the
 * name is interpolated into the model's instructions and must stay data.
 */
const ALLOWED_NAME_CHARACTERS = /^[\p{L}\p{M} '.-]+$/u;

/** A name starts with a letter (or the combining mark that modifies it). */
const LEADING_NAME_CHARACTER = /^[\p{L}\p{M}]/u;

const NAME_LENGTH_LIMIT = 40;

/**
 * Horizontal whitespace only. A line break is never part of a name, so it is
 * deliberately left in place for the allow-list to reject: folding it into a
 * space would turn the only escape from the instruction's line into a legal
 * character.
 */
const HORIZONTAL_WHITESPACE_RUN = /[^\S\r\n\u2028\u2029]+/gu;

const USERS_DISPLAY_NAME_QUERY =
  "SELECT id, display_name FROM users WHERE id = $1::uuid";

/**
 * Normalizes a raw `users.display_name` value into something safe to hand to the
 * model, or `undefined` when it cannot be a name.
 *
 * Accepts a string only; trims it and collapses runs of horizontal whitespace
 * into a single space. Rejects empty values, values longer than
 * {@link NAME_LENGTH_LIMIT} characters, anything outside the allow-list above
 * (line breaks included) and anything that does not start with a letter. Never
 * throws.
 */
export function sanitizeDisplayName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const normalized = raw.trim().replace(HORIZONTAL_WHITESPACE_RUN, " ");
  if (normalized.length === 0) return undefined;
  if (normalized.length > NAME_LENGTH_LIMIT) return undefined;
  if (!ALLOWED_NAME_CHARACTERS.test(normalized)) return undefined;
  if (!LEADING_NAME_CHARACTER.test(normalized)) return undefined;
  return normalized;
}

/**
 * Prepares what the proactive opening turn needs from the conversation, right
 * before a live voice session starts.
 *
 * Two independent best-effort reads, each with its own guard, because this runs
 * inside the voice bind/start path and must never break it:
 *
 * 1. Establish the conversation language as `'es'` when it is not there yet.
 *    A conversation defaults to `'en'`, and the text path only flips it from
 *    user text — which does not exist during the first turn, so `get_balance`
 *    would hand the model English balance words inside a Spanish greeting.
 * 2. Read the user's display name so the greeting can address them by name.
 *
 * Returns `{ userName }` only when a valid name survived
 * {@link sanitizeDisplayName}; otherwise an empty object. Never throws.
 */
export async function prepareVoiceGreeting(
  dependencies: VoiceGreetingDependencies,
  binding: VoiceGreetingBinding,
): Promise<{ userName?: string }> {
  const { userId, conversationId } = binding;

  try {
    const snapshot = await dependencies.conversations.get(userId, conversationId);
    const setLanguage = dependencies.conversations.setLanguage;
    if (snapshot && snapshot.language !== "es" && setLanguage) {
      // Called through the repository: `setLanguage` is an optional interface
      // member implemented as a method, so a detached call would lose `this`.
      await setLanguage.call(
        dependencies.conversations,
        userId,
        conversationId,
        "es",
      );
    }
  } catch {
    // Best effort: a conversation that cannot switch language still talks.
  }

  let userName: string | undefined;
  try {
    const result = await dependencies.database.withUserTransaction(
      userId,
      (client) =>
        client.query<{ display_name: string | null }>(
          USERS_DISPLAY_NAME_QUERY,
          [userId],
        ),
    );
    userName = sanitizeDisplayName(result.rows[0]?.display_name);
  } catch {
    // Best effort: a nameless greeting is still a greeting.
  }

  return userName ? { userName } : {};
}
