import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CalendarDays,
  CalendarHeart,
  Copy,
  Pen,
  Plus,
  ReceiptText,
  Trash2,
  Users,
} from "lucide-react";
import { useMemo, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { ConfirmarPlata } from "@/components/ConfirmarPlata";
import { EmptyState } from "@/components/RouteStates";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, createConversationTurnSender, getErrorMessage, queryKeys } from "@/lib/api";
import { SOLANA_DEVNET_CHAIN_ID } from "@/lib/api-types";
import type { Bill, ConfirmableIntent, Contact, ConversationTurnResult } from "@/lib/api-types";
import {
  runExclusiveConversationAction,
  shouldLockAfterConversationResolution,
  UNKNOWN_CONVERSATION_OUTCOME_MESSAGE,
} from "@/lib/session-action-lock";
import { WalletLifecycle } from "@/features/wallet/WalletLifecycle";

/**
 * wallet-profile (WP-002/WP-015): preserved legacy profile sections.
 *
 * /perfil no longer mounts these: the simple profile screen now renders only
 * the identity data (WP-001). The contacts, agenda and bills features —
 * including their conversation/confirmation logic and the WalletLifecycle
 * mount — are preserved verbatim here so no prior work is deleted. They are
 * NOT mounted by the simplified screen; re-exposing them is a scope decision.
 */

const AGENDA_WINDOW_DAYS = 90;

/**
 * Se calcula por render, no a nivel de modulo. En un isolate caliente de Cloudflare
 * o en una pestaña que queda abierta varios dias, una constante de modulo deja la
 * ventana anclada a la fecha del primer request y el queryKey nunca cambia.
 */
function getAgendaWindow() {
  const today = new Date();
  const end = new Date(today);
  end.setDate(end.getDate() + AGENDA_WINDOW_DAYS);
  return { from: today.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

function formatAgendaDate(date: string) {
  return new Intl.DateTimeFormat("es-AR", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
}

type ContactFormState = { mode: "create" } | { mode: "edit"; contact: Contact };

export function LegacyProfileSections({ userId }: { userId: string | undefined }) {
  const queryClient = useQueryClient();
  const [copyStatus, setCopyStatus] = useState<{ contactId: string; message: string } | null>(null);
  const [copyingContactId, setCopyingContactId] = useState<string | null>(null);
  const [preparingId, setPreparingId] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [activeIntent, setActiveIntent] = useState<ConfirmableIntent | null>(null);
  const [agentTurn, setAgentTurn] = useState<ConversationTurnResult | null>(null);
  const [contactForm, setContactForm] = useState<ContactFormState | null>(null);
  const [formName, setFormName] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formAddress, setFormAddress] = useState("");
  const [contactError, setContactError] = useState<string | null>(null);
  const [contactActionId, setContactActionId] = useState<string | null>(null);
  const [, setConversationId] = useState<string | null>(null);
  const conversationIdRef = useRef<string | null>(null);
  const sessionActionLockRef = useRef(false);
  const confirmationPendingRef = useRef(false);
  const sessionActionsLockedRef = useRef(false);
  const [isSessionActionPending, setIsSessionActionPending] = useState(false);
  const [isAgentConfirmationPending, setIsAgentConfirmationPending] = useState(false);
  const [areSessionActionsLocked, setAreSessionActionsLocked] = useState(false);
  const [sessionActionId, setSessionActionId] = useState<string | null>(null);
  const sendConversationTurn = useMemo(
    () =>
      createConversationTurnSender(
        () => conversationIdRef.current,
        (nextConversationId) => {
          conversationIdRef.current = nextConversationId;
          setConversationId(nextConversationId);
        },
      ),
    [],
  );

  const { from: agendaFrom, to: agendaTo } = getAgendaWindow();

  const contactsQuery = useQuery({
    queryKey: queryKeys.contacts(userId),
    queryFn: api.getContacts,
    enabled: Boolean(userId),
  });
  const agendaQuery = useQuery({
    queryKey: queryKeys.agenda(userId, agendaFrom, agendaTo),
    queryFn: () => api.getAgenda({ from: agendaFrom, to: agendaTo }),
    enabled: Boolean(userId),
  });
  const billsQuery = useQuery({
    queryKey: queryKeys.bills(userId),
    queryFn: () => api.getBills(),
    enabled: Boolean(userId),
  });
  const walletQuery = useQuery({
    queryKey: queryKeys.wallet(userId),
    queryFn: api.getWalletSummary,
    enabled: Boolean(userId),
  });

  // Agenda/bills/wallet-summary are frontend features whose only provider
  // today is the dev MSW worker; against the real fixture backend they have
  // no routes yet. Their failures degrade those sections gracefully and
  // never fail the page (PMU-025 browser E2E runs the real backend).

  async function copyContactAddress(contact: Contact) {
    setCopyingContactId(contact.id);
    setCopyStatus(null);
    let address: string;
    try {
      const response = await api.revealContactCbu(contact.id);
      address = response.address;
    } catch (error) {
      setCopyStatus({
        contactId: contact.id,
        message: getErrorMessage(error),
      });
      setCopyingContactId(null);
      return;
    }

    try {
      await navigator.clipboard.writeText(address);
      const message = `Copiaste la dirección de ${contact.name}`;
      setCopyStatus({ contactId: contact.id, message });
      toast.success(message);
    } catch {
      setCopyStatus({
        contactId: contact.id,
        message: "El teléfono no pudo copiar la dirección. Probá de nuevo.",
      });
    } finally {
      setCopyingContactId(null);
    }
  }

  function openCreateContact() {
    setContactForm({ mode: "create" });
    setFormName("");
    setFormDescription("");
    setFormAddress("");
    setContactError(null);
  }

  function openEditContact(contact: Contact) {
    setContactForm({ mode: "edit", contact });
    setFormName(contact.name);
    setFormDescription(contact.description);
    setFormAddress(contact.address);
    setContactError(null);
  }

  function closeContactForm() {
    setContactForm(null);
    setContactError(null);
  }

  async function saveContact(event: FormEvent) {
    event.preventDefault();
    const name = formName.trim();
    const description = formDescription.trim();
    const address = formAddress.trim();
    if (!name) {
      setContactError("Poné un nombre.");
      return;
    }
    if (!address) {
      setContactError("Poné la dirección o el CBU.");
      return;
    }
    setContactError(null);
    const actionId = contactForm?.mode === "edit" ? contactForm.contact.id : "new";
    setContactActionId(actionId);
    try {
      if (contactForm?.mode === "edit") {
        await api.updateContact(contactForm.contact.id, {
          name,
          description,
          address,
          expectedVersion: contactForm.contact.version,
          expectedPolicyRevision: contactForm.contact.permission.desiredRevision,
        });
        toast.success(`Actualizamos a ${name}.`);
      } else {
        await api.createContact({ name, description, address });
        toast.success(`Guardamos a ${name}.`);
      }
      setContactForm(null);
      void contactsQuery.refetch();
    } catch (error) {
      setContactError(getErrorMessage(error));
    } finally {
      setContactActionId(null);
    }
  }

  async function deleteContact(contact: Contact) {
    setContactActionId(contact.id);
    setContactError(null);
    try {
      const preview = await api.getContactRemovalPreview(contact.id, contact.version);
      await api.deleteContact(contact.id, {
        expectedVersion: contact.version,
        expectedRevokedGrantIds: preview.revokedGrantIds,
      });
      toast.success(`Sacamos a ${contact.name} de tu familia guardada.`);
      void contactsQuery.refetch();
    } catch (error) {
      setContactError(getErrorMessage(error));
    } finally {
      setContactActionId(null);
    }
  }

  async function prepareBillPayment(bill: Bill) {
    const pesosAccount = walletQuery.data?.accounts.find((account) => account.kind === "pesos");
    if (!pesosAccount) {
      setActionMessage("No encontramos tu cuenta en pesos. Probá de nuevo en un ratito.");
      return;
    }
    setPreparingId(bill.id);
    setActionMessage(null);
    try {
      const intent = await api.createBillPaymentIntent(bill.id, { accountId: pesosAccount.id });
      setActiveIntent({ kind: "bill_payment", ...intent });
    } catch (error) {
      setActionMessage(getErrorMessage(error));
    } finally {
      setPreparingId(null);
    }
  }

  function lockUnknownAgentOutcome() {
    confirmationPendingRef.current = false;
    sessionActionsLockedRef.current = true;
    setIsAgentConfirmationPending(false);
    setAreSessionActionsLocked(true);
    setAgentTurn(null);
    setActionMessage(UNKNOWN_CONVERSATION_OUTCOME_MESSAGE);
    refreshMoneyQueries();
  }

  function runAgentAction(message: string, kind: "new" | "resolution", actionId: string) {
    if (sessionActionsLockedRef.current) return;
    if (kind === "new" && confirmationPendingRef.current) return;

    const request = runExclusiveConversationAction(sessionActionLockRef, async () => {
      setIsSessionActionPending(true);
      setSessionActionId(actionId);
      setActionMessage(null);
      try {
        const nextTurn = await sendConversationTurn(message);
        if (kind === "resolution" && shouldLockAfterConversationResolution(nextTurn, "response")) {
          lockUnknownAgentOutcome();
          return;
        }

        const nextConfirmationPending = nextTurn.status === "confirmation_required";
        confirmationPendingRef.current = nextConfirmationPending;
        setIsAgentConfirmationPending(nextConfirmationPending);
        setAgentTurn(nextTurn);
        if (nextTurn.status === "error") setActionMessage(nextTurn.message);
        if (nextTurn.status === "sent") refreshMoneyQueries();
      } catch (error) {
        if (kind === "resolution" && shouldLockAfterConversationResolution(error, "thrown")) {
          lockUnknownAgentOutcome();
        } else {
          setActionMessage(getErrorMessage(error));
        }
      } finally {
        setIsSessionActionPending(false);
        setSessionActionId(null);
      }
    });

    void request;
  }

  function prepareSuggestedAction(label: string, eventId: string) {
    runAgentAction(label, "new", eventId);
  }

  function sendAgentFollowup(message: "confirm" | "cancel") {
    runAgentAction(message, "resolution", "agent-confirmation");
  }

  function closeConfirmation() {
    setActiveIntent(null);
  }

  function refreshMoneyQueries() {
    void queryClient.invalidateQueries({ queryKey: queryKeys.wallet(userId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.movements(userId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.bills(userId) });
    // WP-014: money refreshes also invalidate the personal balances cache.
    if (userId) {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.balances(userId, SOLANA_DEVNET_CHAIN_ID),
      });
    }
  }

  function closeReceipt() {
    setActiveIntent(null);
    refreshMoneyQueries();
  }

  /**
   * El usuario sale sin saber si la plata se movió. Cerramos igual que un recibo,
   * refrescando saldo y movimientos, para que lo primero que vea sea el estado real.
   */
  function closeAfterUnknownOutcome() {
    setActiveIntent(null);
    setActionMessage("Fijate en tu saldo y en tus movimientos si la operación se hizo.");
    refreshMoneyQueries();
  }

  const contacts = contactsQuery.data ?? [];
  // Degraded defaults when the MSW-only features have no real backend.
  const events = agendaQuery.data ?? [];
  const bills = billsQuery.data ?? [];

  return (
    <>
      <WalletLifecycle userId={userId} />

      <h2 className="mt-10 flex items-center gap-2 text-xl font-extrabold">
        <Users className="size-6 text-brand-ink" strokeWidth={2.4} aria-hidden="true" /> Mi familia
        guardada
      </h2>
      <Button
        type="button"
        variant="outline"
        className="press mt-3 min-h-12 w-full text-base font-extrabold"
        onClick={openCreateContact}
      >
        <Plus className="size-5" aria-hidden="true" /> Agregar una persona
      </Button>

      {contactForm ? (
        <form onSubmit={saveContact} className="surface-card mt-4 space-y-3 p-4">
          <h3 className="text-lg font-extrabold">
            {contactForm.mode === "edit" ? "Editar persona" : "Agregar persona"}
          </h3>
          <Input
            value={formName}
            onChange={(event) => setFormName(event.target.value)}
            placeholder="Nombre"
            aria-label="Nombre"
          />
          <Input
            value={formDescription}
            onChange={(event) => setFormDescription(event.target.value)}
            placeholder="¿Quién es? (opcional)"
            aria-label="Descripción"
          />
          <Input
            value={formAddress}
            onChange={(event) => setFormAddress(event.target.value)}
            placeholder="CBU o dirección"
            aria-label="CBU o dirección"
          />
          {contactError ? (
            <p className="text-base font-bold text-destructive" role="alert">
              {contactError}
            </p>
          ) : null}
          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant="outline"
              className="press min-h-12 font-extrabold"
              onClick={closeContactForm}
            >
              Cancelar
            </Button>
            <Button
              type="submit"
              className="press min-h-12 font-extrabold"
              disabled={
                contactActionId === (contactForm.mode === "edit" ? contactForm.contact.id : "new")
              }
            >
              {contactActionId === (contactForm.mode === "edit" ? contactForm.contact.id : "new")
                ? "Guardando"
                : "Guardar"}
            </Button>
          </div>
        </form>
      ) : null}

      {!contactsQuery.data || contactsQuery.isPending ? (
        <p className="mt-4 text-base text-muted-foreground">Buscando a tu gente…</p>
      ) : contacts.length === 0 ? (
        <EmptyState>
          Todavía no tenés familiares guardados. Cuando agregues uno, va a aparecer acá.
        </EmptyState>
      ) : (
        <ul className="mt-4 space-y-3">
          {contacts.map((contact) => (
            <li key={contact.id} className="surface-card p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-lg font-bold">{contact.name}</p>
                  {contact.description ? (
                    <p className="mt-1 break-words text-base text-muted-foreground">
                      {contact.description}
                    </p>
                  ) : null}
                  <p className="mt-1 break-all text-base text-muted-foreground">
                    {contact.address}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col gap-2">
                  <button
                    type="button"
                    className="press rounded-xl bg-secondary p-4 text-secondary-foreground"
                    aria-label={`Copiar dirección de ${contact.name}`}
                    onClick={() => void copyContactAddress(contact)}
                    disabled={copyingContactId === contact.id}
                  >
                    <Copy className="size-6" strokeWidth={2.4} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="press rounded-xl bg-secondary p-4 text-secondary-foreground"
                    aria-label={`Editar a ${contact.name}`}
                    onClick={() => openEditContact(contact)}
                  >
                    <Pen className="size-6" strokeWidth={2.4} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="press rounded-xl bg-destructive-surface p-4 text-destructive-surface-foreground"
                    aria-label={`Eliminar a ${contact.name}`}
                    onClick={() => void deleteContact(contact)}
                    disabled={contactActionId === contact.id}
                  >
                    <Trash2 className="size-6" strokeWidth={2.4} aria-hidden="true" />
                  </button>
                </div>
              </div>
              {copyStatus?.contactId === contact.id ? (
                <p className="mt-3 text-base font-bold" role="status">
                  {copyStatus.message}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <section className="mt-10 rounded-2xl border border-border bg-secondary p-5">
        <h2 className="flex items-center gap-2 text-xl font-extrabold">
          <CalendarHeart className="size-7 text-brand-ink" strokeWidth={2.4} aria-hidden="true" />{" "}
          Mi agenda
        </h2>
        <p className="mt-2 text-lg text-muted-foreground">
          Cumpleaños, turnos y recordatorios importantes.
        </p>
        {events.length === 0 ? (
          <p className="mt-4 rounded-2xl bg-card p-5 text-lg text-muted-foreground">
            No tenés fechas guardadas para los próximos días.
          </p>
        ) : (
          <ul className="mt-4 space-y-4">
            {events.map((event) => (
              <li key={event.id} className="rounded-2xl border border-border bg-card p-4">
                <p className="text-lg font-extrabold">{event.title}</p>
                <p className="mt-1 text-base font-bold text-brand-ink">
                  {formatAgendaDate(event.date)}
                </p>
                {event.note ? (
                  <p className="mt-1 text-base text-muted-foreground">{event.note}</p>
                ) : null}
                {event.suggestedAction ? (
                  <Button
                    variant="outline"
                    className="press mt-4 min-h-14 w-full whitespace-normal text-lg font-extrabold"
                    onClick={() =>
                      prepareSuggestedAction(event.suggestedAction?.label ?? "", event.id)
                    }
                    disabled={
                      isSessionActionPending ||
                      isAgentConfirmationPending ||
                      areSessionActionsLocked
                    }
                  >
                    {sessionActionId === event.id ? "Preparando" : event.suggestedAction.label}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {agentTurn ? (
        <section className="surface-card mt-4 border-2 border-brand-ink p-4" aria-live="polite">
          <p className="text-base leading-snug">{agentTurn.message}</p>
          {agentTurn.status === "confirmation_required" ? (
            <>
              <dl className="mt-3 space-y-1.5 text-sm sm:text-base">
                <div className="flex justify-between gap-4">
                  <dt className="font-bold">Monto</dt>
                  <dd>
                    {agentTurn.preview.amount} {agentTurn.preview.token}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="font-bold">Destino</dt>
                  <dd className="break-all text-right">{agentTurn.preview.recipient}</dd>
                </div>
              </dl>
              <div className="mt-3 grid w-full grid-cols-1">
                <Button
                  variant="outline"
                  className="press min-h-12 whitespace-normal text-base font-extrabold"
                  onClick={() => sendAgentFollowup("cancel")}
                  disabled={isSessionActionPending || areSessionActionsLocked}
                >
                  Cancelar
                </Button>
              </div>
            </>
          ) : null}
        </section>
      ) : null}

      <h2 className="mt-10 flex items-center gap-2 text-xl font-extrabold">
        <CalendarDays className="size-6 text-brand-ink" strokeWidth={2.4} aria-hidden="true" />
        Facturas del mes
      </h2>
      {bills.length === 0 ? (
        <EmptyState>
          No tenés facturas para este mes. Cuando llegue una, la vas a ver acá.
        </EmptyState>
      ) : (
        <ul className="mt-4 space-y-3">
          {bills.map((bill) => (
            <li key={bill.id} className="surface-card p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-lg font-bold">{bill.provider}</p>
                  <p className="text-base text-muted-foreground">Vence {bill.dueDateHuman}</p>
                </div>
                <div className="text-right">
                  <p className="text-lg font-extrabold">{bill.amount.display}</p>
                  <p
                    className={`text-base font-bold ${
                      bill.status === "vencida" ? "text-destructive" : "text-muted-foreground"
                    }`}
                  >
                    {bill.statusHuman}
                  </p>
                </div>
              </div>
              {bill.canPayNow ? (
                <Button
                  variant="outline"
                  className="press mt-4 min-h-14 w-full text-lg font-extrabold"
                  onClick={() => void prepareBillPayment(bill)}
                  disabled={preparingId === bill.id}
                >
                  <ReceiptText className="size-6" aria-hidden="true" />
                  {preparingId === bill.id ? "Preparando" : "Pagar ahora"}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {actionMessage ? (
        <p
          className="mt-5 rounded-2xl bg-destructive-surface text-destructive-surface-foreground border border-border p-4 text-lg font-bold"
          role="alert"
        >
          {actionMessage}
        </p>
      ) : null}

      {activeIntent ? (
        <ConfirmarPlata
          key={activeIntent.intentId}
          intent={activeIntent}
          onCancel={closeConfirmation}
          onExpired={closeConfirmation}
          onCloseReceipt={closeReceipt}
          onUnknownOutcome={closeAfterUnknownOutcome}
        />
      ) : null}
    </>
  );
}
