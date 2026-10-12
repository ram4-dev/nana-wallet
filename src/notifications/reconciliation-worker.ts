import type { DatabaseClient } from "../db/client.js";
import { insertNotificationRow } from "./notification-repository.js";
import { canonicalDedupeKey } from "./ingestion.js";
import { computeReconciliationBackoff } from "./reconciliation.js";

/** Hard upper bound on any provider page request (bounded work contract). */
export const MAX_PAGE_SIZE = 100;

export const SOLANA_DEVNET_NETWORK = "solana-devnet";

/**
 * A normalized, provider-agnostic chain-event observation. The SOURCE is
 * responsible for classification: only confirmed, supported, inbound wallet
 * activity (positive recipient delta to the enrolled wallet) is emitted as
 * `confirmed_transfer`. Failed, outgoing, self, and unsupported transactions
 * are never surfaced — the worker never infers identity from balance changes.
 */
export type ChainEventObservation = {
  signature: string;
  eventClass: "confirmed_transfer";
};

/**
 * Bounded forward catch-up page request. Solana's getSignaturesForAddress
 * walks backward from newest and `before` paginates toward older history, so
 * a multi-page gap is drained oldest-page-last:
 *   page 1: until = caughtUpThrough (stop at last durable watermark)
 *   page n: before = scanCursor AND until = caughtUpThrough
 * Sources return newest-first entries classified oldest-first.
 */
export type CatchUpPageRequest = {
  walletAddress: string;
  network: string;
  /** Newest signature already durably ingested (forward watermark). */
  caughtUpThrough: string | null;
  /** Page boundary for drain continuation (null on the first page). */
  scanCursor: string | null;
  pageSize: number;
};

export type CatchUpPageResult = {
  observations: ChainEventObservation[];
  /** Newest signature in this page (newest-first entries[0]). */
  pageNewest: string | null;
  /** Oldest signature in this page (entries.at(-1)); the next scan uses it. */
  pageOldest: string | null;
  /** True when this page reached the watermark with room to spare. */
  reachedWatermark: boolean;
};

export type ReconciliationSource = {
  fetchConfirmedPage(args: CatchUpPageRequest): Promise<CatchUpPageResult>;
};

export type ReconcileWalletOptions = {
  database: DatabaseClient;
  source: ReconciliationSource;
  wallet: { id: string; address: string; network: string };
  workerId: string;
  pageSize: number;
  leaseSeconds: number;
  maxPagesPerRun: number;
  /** Transient fan-out for the insert winner (post-commit). */
  onNotificationInserted?: (dedupeKey: string) => Promise<void>;
};

export type ReconcileWalletResult = {
  leaseAcquired: boolean;
  pagesProcessed: number;
  signaturesProcessed: number;
  /** Newest signature durably ingested; equals the watermark only when drained. */
  caughtUpThrough: string | null;
  /** True when the full gap between watermark and now was drained this run. */
  caughtUp: boolean;
};

type ForwardCursorState = {
  cursorValue: string | null;
  scanHighWatermark: string | null;
  scanCursor: string | null;
};

async function loadCursorState(
  database: DatabaseClient,
  walletId: string,
  network: string,
): Promise<ForwardCursorState> {
  const rows = await database.withSystemTransaction((client) =>
    client.query<{
      cursor_value: string | null;
      scan_high_watermark: string | null;
      scan_cursor: string | null;
    }>(
      `SELECT cursor_value, scan_high_watermark, scan_cursor
       FROM reconciliation_cursors
       WHERE wallet_id = $1 AND network = $2`,
      [walletId, network],
    ),
  );
  const row = rows.rows[0];
  return {
    cursorValue: row?.cursor_value ?? null,
    scanHighWatermark: row?.scan_high_watermark ?? null,
    scanCursor: row?.scan_cursor ?? null,
  };
}

async function persistCursorState(
  database: DatabaseClient,
  walletId: string,
  network: string,
  state: ForwardCursorState,
): Promise<void> {
  await database.withSystemTransaction((client) =>
    client.query(
      `INSERT INTO reconciliation_cursors
         (wallet_id, network, cursor_value, scan_high_watermark, scan_cursor)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (wallet_id, network) DO UPDATE
         SET cursor_value = EXCLUDED.cursor_value,
             scan_high_watermark = EXCLUDED.scan_high_watermark,
             scan_cursor = EXCLUDED.scan_cursor,
             updated_at = now()`,
      [
        walletId,
        network,
        state.cursorValue,
        state.scanHighWatermark,
        state.scanCursor,
      ],
    ),
  );
}

/**
 * One bounded forward catch-up run for a wallet/network (provably lossless):
 * 1. DB lease excludes concurrent workers; released in `finally`.
 * 2. A gap (newest→watermark) is discovered on the first page; when a page
 *    fills to the limit, the run persists scan_high_watermark (newest seen)
 *    and scan_cursor (page's oldest) and continues older pages with
 *    before=scanCursor / until=cursorValue up to maxPagesPerRun. Remaining
 *    pages continue on later runs. cursor_value advances to the high
 *    watermark ONLY after every page of the gap is drained: at-or-before the
 *    watermark was always processed; nothing newer is skipped.
 * 3. Every page is ingested through canonical dedupe before any cursor state
 *    persists, so a crash mid-run replays idempotently.
 */
export async function reconcileWalletOnce(
  options: ReconcileWalletOptions,
): Promise<ReconcileWalletResult> {
  const { database, source, wallet, workerId } = options;
  const pageSize = Math.min(options.pageSize, MAX_PAGE_SIZE);

  // 1. Real DB lease: second worker gets NULL and must skip this run.
  const lease = await database.withSystemTransaction((client) =>
    client.query<{ lease_token: string | null }>(
      `SELECT lease_token FROM acquire_reconciliation_lease($1, $2, $3, $4)`,
      [wallet.id, wallet.network, workerId, options.leaseSeconds],
    ),
  );
  const leaseToken = lease.rows[0]?.lease_token ?? null;
  if (!leaseToken) {
    return {
      leaseAcquired: false,
      pagesProcessed: 0,
      signaturesProcessed: 0,
      caughtUpThrough: null,
      caughtUp: false,
    };
  }

  try {
    const state = await loadCursorState(database, wallet.id, wallet.network);
    let pagesProcessed = 0;
    let signaturesProcessed = 0;

    for (
      let pageIndex = 0;
      pageIndex < options.maxPagesPerRun;
      pageIndex += 1
    ) {
      const page = await source.fetchConfirmedPage({
        walletAddress: wallet.address,
        network: wallet.network,
        caughtUpThrough: state.cursorValue,
        scanCursor: state.scanCursor,
        pageSize,
      });

      // Ingest the page durably BEFORE any cursor state changes.
      for (const observation of page.observations) {
        const dedupeKey = canonicalDedupeKey({
          network: wallet.network,
          walletAddress: wallet.address,
          signature: observation.signature,
          eventClass: observation.eventClass,
        });
        let inserted = false;
        await database.withSystemTransaction(async (client) => {
          const ownerRows = await client.query<{ user_id: string }>(
            `SELECT user_id FROM user_wallets WHERE id = $1 AND state = 'ready'`,
            [wallet.id],
          );
          const owner = ownerRows.rows[0]?.user_id;
          if (!owner) {
            throw new Error(`Wallet ${wallet.id} has no resolvable owner.`);
          }
          await client.query("SELECT set_config('app.user_id', $1, true)", [
            owner,
          ]);
          const outcome = await insertNotificationRow(client, {
            kind: "wallet_event",
            userId: owner,
            walletId: wallet.id,
            dedupeKey,
            category: "wallet_event",
            status: "deposit",
            title: "Deposit confirmed",
            explanation: "We detected a confirmed deposit in your wallet.",
            resolved: true,
            projection: { status: "deposit", network: wallet.network },
          });
          inserted = outcome.inserted;
        });
        signaturesProcessed += 1;
        // Post-commit fan-out: only the insert winner, only after COMMIT.
        // Failure is swallowed; the durable feed is the correctness path.
        if (inserted && options.onNotificationInserted) {
          try {
            await options.onNotificationInserted(dedupeKey);
          } catch {
            // Transient fan-out must never affect committed delivery.
          }
        }
      }
      pagesProcessed += 1;

          if (page.pageOldest === null) {
            // Empty page: with an active scan this is the final boundary of an
            // exact-multiple gap — the drain completed, promote the watermark.
            // Without a scan there was simply nothing new; state is unchanged.
            if (state.scanHighWatermark !== null) {
              state.cursorValue = state.scanHighWatermark;
              state.scanHighWatermark = null;
              state.scanCursor = null;
              await persistCursorState(
                database,
                wallet.id,
                wallet.network,
                state,
              );
            }
            return {
              leaseAcquired: true,
              pagesProcessed,
              signaturesProcessed,
              caughtUpThrough: state.cursorValue,
              caughtUp: true,
            };
          }

      if (page.reachedWatermark || page.pageOldest === state.cursorValue) {
        // This page reached the watermark: the gap is fully drained.
        state.cursorValue = state.scanHighWatermark ?? page.pageNewest;
        state.scanHighWatermark = null;
        state.scanCursor = null;
        await persistCursorState(database, wallet.id, wallet.network, state);
        return {
          leaseAcquired: true,
          pagesProcessed,
          signaturesProcessed,
          caughtUpThrough: state.cursorValue,
          caughtUp: true,
        };
      }

      // Full page that did NOT reach the watermark: newer signatures may be
      // unseen. Record the high watermark once (page 1's newest) and the scan
      // boundary; the drain continues on the next page/run.
      state.scanHighWatermark =
        state.scanHighWatermark ?? page.pageNewest;
      state.scanCursor = page.pageOldest;
      await persistCursorState(database, wallet.id, wallet.network, state);
    }

    // maxPagesPerRun exhausted with an open gap: keep drain state; the next
    // run resumes from scanCursor. caughtUp stays false — nothing is skipped.
    return {
      leaseAcquired: true,
      pagesProcessed,
      signaturesProcessed,
      caughtUpThrough: state.cursorValue,
      caughtUp: false,
    };
  } finally {
    // Always release the lease so a finished run never blocks reprocessing.
    await database
      .withSystemTransaction((client) =>
        client.query(
          `DELETE FROM reconciliation_leases
           WHERE wallet_id = $1 AND network = $2 AND lease_token = $3`,
          [wallet.id, wallet.network, leaseToken],
        ),
      )
      .catch(() => {
        // Release failure is safe: the lease expires on its own.
      });
  }
}

export type ReconciliationWorkerOptions = {
  database: DatabaseClient;
  source: ReconciliationSource;
  workerId: string;
  pageSize: number;
  leaseSeconds: number;
  intervalMs: number;
  maxPagesPerRun?: number;
  backoffOptions?: { baseSeconds: number; maxSeconds: number };
};

/**
 * Long-running reconciliation worker:
 * - Runs the first pass immediately at startup (bounded work per wallet).
 * - Retries with capped exponential backoff after a failed pass; resets to
 *   the fixed interval on success.
 * - stop() clears the pending timer and awaits in-flight work.
 * No live RPC: the source is injectable (tests use a fake RPC source).
 */
export function startReconciliationWorker(options: ReconciliationWorkerOptions) {
  const { database, source, workerId, pageSize, leaseSeconds, intervalMs } =
    options;
  const maxPagesPerRun = options.maxPagesPerRun ?? 5;
  const backoff = options.backoffOptions ?? { baseSeconds: 1, maxSeconds: 60 };
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let inFlight: Promise<void> = Promise.resolve();

  async function runPass(): Promise<void> {
    const wallets = await database.withSystemTransaction((client) =>
      client.query<{ id: string; address: string; network: string }>(
        `SELECT id, address, COALESCE(chain_family, 'solana') AS network
         FROM user_wallets WHERE provider = 'privy' AND state = 'ready'`,
      ),
    );
    for (const row of wallets.rows) {
      if (stopped) return;
      await reconcileWalletOnce({
        database,
        source,
        wallet: { id: row.id, address: row.address, network: row.network },
        workerId,
        pageSize,
        leaseSeconds,
        maxPagesPerRun,
      });
    }
  }

  function schedule(delayMs: number): void {
    if (stopped) return;
    timer = setTimeout(() => {
      inFlight = inFlight
        .then(() => runPass())
        .then(() => {
          attempt = 0;
        })
        .catch(() => {
          attempt += 1;
        })
        .finally(() => {
          const nextDelayMs =
            attempt === 0
              ? intervalMs
              : computeReconciliationBackoff({
                  attempt,
                  baseSeconds: backoff.baseSeconds,
                  maxSeconds: backoff.maxSeconds,
                }) * 1000;
          schedule(nextDelayMs);
        });
    }, delayMs);
  }

  // Startup semantics: run the first pass immediately (bounded), then loop.
  schedule(0);

  return {
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight;
    },
  };
}
