import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, QrCode, RotateCw, ScanLine } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, getErrorMessage, queryKeys } from "@/lib/api";
import { subscribeToContactActionProposals } from "@/lib/contact-action-topic";
import type { ContactActionProposal, ContactActionProposalNotification } from "@/lib/api-types";

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
      return "Agregar a un destinatario de confianza";
    case "edit":
      return "Editar un destinatario de confianza";
    case "remove":
      return "Quitar a un destinatario de confianza";
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
      return "Esperando tu revisión";
    case "consumed":
      return "Ya confirmada";
    case "superseded":
      return "Reemplazada por una versión más nueva";
    case "expired":
      return "Vencida";
    case "cancelled":
      return "Cancelada";
  }
}

function formatExpiry(expiresAt: string): string {
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return expiresAt;
  return date.toLocaleString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
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
      setNotice("Guardamos la dirección como una versión nueva de la tarjeta.");
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

  if (query.isPending) {
    return (
      <section aria-label="Tarjeta de revisión">
        <p>Cargando la tarjeta…</p>
      </section>
    );
  }

  if (query.isError) {
    const missing = errorCode(query.error) === "NO_ENCONTRADO";
    return (
      <section aria-label="Tarjeta de revisión">
        <p role="alert">
          {missing
            ? "No encontramos esta tarjeta. Puede haber vencido o haberse reemplazado."
            : "No pudimos leer la tarjeta."}
        </p>
        {!missing && (
          <Button type="button" variant="outline" onClick={() => void query.refetch()}>
            <RotateCw aria-hidden size={16} /> Reintentar
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
      setNotice("Escanear no está disponible acá. Pegá la dirección a mano.");
      return;
    }
    if (result.status === "cancelled") {
      setNotice("No leí ningún código. Probá de nuevo o pegá la dirección.");
      return;
    }
    setDraft(result.address);
    setNotice("Leí una dirección. Revisala antes de usarla.");
  }

  function submitAddress(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const candidate = draft.trim();
    // A pre-check only: the server re-validates the canonical base58 form, and a
    // scanned value is untrusted input either way.
    if (!solanaAddressPattern.test(candidate)) {
      setNotice("Esa no parece una dirección Solana válida.");
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
    <section aria-label="Tarjeta de revisión">
      <h2>{actionLabel(proposal.action)}</h2>
      <p>
        Versión {proposal.proposalVersion} · <span>{statusLabel(proposal.status)}</span>
      </p>
      <p data-testid="proposal-expiry">Vence el {formatExpiry(proposal.expiresAt)}</p>

      <p>
        {proposal.address
          ? `Dirección de esta versión: ${proposal.address}`
          : "Todavía no hay una dirección en esta versión."}
      </p>
      {proposal.previousAddress && <p>La versión anterior tenía {proposal.previousAddress}.</p>}
      <p>{proposal.revocationDisclosure ?? "Esta tarjeta no revoca ningún permiso automático."}</p>

      {!readable && (
        <p role="status">
          Esta versión ya no se puede confirmar: {statusLabel(proposal.status).toLowerCase()}.
        </p>
      )}

      {readable && (
        <form onSubmit={submitAddress}>
          <label htmlFor="contact-action-address">
            {missingAddress
              ? "Pegá o escaneá la dirección de este destinatario"
              : "Corregir la dirección"}
          </label>
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
              <ScanLine aria-hidden size={16} /> Escanear
            </Button>
          )}
          <Button type="submit" disabled={replacement.isPending}>
            <QrCode aria-hidden size={16} /> Usar esta dirección
          </Button>
        </form>
      )}

      {notice && <p role="status">{notice}</p>}
      {replacementError && (
        <p role="alert">
          <AlertTriangle aria-hidden size={16} />{" "}
          {errorCode(replacementError) === "PROPUESTA_OBSOLETA"
            ? "Esta propuesta cambió. Recargá la tarjeta y probá de nuevo."
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
