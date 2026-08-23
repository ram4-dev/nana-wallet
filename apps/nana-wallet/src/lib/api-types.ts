export type Ok<T> = { ok: true; data: T };

export type Err = {
  ok: false;
  error: { code: ErrCode; message: string; field?: string };
};

export type ApiEnvelope<T> = Ok<T> | Err;

export type ErrCode =
  | "NO_AUTORIZADO"
  | "SIN_PERMISO"
  | "NO_ENCONTRADO"
  | "DATOS_INVALIDOS"
  | "SALDO_INSUFICIENTE"
  | "LIMITE_DIARIO"
  | "CONFIRMACION_VENCIDA"
  | "DUPLICADO"
  | "DEMASIADOS_INTENTOS"
  | "ERROR_INTERNO"
  | "SERVICIO_CAIDO";

export type Money = {
  amount: string;
  currency: "ARS" | "USD";
  display: string;
};

export type ISODate = string;
export type ISODateTime = string;

export type WalletAccount = {
  id: string;
  name: string;
  subtitle: string;
  balance: Money;
  approxInArs?: Money;
  kind: "pesos" | "dolares" | "plazo_fijo";
  maturesOn?: ISODate;
};

export type WalletSummary = {
  total: Money;
  accounts: WalletAccount[];
  updatedAt: ISODateTime;
};

export type WalletMovement = {
  id: string;
  kind: "entrada" | "salida";
  title: string;
  subtitle: string;
  amount: Money;
  at: ISODateTime;
  counterparty?: { name: string; contactId?: string };
  billId?: string;
};

export type MovementsPage = {
  items: WalletMovement[];
  nextCursor: string | null;
};

export type Contact = {
  id: string;
  displayName: string;
  relationship: string;
  alias: string | null;
  cbuLast4: string;
  bankName: string | null;
  holderName: string;
  verifiedAt: ISODateTime | null;
  avatarInitials: string;
};

export type CreateContactInput = Omit<Contact, "id" | "verifiedAt">;

export type UpdateContactInput = Partial<CreateContactInput>;

export type RevealedCbu = { cbu: string };

export type AgendaEvent = {
  id: string;
  title: string;
  date: ISODate;
  kind: "cumpleanos" | "turno_medico" | "recordatorio" | "otro";
  contactId: string | null;
  note: string | null;
  suggestedAction: null | {
    label: string;
    intent: "transfer";
    contactId: string;
  };
};

export type CreateAgendaEventInput = Omit<AgendaEvent, "id">;

export type BillStatus = "pendiente" | "programada" | "pagada" | "vencida";

export type Bill = {
  id: string;
  provider: string;
  providerLogoUrl: string | null;
  amount: Money;
  dueDate: ISODate;
  dueDateHuman: string;
  status: BillStatus;
  statusHuman: string;
  daysUntilDue: number;
  canPayNow: boolean;
  paidAt: ISODateTime | null;
  receiptId: string | null;
};

export type PaymentConfirmation = {
  headline: string;
  amountDisplay: string;
  fromAccountDisplay: string;
  detailLines: string[];
  warnings: string[];
  confirmLabel: string;
  cancelLabel: string;
};

export type PaymentIntent = {
  intentId: string;
  expiresAt: ISODateTime;
  confirmation: PaymentConfirmation;
  balanceAfter: Money;
};

export type PaymentResult = {
  paymentId: string;
  status: "confirmado" | "en_proceso" | "fallido";
  receipt: {
    headline: string;
    amountDisplay: string;
    at: ISODateTime;
    atHuman: string;
    reference: string;
    newBalanceDisplay: string;
  };
};

export type TransferIntentInput = {
  contactId: string;
  amount: string;
  currency: "ARS";
  fromAccountId: string;
  note?: string;
};

export type BillPaymentIntentInput = { accountId: string };

export type CreateSessionResponse = {
  sessionId: string;
  status: "active";
};

export type AgentAudioTranscriptionInput = {
  audioBase64: string;
  mimeType: string;
};

export type AgentAudioTranscription = {
  transcript: string;
};

export type TransferPreview = {
  network: string;
  token: string;
  tokenAddress: string;
  recipient: string;
  amount: string;
  amountBaseUnits: string;
  amountFormatted: string;
  estimatedFee: string;
  estimatedFeeBaseUnits: string;
  estimatedFeeFormatted: string;
};

export type TransactionResult = {
  network: string;
  transactionHash: string;
  explorerUrl: string;
};

export type SessionMessageResponse =
  | { status: "answer"; message: string }
  | { status: "confirmation_required"; message: string; preview: TransferPreview }
  | { status: "sent"; message: string; transaction: TransactionResult }
  | { status: "cancelled"; message: string }
  | { status: "error"; message: string; code: string };

export type Me = {
  displayName: string;
  greetingName: string;
  initials: string;
  documentLast3: string;
  city: string;
  verifiedAt: ISODateTime | null;
  verificationHuman: string;
  dailyLimit: Money;
  dailySpent: Money;
};

export type ConfirmableIntent = {
  kind: "transfer" | "bill_payment";
  intentId: string;
  expiresAt: ISODateTime;
  confirmation: PaymentConfirmation;
};

export type EmptyResponse = Record<string, never>;
