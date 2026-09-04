import { http, HttpResponse, passthrough } from "msw";

import type {
  AgendaEvent,
  ApiEnvelope,
  Bill,
  Contact,
  CreateAgendaEventInput,
  CreateContactInput,
  EmptyResponse,
  ErrCode,
  Me,
  MovementsPage,
  PaymentIntent,
  PaymentResult,
  ConversationTurnResult,
  TransferIntentInput,
  UpdateContactInput,
  WalletSummary,
} from "@/lib/api-types";
import { shouldUseLiveAgentBackend } from "@/lib/live-agent";
import { classifySessionSubmission } from "@/lib/session-resolution";

const apiPath = (path: string) => `*/v1${path}`;

function ok<T>(data: T, status = 200) {
  return HttpResponse.json<ApiEnvelope<T>>({ ok: true, data }, { status });
}

function err(code: ErrCode, message: string, status: number, field?: string) {
  return HttpResponse.json<ApiEnvelope<never>>(
    {
      ok: false,
      error: { code, message, ...(field ? { field } : {}) },
    },
    { status },
  );
}

let walletSummary: WalletSummary = {
  total: { amount: "2999800", currency: "ARS", display: "$ 2.999.800" },
  accounts: [
    {
      id: "pesos-1",
      name: "Pesos disponibles",
      subtitle: "En la cuenta",
      balance: { amount: "412300", currency: "ARS", display: "$ 412.300" },
      kind: "pesos",
    },
    {
      id: "dolares-1",
      name: "Dólares",
      subtitle: "más o menos $1.687.500",
      balance: { amount: "1250", currency: "USD", display: "US$ 1.250" },
      approxInArs: { amount: "1687500", currency: "ARS", display: "$ 1.687.500" },
      kind: "dolares",
    },
    {
      id: "plazo-1",
      name: "Plazo fijo",
      subtitle: "Se libera el 3 de octubre",
      balance: { amount: "900000", currency: "ARS", display: "$ 900.000" },
      kind: "plazo_fijo",
      maturesOn: "2026-10-03",
    },
  ],
  updatedAt: "2026-08-22T10:42:00-03:00",
};

let movements: MovementsPage["items"] = [
  {
    id: "mov-1",
    kind: "entrada",
    title: "Jubilación ANSES",
    subtitle: "Hoy, 10:42",
    amount: { amount: "305000", currency: "ARS", display: "$ 305.000" },
    at: "2026-08-22T10:42:00-03:00",
  },
  {
    id: "mov-2",
    kind: "salida",
    title: "Edesur",
    subtitle: "Ayer, 15:20",
    amount: { amount: "18450", currency: "ARS", display: "$ 18.450" },
    at: "2026-08-21T15:20:00-03:00",
    billId: "bill-edesur",
  },
  {
    id: "mov-3",
    kind: "salida",
    title: "Transferencia a Sofía",
    subtitle: "20 de agosto, 11:05",
    amount: { amount: "25000", currency: "ARS", display: "$ 25.000" },
    at: "2026-08-20T11:05:00-03:00",
    counterparty: { name: "Sofía", contactId: "contact-sofia" },
  },
  {
    id: "mov-4",
    kind: "entrada",
    title: "Alquiler cochera",
    subtitle: "18 de agosto, 09:30",
    amount: { amount: "90000", currency: "ARS", display: "$ 90.000" },
    at: "2026-08-18T09:30:00-03:00",
  },
];

let contacts: Contact[] = [
  {
    id: "contact-sofia",
    displayName: "Sofía",
    relationship: "Nieta",
    alias: "sofi.mate.rio",
    cbuLast4: "0001",
    bankName: "Banco Nación",
    holderName: "Sofía Bianchi",
    verifiedAt: "2026-08-01T12:00:00-03:00",
    avatarInitials: "SB",
  },
  {
    id: "contact-julian",
    displayName: "Julián",
    relationship: "Nieto",
    alias: "juli.bici.sol",
    cbuLast4: "0002",
    bankName: "Banco Provincia",
    holderName: "Julián Bianchi",
    verifiedAt: "2026-08-01T12:00:00-03:00",
    avatarInitials: "JB",
  },
  {
    id: "contact-marta",
    displayName: "Marta",
    relationship: "Hija",
    alias: "marta.flor.luz",
    cbuLast4: "0003",
    bankName: "Banco Nación",
    holderName: "Marta Bianchi",
    verifiedAt: "2026-08-01T12:00:00-03:00",
    avatarInitials: "MB",
  },
];

const fullCbus: Record<string, string> = {
  "contact-sofia": "0000003100010000000001",
  "contact-julian": "0000003100010000000002",
  "contact-marta": "0000003100010000000003",
};

const revealCounts = new Map<string, number>();

let agendaEvents: AgendaEvent[] = [
  {
    id: "agenda-1",
    title: "Cumpleaños de Sofi",
    date: "2026-09-18",
    kind: "cumpleanos",
    contactId: "contact-sofia",
    note: "Cumple 24 años",
    suggestedAction: {
      label: "Mandarle plata a Sofi",
      intent: "transfer",
      contactId: "contact-sofia",
    },
  },
  {
    id: "agenda-2",
    title: "Turno con el cardiólogo",
    date: "2026-09-24",
    kind: "turno_medico",
    contactId: null,
    note: "Hospital Italiano, consultorio 12",
    suggestedAction: null,
  },
  {
    id: "agenda-3",
    title: "Llamar a Marta",
    date: "2026-09-28",
    kind: "recordatorio",
    contactId: "contact-marta",
    note: null,
    suggestedAction: null,
  },
];

let bills: Bill[] = [
  {
    id: "bill-edesur",
    provider: "Edesur",
    providerLogoUrl: null,
    amount: { amount: "18450", currency: "ARS", display: "$ 18.450" },
    dueDate: "2026-09-05",
    dueDateHuman: "el 5 de septiembre",
    status: "pendiente",
    statusHuman: "Todavía no la pagaste",
    daysUntilDue: 14,
    canPayNow: true,
    paidAt: null,
    receiptId: null,
  },
  {
    id: "bill-metrogas",
    provider: "Metrogas",
    providerLogoUrl: null,
    amount: { amount: "9230", currency: "ARS", display: "$ 9.230" },
    dueDate: "2026-09-12",
    dueDateHuman: "el 12 de septiembre",
    status: "pendiente",
    statusHuman: "Todavía no la pagaste",
    daysUntilDue: 21,
    canPayNow: true,
    paidAt: null,
    receiptId: null,
  },
  {
    id: "bill-osde",
    provider: "OSDE",
    providerLogoUrl: null,
    amount: { amount: "74900", currency: "ARS", display: "$ 74.900" },
    dueDate: "2026-09-20",
    dueDateHuman: "el 20 de septiembre",
    status: "programada",
    statusHuman: "Se paga sola el 20",
    daysUntilDue: 29,
    canPayNow: false,
    paidAt: null,
    receiptId: null,
  },
];

const me: Me = {
  displayName: "Héctor Bianchi",
  greetingName: "Don Héctor",
  initials: "H",
  documentLast3: "552",
  city: "Lanús",
  verifiedAt: "2026-07-18T11:00:00-03:00",
  verificationHuman: "Tus datos están bien",
  dailyLimit: { amount: "500000", currency: "ARS", display: "$ 500.000" },
  dailySpent: { amount: "43450", currency: "ARS", display: "$ 43.450" },
};

type StoredIntent = {
  kind: "transfer" | "bill_payment";
  intent: PaymentIntent;
  receiptHeadline: string;
  sourceId: string;
  movementTitle: string;
  amount: string;
};

const intents = new Map<string, StoredIntent>();
const confirmedRequests = new Map<string, PaymentResult>();
const agentConversations = new Map<string, { pendingConfirmation: boolean }>();

function formatArs(amount: string) {
  return `$ ${new Intl.NumberFormat("es-AR").format(Number(amount))}`;
}

function makeTransferIntent(input: TransferIntentInput): PaymentIntent | null {
  const contact = contacts.find((item) => item.id === input.contactId);
  if (!contact) return null;
  const amountDisplay = formatArs(input.amount);
  const intentId = crypto.randomUUID();
  const intent: PaymentIntent = {
    intentId,
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    confirmation: {
      headline: `Vas a mandarle plata a ${contact.displayName}`,
      amountDisplay,
      fromAccountDisplay: "De tus pesos",
      detailLines: [
        `A ${contact.displayName} (tu ${contact.relationship.toLocaleLowerCase("es-AR")})`,
        ...(contact.alias ? [`Alias ${contact.alias}`] : []),
        `CBU terminado en ${contact.cbuLast4}`,
      ],
      warnings: ["Después te van a quedar $392.300"],
      confirmLabel: `Sí, mandar ${amountDisplay.replace("$ ", "$")}`,
      cancelLabel: "No, volver",
    },
    balanceAfter: { amount: "392300", currency: "ARS", display: "$ 392.300" },
  };
  intents.set(intentId, {
    kind: "transfer",
    intent,
    receiptHeadline: `Listo, le mandaste plata a ${contact.displayName}`,
    sourceId: contact.id,
    movementTitle: `Transferencia a ${contact.displayName}`,
    amount: input.amount,
  });
  return intent;
}

function makeBillIntent(bill: Bill): PaymentIntent {
  const intentId = crypto.randomUUID();
  const intent: PaymentIntent = {
    intentId,
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    confirmation: {
      headline: `Vas a pagar ${bill.provider}`,
      amountDisplay: bill.amount.display,
      fromAccountDisplay: "De tus pesos",
      detailLines: [`Factura de ${bill.provider}`, `Vence ${bill.dueDateHuman}`],
      warnings: ["Después te van a quedar $393.850"],
      confirmLabel: `Sí, pagar ${bill.amount.display.replace("$ ", "$")}`,
      cancelLabel: "No, volver",
    },
    balanceAfter: { amount: "393850", currency: "ARS", display: "$ 393.850" },
  };
  intents.set(intentId, {
    kind: "bill_payment",
    intent,
    receiptHeadline: `Listo, pagaste ${bill.provider}`,
    sourceId: bill.id,
    movementTitle: bill.provider,
    amount: bill.amount.amount,
  });
  return intent;
}

function confirmIntent(request: Request, intentId: string, kind: StoredIntent["kind"]) {
  const key = request.headers.get("Idempotency-Key");
  if (!key) {
    return err(
      "DATOS_INVALIDOS",
      "Falta la clave de seguridad para confirmar. Volvé a intentarlo.",
      422,
    );
  }
  const previousResult = confirmedRequests.get(`${kind}:${key}`);
  if (previousResult) return ok(previousResult);

  const stored = intents.get(intentId);
  if (!stored || stored.kind !== kind) {
    return err("NO_ENCONTRADO", "No encontramos esa confirmación.", 404);
  }
  if (Date.parse(stored.intent.expiresAt) <= Date.now()) {
    return err(
      "CONFIRMACION_VENCIDA",
      "Esta confirmación venció. Volvé a preparar la operación.",
      410,
    );
  }

  const result: PaymentResult = {
    paymentId: crypto.randomUUID(),
    status: "confirmado",
    receipt: {
      headline: stored.receiptHeadline,
      amountDisplay: stored.intent.confirmation.amountDisplay,
      at: new Date().toISOString(),
      atHuman: "Hoy a las 15:42",
      reference: `AW ${intentId.slice(0, 8).toLocaleUpperCase("es-AR")}`,
      newBalanceDisplay: `Te quedan ${stored.intent.balanceAfter.display.replace("$ ", "$")}`,
    },
  };
  const now = new Date().toISOString();
  const newTotalAmount = String(
    Math.max(0, Number(walletSummary.total.amount) - Number(stored.amount)),
  );
  walletSummary = {
    ...walletSummary,
    total: { amount: newTotalAmount, currency: "ARS", display: formatArs(newTotalAmount) },
    accounts: walletSummary.accounts.map((account) =>
      account.kind === "pesos" ? { ...account, balance: stored.intent.balanceAfter } : account,
    ),
    updatedAt: now,
  };

  if (stored.kind === "bill_payment") {
    bills = bills.map((bill) =>
      bill.id === stored.sourceId
        ? {
            ...bill,
            status: "pagada",
            statusHuman: "La pagaste hoy",
            canPayNow: false,
            paidAt: now,
            receiptId: result.paymentId,
          }
        : bill,
    );
  }

  movements = [
    {
      id: result.paymentId,
      kind: "salida",
      title: stored.movementTitle,
      subtitle: result.receipt.atHuman,
      amount: {
        amount: stored.amount,
        currency: "ARS",
        display: stored.intent.confirmation.amountDisplay,
      },
      at: now,
      ...(stored.kind === "bill_payment"
        ? { billId: stored.sourceId }
        : { counterparty: { name: stored.movementTitle, contactId: stored.sourceId } }),
    },
    ...movements,
  ];
  confirmedRequests.set(`${kind}:${key}`, result);
  return ok(result);
}

export const handlers = [
  http.get(apiPath("/wallet/summary"), () => ok(walletSummary)),

  http.get(apiPath("/wallet/movements"), ({ request }) => {
    const url = new URL(request.url);
    const limit = Math.max(1, Number(url.searchParams.get("limit") ?? "20"));
    const cursor = Number(url.searchParams.get("cursor") ?? "0");
    const items = movements.slice(cursor, cursor + limit);
    const nextIndex = cursor + items.length;
    return ok<MovementsPage>({
      items,
      nextCursor: nextIndex < movements.length ? String(nextIndex) : null,
    });
  }),

  http.get(apiPath("/contacts"), () => ok(contacts)),

  http.post(apiPath("/contacts"), async ({ request }) => {
    const input = (await request.json()) as CreateContactInput;
    const contact: Contact = {
      id: crypto.randomUUID(),
      ...input,
      verifiedAt: null,
    };
    contacts = [...contacts, contact];
    return ok(contact, 201);
  }),

  http.patch(apiPath("/contacts/:id"), async ({ params, request }) => {
    const contactId = String(params["id"]);
    const input = (await request.json()) as UpdateContactInput;
    const index = contacts.findIndex((item) => item.id === contactId);
    const current = contacts[index];
    if (!current) return err("NO_ENCONTRADO", "No encontramos a esa persona.", 404);
    const updated = { ...current, ...input };
    contacts = contacts.map((item) => (item.id === contactId ? updated : item));
    return ok(updated);
  }),

  http.delete(apiPath("/contacts/:id"), ({ params }) => {
    const contactId = String(params["id"]);
    if (!contacts.some((item) => item.id === contactId)) {
      return err("NO_ENCONTRADO", "No encontramos a esa persona.", 404);
    }
    contacts = contacts.filter((item) => item.id !== contactId);
    return ok<EmptyResponse>({});
  }),

  http.post(apiPath("/contacts/:id/reveal-cbu"), ({ params }) => {
    const contactId = String(params["id"]);
    const cbu = fullCbus[contactId];
    if (!cbu) return err("NO_ENCONTRADO", "No encontramos ese CBU.", 404);
    const count = revealCounts.get(contactId) ?? 0;
    if (count >= 5) {
      return err(
        "DEMASIADOS_INTENTOS",
        "Ya copiaste este CBU varias veces. Probá de nuevo más tarde.",
        429,
      );
    }
    revealCounts.set(contactId, count + 1);
    return ok({ cbu });
  }),

  http.get(apiPath("/agenda"), () => ok(agendaEvents)),

  http.post(apiPath("/agenda"), async ({ request }) => {
    const input = (await request.json()) as CreateAgendaEventInput;
    const event: AgendaEvent = { id: crypto.randomUUID(), ...input };
    agendaEvents = [...agendaEvents, event];
    return ok(event, 201);
  }),

  http.get(apiPath("/bills"), ({ request }) => {
    const url = new URL(request.url);
    const status = url.searchParams.get("status");
    const filtered = status ? bills.filter((bill) => bill.status === status) : bills;
    return ok(filtered);
  }),

  http.get(apiPath("/bills/:id"), ({ params }) => {
    const bill = bills.find((item) => item.id === String(params["id"]));
    return bill ? ok(bill) : err("NO_ENCONTRADO", "No encontramos esa factura.", 404);
  }),

  http.post(apiPath("/bills/:id/schedule"), ({ params }) => {
    const billId = String(params["id"]);
    const bill = bills.find((item) => item.id === billId);
    if (!bill) return err("NO_ENCONTRADO", "No encontramos esa factura.", 404);
    const updated: Bill = {
      ...bill,
      status: "programada",
      statusHuman: `Se paga sola el ${Number(bill.dueDate.slice(-2))}`,
      canPayNow: false,
    };
    bills = bills.map((item) => (item.id === billId ? updated : item));
    return ok(updated);
  }),

  http.delete(apiPath("/bills/:id/schedule"), ({ params }) => {
    const billId = String(params["id"]);
    const bill = bills.find((item) => item.id === billId);
    if (!bill) return err("NO_ENCONTRADO", "No encontramos esa factura.", 404);
    const updated: Bill = {
      ...bill,
      status: "pendiente",
      statusHuman: "Todavía no la pagaste",
      canPayNow: true,
    };
    bills = bills.map((item) => (item.id === billId ? updated : item));
    return ok(updated);
  }),

  http.post(apiPath("/bills/:id/payment-intent"), ({ params }) => {
    const bill = bills.find((item) => item.id === String(params["id"]));
    if (!bill) return err("NO_ENCONTRADO", "No encontramos esa factura.", 404);
    return ok(makeBillIntent(bill));
  }),

  http.post(apiPath("/transfers/intent"), async ({ request }) => {
    const input = (await request.json()) as TransferIntentInput;
    if (Number(input.amount) <= 0) {
      return err("DATOS_INVALIDOS", "Decime un monto mayor que cero.", 422, "amount");
    }
    const intent = makeTransferIntent(input);
    return intent
      ? ok(intent)
      : err("NO_ENCONTRADO", "No encontramos a esa persona guardada.", 404);
  }),

  http.post(apiPath("/payments/:intentId/confirm"), ({ params, request }) =>
    confirmIntent(request, String(params["intentId"]), "bill_payment"),
  ),

  http.post(apiPath("/transfers/:intentId/confirm"), ({ params, request }) =>
    confirmIntent(request, String(params["intentId"]), "transfer"),
  ),

  // /v1/agent/transcribe is intentionally unmocked: it's a real Whisper call proxied
  // through the backend, and MSW's onUnhandledRequest: "bypass" lets it reach it in dev.

  http.post(apiPath("/conversations"), () => {
    if (shouldUseLiveAgentBackend()) return passthrough();
    const conversationId = crypto.randomUUID();
    agentConversations.set(conversationId, { pendingConfirmation: false });
    return HttpResponse.json({ conversationId, mode: "typed" as const });
  }),

  http.post(apiPath("/conversations/:conversationId/turns"), async ({ params, request }) => {
    if (shouldUseLiveAgentBackend()) return passthrough();
    const conversation = agentConversations.get(String(params["conversationId"]));
    if (!conversation) {
      return HttpResponse.json<ConversationTurnResult>(
        { status: "error", message: "Conversation not found.", code: "conversation_not_found" },
        { status: 404 },
      );
    }

    const body = (await request.json()) as { message?: unknown };
    if (typeof body.message !== "string" || !body.message.trim()) {
      return HttpResponse.json<ConversationTurnResult>(
        {
          status: "error",
          message: "Escribime qué necesitás y lo vemos juntos.",
          code: "invalid_body",
        },
        { status: 400 },
      );
    }

    const normalized = body.message.trim().toLocaleLowerCase("es-AR");
    if (conversation.pendingConfirmation) {
      const submission = classifySessionSubmission(body.message, true);
      if (submission.kind === "resolution") {
        conversation.pendingConfirmation = false;
        if (submission.message === "cancelar la transferencia") {
          return HttpResponse.json<ConversationTurnResult>({
            status: "cancelled",
            message: "Transfer cancelled.",
          });
        }
        return HttpResponse.json<ConversationTurnResult>({
          status: "sent",
          message: "Transfer sent.",
          transaction: {
            network: "base-sepolia",
            transactionHash: `0x${crypto.randomUUID().replaceAll("-", "")}`,
            explorerUrl: "https://sepolia.basescan.org/tx/0xmock",
          },
        });
      }
      return HttpResponse.json<ConversationTurnResult>(
        {
          status: "error",
          message: "Confirmá o cancelá la transferencia pendiente antes de seguir.",
          code: "pending_confirmation",
        },
        { status: 422 },
      );
    }

    const proposesTransfer = ["sofi", "sofía", "mandar", "transfer", "pagar", "regalo"].some(
      (word) => normalized.includes(word),
    );
    if (proposesTransfer) {
      conversation.pendingConfirmation = true;
      return HttpResponse.json<ConversationTurnResult>({
        status: "confirmation_required",
        message: "Preparé la transferencia. Revisala antes de confirmar.",
        preview: {
          network: "base-sepolia",
          token: "USDC",
          recipient: "0x1234567890abcdef1234567890abcdef12345678",
          amount: "20",
          estimatedFee: "0.0001 ETH",
        },
      });
    }

    return HttpResponse.json<ConversationTurnResult>({
      status: "answer",
      message: "Decime a quién querés pagarle o mandarle plata.",
    });
  }),

  http.get(apiPath("/conversations/:conversationId/state"), () => {
    if (shouldUseLiveAgentBackend()) return passthrough();
    return HttpResponse.json(
      { status: "error", message: "Conversation state is unavailable." },
      { status: 404 },
    );
  }),

  http.post(apiPath("/conversations/:conversationId/decisions"), () => {
    if (shouldUseLiveAgentBackend()) return passthrough();
    return HttpResponse.json(
      { status: "error", message: "Conversation decisions are unavailable." },
      { status: 404 },
    );
  }),

  http.post(apiPath("/live-bindings"), () => {
    if (shouldUseLiveAgentBackend()) return passthrough();
    return HttpResponse.json(
      { status: "error", message: "Live voice is unavailable." },
      { status: 503 },
    );
  }),

  http.get(apiPath("/me"), () => ok(me)),
];
