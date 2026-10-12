import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, QrCode, RotateCw, ScanLine } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, getErrorMessage, queryKeys } from "@/lib/api";
import { subscribeToContactActionProposals } from "@/lib/contact-action-topic";
import type { ContactActionProposal, ContactActionProposalNotification } from "@/lib/api-types";
import {
  aliasAgeLabel,
  formatInstant,
  formatResolvedAt,
  reverseDomainSentence,
} from "./contact-action-proposal-alias";

import {
  canScanAddress,
  scanAddressWithCapacitor,
  type AddressScanResult,
} from "./address-scanner";

/**
 * The review card for a trusted-recipient proposal (design §8.3/§8.4).
 *
 * THE CARD RENDERS THE PERSISTED ROW, NOTHING ELSE
 * -----------------------------------------------
 * Every string below comes from the row `GET /v1/contact-actions/:proposalId`
 * returned, and a paste or a scan never becomes the displayed address: the value
 * is sent to `POST …/address`, the server creates a NEW immutable version, and
 * the card re-reads the row. So this component cannot show an address the policy
 * never received, and a reload or a reconnect re-renders exactly what the
 * database holds.
 *
 * A window opened for version n is never consumed while version n+1 is being
 * prepared — that is enforced by the server's consume predicate, and the visible
 * consequence here is that the version is always labelled: the user reviews a
 * version, not "the card".
 */

/** Deliberately duplicated across the front/back boundary: the backend validates canonically. */
const solanaAddressPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export type ContactActionProposalCardProps = {
  proposalId: string;
  userId?: string;
  /** Injected in tests. Defaults to the Capacitor scan path. */
  scanAddress?: () => Promise<AddressScanResult>;
  /** Injected in tests. Defaults to the dedicated LiveKit card topic. */
  subscribe?: (listener: (notification: ContactActionProposalNotification) => void) => () => void;
};

function actionLabel(action: ContactActionProposal["action"]): string {
  switch (action) {
    case "create":
      return "Add a trusted recipient";
    case "edit":
      return "Edit a trusted recipient";
    case "remove":
      return "Remove a trusted recipient";
  }
}

/**
 * The status as the user must read it. The server already reports an expired row
 * as `expired` (its own `expires_at > now()` predicate), so this only names the
 * states the row can be in.
 */
function statusLabel(status: ContactActionProposal["status"]): string {
  switch (status) {
    case "open":
      return "Waiting for your review";
    case "consumed":
      return "Already confirmed";
    case "superseded":
      return "Replaced by a newer version";
    case "expired":
      return "Expired";
    case "cancelled":
      return "Cancelled";
  }
}

function formatExpiry(expiresAt: string): string {
  return formatInstant(expiresAt);
}

export function ContactActionProposalCard({
  proposalId,
  userId,
  scanAddress,
  subscribe = subscribeToContactActionProposals,
}: ContactActionProposalCardProps) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const query = useQuery({
    queryKey: queryKeys.contactAction(userId, proposalId),
    queryFn: () => api.getContactAction(proposalId),
  });
  const proposal = query.data;

  const replacement = useMutation({
    mutationFn: (input: { address: string; expectedProposalVersion: number }) =>
      api.replaceContactActionAddress(proposalId, input),
    onSuccess: async () => {
      setNotice("We saved the address as a new version of the card.");
      setDraft("");
      await queryClient.invalidateQueries({
        queryKey: queryKeys.contactAction(userId, proposalId),
      });
    },
  });

  // Design §8.4: the dedicated card topic carries a wakeup only, so a card for a
  // NEWER version of this proposal reloads the row instead of trusting a payload.
  useEffect(() => {
    return subscribe((notification) => {
      if (notification.proposalId !== proposalId) return;
      if (proposal && notification.proposalVersion <= proposal.proposalVersion) return;
      void queryClient.invalidateQueries({
        queryKey: queryKeys.contactAction(userId, proposalId),
      });
    });
  }, [proposal, proposalId, queryClient, subscribe, userId]);

  // The loading and failure states are the same card in another state, so they
  // wear the same surface as the reviewed one instead of a bare section.
  if (query.isPending) {
    return (
      <section className="surface-card p-4" aria-label="Review card">
        <p>Loading the card…</p>
      </section>
    );
  }

  if (query.isError) {
    const missing = errorCode(query.error) === "NO_ENCONTRADO";
    return (
      <section className="surface-card p-4" aria-label="Review card">
        <p role="alert">
          {missing
            ? "We could not find this card. It may have expired or been replaced."
            : "We could not read the card."}
        </p>
        {!missing && (
          <Button type="button" variant="outline" onClick={() => void query.refetch()}>
            <RotateCw aria-hidden size={16} /> Retry
          </Button>
        )}
      </section>
    );
  }

  if (!proposal) {
    // Unreachable while the query is neither pending nor failed, and stated
    // explicitly so this render is a total function over the query state.
    return null;
  }

  const readable = proposal.status === "open";
  const missingAddress = readable && !proposal.address;
  // Read once, outside the closures below: a function declaration is hoisted, so
  // the guard above is not what narrows `proposal` inside it.
  const version = proposal.proposalVersion;

  async function handleScan() {
    // A scanner that throws is the same honest outcome as one that is missing:
    // no address, and the paste path stays available.
    const result = await (scanAddress ?? scanAddressWithCapacitor)().catch(
      (): AddressScanResult => ({ status: "unavailable" }),
    );
    if (result.status === "unavailable") {
      setNotice("Scanning is not available here. Paste the address manually.");
      return;
    }
    if (result.status === "cancelled") {
      setNotice("I could not read any code. Try again or paste the address.");
      return;
    }
    setDraft(result.address);
    setNotice("I read an address. Review it before using it.");
  }

  function submitAddress(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const candidate = draft.trim();
    // A pre-check only: the server re-validates the canonical base58 form, and a
    // scanned value is untrusted input either way.
    if (!solanaAddressPattern.test(candidate)) {
      setNotice("That does not look like a valid Solana address.");
      return;
    }
    setNotice(null);
    replacement.mutate({
      address: candidate,
      expectedProposalVersion: version,
    });
  }

  const replacementError = replacement.isError ? replacement.error : null;

  return (
    /*
     * The visual language is the transaction preview card's (AgentScreen.tsx:278
     * — `surface-card p-4`, a `text-base font-extrabold` title and the
     * `auto / 1fr` definition grid), so the screen the user verifies a
     * destination on reads like the screen they already approve a payment on.
     */
    <section className="surface-card p-4" aria-label="Review card">
      <h2 className="text-base font-extrabold">{actionLabel(proposal.action)}</h2>

      {/*
       * The card shows the two facts the user is being asked to approve, in the
       * order they identify the destination: the NAME that justified it, and the
       * full ADDRESS it resolved to. Nothing else competes with them.
       *
       * The version, status and expiry stay in the DOM but visually hidden: they
       * are audit facts the tests and assistive tech still need, and removing
       * them would delete coverage rather than reduce noise.
       */}
      <p className="sr-only">
        Version {proposal.proposalVersion} · <span>{statusLabel(proposal.status)}</span>
      </p>
      <p data-testid="proposal-expiry" className="sr-only">
        Expires {formatExpiry(proposal.expiresAt)}
      </p>

      <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
        <dt className="font-bold">Alias</dt>
        <dd data-testid="proposal-alias" className="text-right">
          {proposal.alias?.name ?? <span data-testid="proposal-alias-none">No alias</span>}
        </dd>

        <dt className="font-bold">Address</dt>
        {/*
         * Deliberately NOT `truncate`: the address is the thing the user
         * verifies, and an ellipsis hides exactly the characters they are
         * looking for. It wraps instead (`break-all`, because a base58 address
         * has no space to wrap on).
         */}
        <dd className="break-all text-right">
          {proposal.address ? (
            <code data-testid="proposal-address">{proposal.address}</code>
          ) : (
            <span data-testid="proposal-no-address">This version has no address yet.</span>
          )}
        </dd>
      </dl>

      {/*
       * The remaining detail stays available but out of the way: the freshness
       * of the resolution, the previous address and the revocation effects are
       * real review facts, so they are disclosed rather than dropped, but they
       * never displace the alias/address pair above.
       */}
      <details>
        <summary>More detail</summary>
        {proposal.alias && (
          <>
            <p data-testid="proposal-reverse-domain">{reverseDomainSentence(proposal.alias)}</p>
            <p data-testid="proposal-freshness">
              {`I resolved this name on ${formatResolvedAt(proposal.alias.resolvedAt)}${
                aliasAgeLabel(proposal.alias.resolvedAt, new Date())
                  ? ` (${aliasAgeLabel(proposal.alias.resolvedAt, new Date())})`
                  : ""
              }.`}
            </p>
          </>
        )}
        {proposal.previousAddress && <p>The previous version had {proposal.previousAddress}.</p>}
        <p>{proposal.revocationDisclosure ?? "This card revokes no automatic permission."}</p>
      </details>

      {!readable && (
        <p role="status">
          This version can no longer be confirmed: {statusLabel(proposal.status).toLowerCase()}.
        </p>
      )}

      {/*
       * The paste path renders ONLY while the reviewed version has no address
       * (`missingAddress` = an open row with a null address). Design flow (c)
       * needs it: a proposal that came from a voice turn whose review channel
       * never supplied an address still has to be finishable from the screen.
       * It is NOT dead code that a row with an address could reuse — a resolved
       * row shows the alias/address pair above, so an empty input plus "Use this
       * address" would be a form with nothing to do. Do not reintroduce it as an
       * always-on "correct the address" control.
       */}
      {missingAddress && (
        <form data-testid="proposal-address-form" onSubmit={submitAddress}>
          <label htmlFor="contact-action-address">Paste or scan this recipient's address</label>
          <Input
            id="contact-action-address"
            name="address"
            value={draft}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setDraft(event.target.value)}
          />
          {canScanAddress() && (
            <Button type="button" variant="outline" onClick={() => void handleScan()}>
              <ScanLine aria-hidden size={16} /> Scan
            </Button>
          )}
          <Button type="submit" disabled={replacement.isPending}>
            <QrCode aria-hidden size={16} /> Use this address
          </Button>
        </form>
      )}

      {notice && <p role="status">{notice}</p>}
      {replacementError && (
        <p role="alert">
          <AlertTriangle aria-hidden size={16} />{" "}
          {errorCode(replacementError) === "PROPUESTA_OBSOLETA"
            ? "This proposal changed. Reload the card and try again."
            : getErrorMessage(replacementError)}
        </p>
      )}
    </section>
  );
}

function errorCode(error: unknown): string | null {
  const candidate = error as { code?: unknown };
  return typeof candidate?.code === "string" ? candidate.code : null;
}
