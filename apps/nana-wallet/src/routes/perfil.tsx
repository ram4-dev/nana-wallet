import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { CalendarDays, CalendarHeart, Copy, ReceiptText, Users } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { ConfirmarPlata } from "@/components/ConfirmarPlata";
import { EmptyState, RouteError, RoutePending } from "@/components/RouteStates";
import { Button } from "@/components/ui/button";
import { api, getErrorMessage, queryKeys } from "@/lib/api";
import type { AgentTurn, Bill, ConfirmableIntent, Contact } from "@/lib/api-types";

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

export const Route = createFileRoute("/perfil")({
  head: () => ({
    meta: [
      { title: "Mi perfil y agenda | Nana Wallet" },
      {
        name: "description",
        content: "Tus datos, tu familia guardada, tu agenda y el calendario de facturas por pagar.",
      },
      { property: "og:title", content: "Mi perfil y agenda" },
      {
        property: "og:description",
        content: "Contactos, fechas importantes y facturas, todo en un solo lugar.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  pendingComponent: () => <RoutePending label="Estamos buscando tu perfil y tu agenda" />,
  errorComponent: ({ error, reset }) => <RouteError error={error} onRetry={reset} />,
  component: PerfilPage,
});

function formatAgendaDate(date: string) {
  return new Intl.DateTimeFormat("es-AR", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
}

function contactName(contact: Contact) {
  return `${contact.displayName} (${contact.relationship.toLocaleLowerCase("es-AR")})`;
}

function PerfilPage() {
  const queryClient = useQueryClient();
  const [copyStatus, setCopyStatus] = useState<{ contactId: string; message: string } | null>(null);
  const [copyingContactId, setCopyingContactId] = useState<string | null>(null);
  const [preparingId, setPreparingId] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [activeIntent, setActiveIntent] = useState<ConfirmableIntent | null>(null);
  const [agentTurn, setAgentTurn] = useState<AgentTurn | null>(null);
  const [agentTurnId, setAgentTurnId] = useState<string | null>(null);

  const { from: agendaFrom, to: agendaTo } = getAgendaWindow();

  const meQuery = useQuery({ queryKey: queryKeys.me, queryFn: api.getMe });
  const contactsQuery = useQuery({ queryKey: queryKeys.contacts, queryFn: api.getContacts });
  const agendaQuery = useQuery({
    queryKey: queryKeys.agenda(agendaFrom, agendaTo),
    queryFn: () => api.getAgenda({ from: agendaFrom, to: agendaTo }),
  });
  const billsQuery = useQuery({ queryKey: queryKeys.bills, queryFn: () => api.getBills() });
  const walletQuery = useQuery({ queryKey: queryKeys.wallet, queryFn: api.getWalletSummary });

  const isPending =
    meQuery.isPending ||
    contactsQuery.isPending ||
    agendaQuery.isPending ||
    billsQuery.isPending ||
    walletQuery.isPending;
  const firstError =
    meQuery.error ??
    contactsQuery.error ??
    agendaQuery.error ??
    billsQuery.error ??
    walletQuery.error;

  function refetchAll() {
    void Promise.all([
      meQuery.refetch(),
      contactsQuery.refetch(),
      agendaQuery.refetch(),
      billsQuery.refetch(),
      walletQuery.refetch(),
    ]);
  }

  async function copyCbu(contact: Contact) {
    setCopyingContactId(contact.id);
    setCopyStatus(null);
    let cbu: string;
    try {
      const response = await api.revealContactCbu(contact.id);
      cbu = response.cbu;
    } catch (error) {
      setCopyStatus({
        contactId: contact.id,
        message: getErrorMessage(error),
      });
      setCopyingContactId(null);
      return;
    }

    try {
      await navigator.clipboard.writeText(cbu);
      const message = `Copiaste el CBU de ${contact.displayName}`;
      setCopyStatus({ contactId: contact.id, message });
      toast.success(message);
    } catch {
      setCopyStatus({
        contactId: contact.id,
        message: "El teléfono no pudo copiar el CBU. Probá de nuevo.",
      });
    } finally {
      setCopyingContactId(null);
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
    setAgentTurnId(null);
    try {
      const intent = await api.createBillPaymentIntent(bill.id, { accountId: pesosAccount.id });
      setActiveIntent({ kind: "bill_payment", ...intent });
    } catch (error) {
      setActionMessage(getErrorMessage(error));
    } finally {
      setPreparingId(null);
    }
  }

  async function prepareSuggestedAction(label: string, eventId: string) {
    setPreparingId(eventId);
    setActionMessage(null);
    try {
      const nextTurn = await api.agentTurn({
        sessionId: null,
        input: { kind: "text", text: label },
      });
      setAgentTurn(nextTurn);
      setAgentTurnId(nextTurn.turnId);
      if (nextTurn.proposal && !nextTurn.transcript) setActiveIntent(nextTurn.proposal);
    } catch (error) {
      setActionMessage(getErrorMessage(error));
    } finally {
      setPreparingId(null);
    }
  }

  async function closeConfirmation() {
    const turnId = agentTurnId;
    setActiveIntent(null);
    setAgentTurn(null);
    setAgentTurnId(null);
    if (!turnId) return;
    try {
      await api.rejectAgentTurn(turnId);
    } catch (error) {
      setActionMessage(getErrorMessage(error));
    }
  }

  function refreshMoneyQueries() {
    void queryClient.invalidateQueries({ queryKey: queryKeys.wallet });
    void queryClient.invalidateQueries({ queryKey: queryKeys.movements });
    void queryClient.invalidateQueries({ queryKey: queryKeys.bills });
  }

  function closeReceipt() {
    setActiveIntent(null);
    setAgentTurn(null);
    setAgentTurnId(null);
    refreshMoneyQueries();
  }

  /**
   * El usuario sale sin saber si la plata se movió. Cerramos igual que un recibo,
   * refrescando saldo y movimientos, para que lo primero que vea sea el estado real.
   */
  function closeAfterUnknownOutcome() {
    setActiveIntent(null);
    setAgentTurn(null);
    setAgentTurnId(null);
    setActionMessage("Fijate en tu saldo y en tus movimientos si la operación se hizo.");
    refreshMoneyQueries();
  }

  if (isPending) return <RoutePending label="Estamos buscando tu perfil y tu agenda" />;
  if (firstError) return <RouteError error={firstError} onRetry={refetchAll} />;
  if (
    !meQuery.data ||
    !contactsQuery.data ||
    !agendaQuery.data ||
    !billsQuery.data ||
    !walletQuery.data
  ) {
    return <RoutePending label="Estamos buscando tu perfil y tu agenda" />;
  }

  const me = meQuery.data;
  const contacts = contactsQuery.data;
  const events = agendaQuery.data;
  const bills = billsQuery.data;

  return (
    <main className="mx-auto max-w-md px-6 pt-12 pb-40">
      <section className="surface-card flex items-center gap-4 p-5">
        <div className="plastic flex size-16 shrink-0 items-center justify-center rounded-full text-2xl font-extrabold">
          {me.initials}
        </div>
        <div>
          <h1 className="text-2xl font-extrabold">{me.displayName}</h1>
          <p className="mt-1 text-base text-muted-foreground">
            DNI terminado en {me.documentLast3}
          </p>
          <p className="text-base text-muted-foreground">{me.city}</p>
        </div>
      </section>

      <h2 className="mt-10 flex items-center gap-2 text-xl font-extrabold">
        <Users className="size-6 text-primary" strokeWidth={2.4} aria-hidden="true" /> Mi familia
        guardada
      </h2>
      {contacts.length === 0 ? (
        <EmptyState>
          Todavía no tenés familiares guardados. Cuando agregues uno, va a aparecer acá.
        </EmptyState>
      ) : (
        <ul className="mt-4 space-y-3">
          {contacts.map((contact) => (
            <li key={contact.id} className="surface-card p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-lg font-bold">{contactName(contact)}</p>
                  <p className="mt-1 break-words text-base text-muted-foreground">
                    {contact.alias ?? "Sin alias guardado"}
                  </p>
                  <p className="text-base text-muted-foreground">
                    CBU terminado en {contact.cbuLast4}
                  </p>
                </div>
                <button
                  type="button"
                  className="press shrink-0 rounded-xl bg-secondary p-4 text-secondary-foreground"
                  aria-label={`Copiar CBU de ${contact.displayName}`}
                  onClick={() => void copyCbu(contact)}
                  disabled={copyingContactId === contact.id}
                >
                  <Copy className="size-6" strokeWidth={2.4} aria-hidden="true" />
                </button>
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

      <section className="mt-10 rounded-3xl border-2 border-primary/45 bg-accent/5 p-5">
        <h2 className="flex items-center gap-2 text-xl font-extrabold">
          <CalendarHeart className="size-7 text-primary" strokeWidth={2.4} aria-hidden="true" /> Mi
          agenda
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
                <p className="mt-1 text-base font-bold text-primary">
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
                      void prepareSuggestedAction(event.suggestedAction?.label ?? "", event.id)
                    }
                    disabled={preparingId === event.id}
                  >
                    {preparingId === event.id ? "Preparando" : event.suggestedAction.label}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {agentTurn?.transcript && agentTurn.proposal && !activeIntent ? (
        <section className="surface-card mt-5 border-2 border-primary p-5" aria-live="polite">
          <p className="text-lg font-extrabold">Escuché:</p>
          <p className="mt-2 text-xl">{agentTurn.transcript}</p>
          <Button
            className="press mt-5 min-h-16 w-full whitespace-normal text-lg font-extrabold"
            onClick={() => setActiveIntent(agentTurn.proposal)}
          >
            Revisar antes de confirmar
          </Button>
        </section>
      ) : null}

      <h2 className="mt-10 flex items-center gap-2 text-xl font-extrabold">
        <CalendarDays className="size-6 text-primary" strokeWidth={2.4} aria-hidden="true" />
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
          className="mt-5 rounded-2xl bg-destructive/10 p-4 text-lg font-bold text-destructive"
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
          onExpired={() => void closeConfirmation()}
          onCloseReceipt={closeReceipt}
          onUnknownOutcome={closeAfterUnknownOutcome}
        />
      ) : null}
    </main>
  );
}
