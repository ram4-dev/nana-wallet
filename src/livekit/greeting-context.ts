import { formatBalanceForAgent } from "../agent/balance-format.js";
import { getWalletAgentConfig } from "../agent/instructions.js";
import type { ConversationLanguage } from "../conversations/language.js";
import type { ConversationRepository } from "../conversations/repository.js";
import type { DatabaseClient } from "../db/client.js";
import type { WalletProvider } from "../wallet/provider.js";

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

/**
 * Is this the amount we are about to speak actually zero?
 *
 * The comparison runs on the PRESENTED amount, because that is what the user
 * would hear: a provider value that rounds down to `0.00` is silence either way.
 * A value that is not a finite number is NOT zero, so it is never skipped — an
 * unreadable presentation is not a balance of nothing.
 */
function isZeroPresentedAmount(presented: string): boolean {
  const amount = Number(presented);
  return Number.isFinite(amount) && amount === 0;
}

/**
 * Phrase a spoken amount with the network it was read from, e.g.
 * `diez USDC en arc-testnet`. The amount itself is already in words: this only
 * adds where it lives.
 */
function withNetwork(
  spoken: string,
  network: string,
  language: ConversationLanguage,
): string {
  return language === "es"
    ? `${spoken} en ${network}`
    : `${spoken} in ${network}`;
}

/**
 * Reads the ONE amount the proactive welcome is allowed to speak.
 *
 * The opening turn must be a single generation, so it cannot call a tool to learn
 * the balance: a tool call splits it in two and the user hears two greetings. The
 * server reads the balance BEFORE dispatching the greeting and hands the model the
 * ready-to-speak words.
 *
 * Returns the first funded network's amount phrased with its network, or
 * `undefined` when no network is funded or readable. A network whose presented
 * amount is zero is skipped (a zero balance is not worth speaking) and every
 * network is read in its own guard, so a failing network never hides a funded one.
 * Best effort like the rest of this module: this never throws.
 */
export async function readGreetingBalance(input: {
  wallet: WalletProvider;
  token: string;
  language: ConversationLanguage;
}): Promise<string | undefined> {
  // The balance query carries the wallet name every provider method takes; the
  // same default the balance tool uses keeps this read and `get_balance` reading
  // the same wallet.
  const walletName = getWalletAgentConfig().wallet;
  let networks: Awaited<ReturnType<WalletProvider["listNetworks"]>>;
  try {
    networks = await input.wallet.listNetworks();
  } catch {
    // Best effort: a wallet that cannot list its networks has no amount to speak.
    return undefined;
  }
  if (!Array.isArray(networks)) return undefined;

  for (const { network } of networks) {
    try {
      const balance = await input.wallet.getBalance({
        network,
        token: input.token,
        wallet: walletName,
      });
      const presentation = formatBalanceForAgent({
        balance: balance.balance,
        token: balance.token ?? input.token,
        language: input.language,
      });
      if (isZeroPresentedAmount(presentation.balance)) continue;
      return withNetwork(presentation.balanceSpoken, network, input.language);
    } catch {
      // Best effort: one unreadable network must not stop the next one, and a
      // failing network is never the end of the greeting.
    }
  }
  return undefined;
}
