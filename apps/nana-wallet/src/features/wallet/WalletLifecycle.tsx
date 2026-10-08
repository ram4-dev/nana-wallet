import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Loader2, ShieldAlert, ShieldCheck, Wallet } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { api, getErrorMessage, isPrivyIdentityProvider, queryKeys } from "@/lib/api";
import { AddTrustedRecipient } from "./AddTrustedRecipient";
import type {
  EnrollmentPreparationResponse,
  PermissionState,
  WalletPermissionResponse,
  WalletReadinessState,
} from "@/lib/api-types";

// Lazy-load the Privy-only signer enrollment so the demo bundle never imports
// `useSigners` (rendered only inside the Privy tree).
const PrivySignerEnrollment = lazy(() =>
  import("./PrivySignerEnrollment").then((module) => ({
    default: module.PrivySignerEnrollment,
  })),
);
const PrivyWalletSync = lazy(() =>
  import("./PrivyWalletSync").then((module) => ({
    default: module.PrivyWalletSync,
  })),
);

/**
 * PEW-005: wallet readiness and permission readiness are two separate concerns.
 * A wallet can be ready for payments while no user-revocable grant exists (or
 * vice versa). This section renders both independently and never conflates them.
 */

type WalletStateTone = "neutral" | "ok" | "working" | "warn" | "danger";

const WALLET_STATE_LABELS: Record<WalletReadinessState, { label: string; tone: WalletStateTone }> =
  {
    unprovisioned: { label: "Billetera sin provisionar", tone: "neutral" },
    provisioning: { label: "Provisionando billetera", tone: "working" },
    ready: { label: "Billetera lista", tone: "ok" },
    recovery_required: { label: "Necesita recuperación", tone: "warn" },
    conflict: { label: "Conflicto de billetera", tone: "warn" },
    unavailable: { label: "Billetera no disponible", tone: "danger" },
  };

const PERMISSION_STATE_LABELS: Record<PermissionState, string> = {
  pending: "Permiso de pagos pendiente",
  active: "Permiso de pagos activo",
  revoking: "Revocando el permiso…",
  revoked: "Permiso de pagos revocado",
  unavailable: "Permiso de pagos no disponible",
};

/**
 * USER DECISION (2026-09-09): payments are enabled with the per-transfer cap;
 * the rolling 50 USDC/hour aggregate is a PENDING FEATURE — shown, never hidden.
 */
const toneClasses: Record<WalletStateTone, string> = {
  neutral: "bg-secondary text-secondary-foreground",
  ok: "bg-success-surface text-success-surface-foreground",
  working: "bg-secondary text-secondary-foreground",
  warn: "bg-destructive-surface text-destructive-surface-foreground",
  danger: "bg-destructive-surface text-destructive-surface-foreground",
};

/**
 * A grant is "bounded" (and therefore safe to render as an activatable payment
 * capability) only when every limit is present and positive. Empty or missing
 * values must never render as a working, activatable grant (fail-closed).
 */
function hasBoundedLimits(permission: WalletPermissionResponse): boolean {
  if (permission.perTransferSol !== "") {
    const perTransferSol = Number(permission.perTransferSol);
    return (
      Number.isFinite(perTransferSol) &&
      perTransferSol > 0 &&
      perTransferSol <= 0.01 &&
      permission.rollingWindowSeconds > 0 &&
      permission.recipients.length > 0
    );
  }
  const perTransfer = Number(permission.perTransferUsdc);
  const rollingTotal = Number(permission.rollingTotalUsdc);
  return (
    permission.perTransferUsdc !== "" &&
    permission.rollingTotalUsdc !== "" &&
    Number.isFinite(perTransfer) &&
    perTransfer > 0 &&
    Number.isFinite(rollingTotal) &&
    rollingTotal > 0 &&
    permission.rollingWindowSeconds > 0 &&
    permission.recipients.length > 0
  );
}

/** "por hora" for 3600 s; otherwise a human window label for other windows. */
function formatWindowLabel(seconds: number): string {
  if (seconds <= 0) return "";
  if (seconds === 3600) return "por hora";
  if (seconds % 3600 === 0) return `cada ${seconds / 3600} hora${seconds / 3600 === 1 ? "" : "s"}`;
  if (seconds % 60 === 0) return `cada ${seconds / 60} min`;
  return `cada ${seconds} s`;
}

function shortenAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

function WalletStateBadge({ state }: { state: WalletReadinessState }) {
  const { label, tone } = WALLET_STATE_LABELS[state];
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-base font-extrabold ${toneClasses[tone]}`}
    >
      {state === "ready" ? (
        <ShieldCheck className="size-5" strokeWidth={2.4} aria-hidden="true" />
      ) : (
        <Wallet className="size-5" strokeWidth={2.4} aria-hidden="true" />
      )}
      {label}
    </span>
  );
}

function RoutePendingInline() {
  return <p className="mt-4 text-base text-muted-foreground">Preparando la autorización…</p>;
}

export function WalletLifecycle({ userId }: { userId: string | undefined }) {
  const queryClient = useQueryClient();
  const enabled = Boolean(userId);
  const privy = isPrivyIdentityProvider();
  const [isActivating, setIsActivating] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isRevoking, setIsRevoking] = useState(false);
  const [permissionMessage, setPermissionMessage] = useState<string | null>(null);
  const [preparation, setPreparation] = useState<EnrollmentPreparationResponse | null>(null);

  const walletQuery = useQuery({
    queryKey: queryKeys.currentWallet(userId),
    queryFn: api.getCurrentWallet,
    enabled,
  });
  const permissionQuery = useQuery({
    queryKey: queryKeys.walletPermission(userId),
    queryFn: api.getCurrentWalletPermission,
    enabled,
  });
  // Activation uses the user's explicitly saved contacts as the allowlist
  // (Q3: only contacts the user chose are authorized).
  const contactsQuery = useQuery({
    queryKey: queryKeys.contacts(userId),
    queryFn: api.getContacts,
    enabled,
  });

  async function handleSync() {
    setIsSyncing(true);
    setPermissionMessage(null);
    try {
      await api.syncWallet();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.currentWallet(userId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.wallet(userId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.movements(userId) }),
      ]);
    } catch (error) {
      setPermissionMessage(getErrorMessage(error));
    } finally {
      setIsSyncing(false);
    }
  }

  if (!enabled || walletQuery.isPending || permissionQuery.isPending) {
    return (
      <section className="surface-card mt-10 p-5">
        <p className="text-base text-muted-foreground">Estamos buscando tu billetera…</p>
      </section>
    );
  }

  const walletError = walletQuery.error ?? permissionQuery.error;
  if (walletError) {
    return (
      <section className="surface-card mt-10 p-5" role="alert">
        <ShieldAlert className="size-7 text-destructive" aria-hidden="true" />
        <h2 className="mt-2 text-xl font-extrabold">No pudimos leer tu billetera</h2>
        <p className="mt-1 text-base text-muted-foreground">{getErrorMessage(walletError)}</p>
      </section>
    );
  }

  if (!walletQuery.data || !permissionQuery.data) {
    return (
      <section className="surface-card mt-10 p-5">
        <p className="text-base text-muted-foreground">Estamos buscando tu billetera…</p>
      </section>
    );
  }

  const wallet = walletQuery.data;
  const permission = permissionQuery.data;
  const bounded = hasBoundedLimits(permission);
  const isActive = permission.state === "active" && bounded;

  async function handleActivate() {
    setIsActivating(true);
    setPermissionMessage(null);
    try {
      const allowlist = (contactsQuery.data ?? []).map((contact) => contact.address);
      if (allowlist.length === 0) {
        setPermissionMessage(
          "Agregá al menos un destinatario de confianza antes de activar el permiso.",
        );
        return;
      }

      if (privy) {
        // PEW-014: user-authenticated signer enrollment — prepare step. The
        // backend creates/reuses the provider policy; the browser then adds the
        // signer via the Privy modal. Only completePermission (server read-back)
        // can activate, so a client success flag can never be treated as active.
        const prep = await api.prepareWalletPermission({ recipients: allowlist });
        setPreparation(prep);
        return;
      }

      // Demo path (unchanged): explicit activation with server read-back. The
      // client cannot assert enrollment succeeded; a failed read-back surfaces
      // as an error, never as "active".
      await api.activateWalletPermission({ recipients: allowlist });
      const refreshed = await queryClient.fetchQuery({
        queryKey: queryKeys.walletPermission(userId),
        queryFn: api.getCurrentWalletPermission,
      });
      if (refreshed.state !== "active") {
        setPermissionMessage(
          "Todavía no está activo el permiso de pagos. Volvé a intentar en un ratito.",
        );
      } else if (!hasBoundedLimits(refreshed)) {
        setPermissionMessage(
          "El proveedor no confirmó los límites del permiso. No mostramos pagos habilitados.",
        );
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.currentWallet(userId) });
    } catch (error) {
      setPermissionMessage(getErrorMessage(error));
    } finally {
      setIsActivating(false);
    }
  }

  // PEW-014: signer enrollment — complete step. Re-proves owner + policy via the
  // server read-back. A `verified:false` result must be surfaced honestly (the
  // grant stays pending); never assume the browser's addSigners success proves it.
  async function handlePrivyComplete() {
    if (!preparation) return;
    try {
      const result = await api.completeWalletPermission({
        walletId: preparation.walletId,
      });
      if (result.verified && result.permission) {
        setPreparation(null);
        setPermissionMessage(null);
        void queryClient.invalidateQueries({ queryKey: queryKeys.walletPermission(userId) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.currentWallet(userId) });
        return;
      }
      // Honest fallback: the read-back could not prove attachment. Surface the
      // observed evidence and leave the grant pending.
      setPermissionMessage(
        result.observed?.policyAttached === false
          ? "Privy todavía no muestra el firmante con la política asignada. Volvé a intentar o revisá el permiso en Privy."
          : "Privy no pudo confirmar que este permiso es tuyo. Volvé a intentar.",
      );
    } catch (error) {
      setPermissionMessage(getErrorMessage(error));
    }
  }

  async function handleRevoke() {
    setIsRevoking(true);
    setPermissionMessage(null);
    try {
      const result = await api.revokeWalletPermission();
      if (result.remote === "revoked") {
        toast.success("Revocaste el permiso de pagos.");
      } else {
        setPermissionMessage(
          "El permiso quedó marcado para revocar, pero el proveedor no lo pudo confirmar.",
        );
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.walletPermission(userId) });
    } catch (error) {
      // Provider-unavailable revoke: locally the grant stays 'revoking'; it must
      // NEVER be shown as remotely revoked. Fail closed.
      setPermissionMessage(
        "No pudimos confirmar la revocación con el proveedor. No lo marques como hecho; seguimos revisando.",
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.walletPermission(userId) });
    } finally {
      setIsRevoking(false);
    }
  }

  // The button must appear in BOTH identity modes: in privy mode the click
  // branches into the PEW-014 prepare/addSigners/complete enrollment; in demo
  // mode it performs the direct activation with server read-back. Gating on
  // !privy here deadlocked privy users (button never rendered).
  const canActivate =
    wallet.state === "ready" &&
    (permission.state === "pending" || permission.state === "unavailable");

  return (
    <section className="surface-card mt-10 p-5" aria-label="Tu billetera y el permiso de pagos">
      {privy && userId ? (
        <Suspense fallback={null}>
          <PrivyWalletSync userId={userId} />
        </Suspense>
      ) : null}
      <div className="flex items-center gap-2">
        <Wallet className="size-7 text-brand-ink" strokeWidth={2.4} aria-hidden="true" />
        <h2 className="text-xl font-extrabold">Tu billetera y el permiso de pagos</h2>
      </div>

      <div className="mt-4">
        <p className="text-base font-bold text-muted-foreground">Estado de la billetera</p>
        <div className="mt-2">
          <WalletStateBadge state={wallet.state} />
        </div>
        {wallet.address ? (
          <p className="mt-2 break-all text-base text-muted-foreground">
            Dirección: {shortenAddress(wallet.address)}
          </p>
        ) : null}
        {userId ? (
          <div className="mt-4 rounded-2xl border border-border bg-card p-4">
            {/* Trusted recipients feed the activation allowlist (Q3): adding
            one here refreshes contactsQuery, which handleActivate maps
            to recipients. */}
            <AddTrustedRecipient
              userId={userId}
              onContactsChanged={() => void contactsQuery.refetch()}
            />
          </div>
        ) : null}
        {wallet.state !== "ready" ? (
          <Button
            type="button"
            variant="outline"
            className="press mt-4 min-h-12 w-full text-base font-extrabold"
            onClick={() => void handleSync()}
            disabled={isSyncing}
          >
            {isSyncing ? (
              <Loader2 className="size-5 animate-spin" aria-hidden="true" />
            ) : (
              <Wallet className="size-5" aria-hidden="true" />
            )}
            {wallet.state === "unprovisioned" || wallet.state === "conflict"
              ? "Sincronizar billetera"
              : "Reintentar"}
          </Button>
        ) : null}
      </div>

      <hr className="my-6 border-border" />

      <div>
        <p className="text-base font-bold text-muted-foreground">Permiso de pagos</p>

        {isActive ? (
          <>
            <div className="mt-2">
              <span className="inline-flex items-center gap-2 rounded-full bg-success-surface px-3 py-1 text-base font-extrabold text-success-surface-foreground">
                <CheckCircle2 className="size-5" strokeWidth={2.4} aria-hidden="true" />
                {PERMISSION_STATE_LABELS[permission.state]}
              </span>
            </div>

            <p className="mt-3 text-lg font-extrabold">Indefinido y revocable</p>
            <p className="text-base text-muted-foreground">
              Autorizaste pagos sin fecha de vencimiento. Podés revocarlo cuando quieras.
            </p>

            <dl className="mt-4 space-y-2 text-base">
              <div className="flex justify-between gap-4">
                <dt className="font-bold">Por transferencia</dt>
                <dd className="text-right font-extrabold">
                  {permission.perTransferSol !== ""
                    ? `${permission.perTransferSol} SOL`
                    : `${permission.perTransferUsdc} USDC`}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="font-bold">Acumulado</dt>
                <dd className="text-right font-extrabold">
                  {permission.perTransferSol !== ""
                    ? "Pendiente en SOL"
                    : `${permission.rollingTotalUsdc} USDC ${formatWindowLabel(permission.rollingWindowSeconds)}`}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="font-bold">Ventana</dt>
                <dd className="text-right">rodante de {permission.rollingWindowSeconds} s</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="font-bold">Comisiones</dt>
                <dd className="text-right">
                  {permission.gasCeiling ? `hasta ${permission.gasCeiling}` : "se cobran aparte"}{" "}
                  (no descuentan de los topes)
                </dd>
              </div>
            </dl>

            {permission.recipients.length > 0 ? (
              <div className="mt-4">
                <p className="text-base font-bold text-muted-foreground">Destinos autorizados</p>
                <ul className="mt-2 space-y-1">
                  {permission.recipients.map((recipient) => (
                    <li key={recipient} className="break-all text-base text-muted-foreground">
                      {shortenAddress(recipient)}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <Button
              type="button"
              variant="outline"
              className="press mt-6 min-h-12 w-full text-base font-extrabold"
              onClick={() => void handleRevoke()}
              disabled={isRevoking}
            >
              {isRevoking ? (
                <Loader2 className="size-5 animate-spin" aria-hidden="true" />
              ) : (
                <ShieldAlert className="size-5" aria-hidden="true" />
              )}
              Revocar permiso
            </Button>
          </>
        ) : (
          <>
            <div className="mt-2">
              <span className="inline-flex items-center gap-2 rounded-full bg-secondary px-3 py-1 text-base font-extrabold text-secondary-foreground">
                <ShieldAlert className="size-5" strokeWidth={2.4} aria-hidden="true" />
                {PERMISSION_STATE_LABELS[permission.state]}
              </span>
            </div>

            {permission.state === "revoking" ? (
              <p className="mt-3 text-base text-muted-foreground">
                Estamos revocando el permiso con el proveedor. Esto puede tardar un momento.
              </p>
            ) : (
              <p className="mt-3 text-base text-muted-foreground">
                No hay un permiso de pagos activo. Sin un permiso activo, no se pueden habilitar
                pagos.
              </p>
            )}

            {privy && preparation ? (
              // PEW-014: step 2 of enrollment — the user consents in the Privy
              // modal (addSigners with the backend quorum + immutable policy),
              // then the server read-back (complete) decides activation.
              <Suspense fallback={<RoutePendingInline />}>
                <p className="mb-3 text-sm font-semibold" role="status">
                  Tope máximo por transferencia:{" "}
                  {preparation.perTransferSol !== ""
                    ? `${preparation.perTransferSol} SOL`
                    : `${preparation.perTransferUsdc} USDC`}
                  .
                </p>
                <PrivySignerEnrollment
                  walletAddress={preparation.walletAddress}
                  quorumId={preparation.quorumId}
                  policyId={preparation.policyId}
                  busy={isActivating}
                  onEnrolled={() => handlePrivyComplete()}
                  onError={(message) => setPermissionMessage(message)}
                />
              </Suspense>
            ) : null}

            {canActivate && !(privy && preparation) ? (
              <Button
                type="button"
                className="press mt-4 min-h-14 w-full text-base font-extrabold"
                onClick={() => void handleActivate()}
                disabled={isActivating}
              >
                {isActivating ? (
                  <Loader2 className="size-5 animate-spin" aria-hidden="true" />
                ) : (
                  <ShieldCheck className="size-5" aria-hidden="true" />
                )}
                Activar permiso de pagos
              </Button>
            ) : null}
          </>
        )}

        {permissionMessage ? (
          <p
            className="mt-5 rounded-2xl border border-border bg-destructive-surface p-4 text-base font-bold text-destructive-surface-foreground"
            role="alert"
          >
            {permissionMessage}
          </p>
        ) : null}
      </div>
    </section>
  );
}
