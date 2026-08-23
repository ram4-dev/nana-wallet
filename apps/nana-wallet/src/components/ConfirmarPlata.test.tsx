import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConfirmarPlata } from "@/components/ConfirmarPlata";
import { ApiError } from "@/lib/api";
import type { ConfirmableIntent, PaymentResult } from "@/lib/api-types";

const confirmMoneyIntent = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, confirmMoneyIntent };
});

function buildIntent(secondsToExpiry: number): ConfirmableIntent {
  return {
    kind: "transfer",
    intentId: "intent-1",
    expiresAt: new Date(Date.now() + secondsToExpiry * 1000).toISOString(),
    confirmation: {
      headline: "Vas a mandarle plata a Sofía",
      amountDisplay: "$ 20.000",
      fromAccountDisplay: "De tus pesos",
      detailLines: ["A Sofía (tu nieta)", "Alias sofi.mate.rio"],
      warnings: ["Después te van a quedar $393.850"],
      confirmLabel: "Sí, mandar $20.000",
      cancelLabel: "No, volver",
    },
  };
}

const receipt: PaymentResult = {
  paymentId: "pago-1",
  status: "confirmado",
  receipt: {
    headline: "Listo, le mandaste plata a Sofía",
    amountDisplay: "$ 20.000",
    at: new Date().toISOString(),
    atHuman: "Hoy a las 15:42",
    reference: "OP-99887",
    newBalanceDisplay: "Te quedan $393.850",
  },
};

function renderConfirmar(intent: ConfirmableIntent, overrides = {}) {
  const props = {
    intent,
    onCancel: vi.fn(),
    onCloseReceipt: vi.fn(),
    onExpired: vi.fn(),
    onUnknownOutcome: vi.fn(),
    ...overrides,
  };
  render(<ConfirmarPlata {...props} />);
  return props;
}

beforeEach(() => {
  confirmMoneyIntent.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ConfirmarPlata", () => {
  it("no abandona una confirmación en vuelo cuando se termina el tiempo", async () => {
    // El intent vence en 1 segundo. La confirmación tarda más que eso.
    // Si el reloj del cliente ganara, la pantalla saltaría a "empezá de nuevo"
    // con la plata ya moviéndose, y el abuelo pediría la transferencia dos veces.
    let resolveConfirm: (value: PaymentResult) => void = () => {};
    confirmMoneyIntent.mockImplementation(
      () =>
        new Promise<PaymentResult>((resolve) => {
          resolveConfirm = resolve;
        }),
    );

    const user = userEvent.setup();
    const props = renderConfirmar(buildIntent(1));

    await user.click(screen.getByRole("button", { name: /sí, mandar/i }));

    // Pasa de largo el vencimiento con la petición todavía viajando.
    await new Promise((resolve) => setTimeout(resolve, 1600));

    expect(screen.queryByText(/hay que empezar de nuevo/i)).not.toBeInTheDocument();
    expect(screen.getByText(/estamos confirmando/i)).toBeInTheDocument();
    expect(props.onExpired).not.toHaveBeenCalled();

    resolveConfirm(receipt);

    await waitFor(() => {
      expect(screen.getByText("Listo, le mandaste plata a Sofía")).toBeInTheDocument();
    });
    expect(screen.getByText("Te quedan $393.850")).toBeInTheDocument();
  });

  it("ante un error ambiguo ofrece reintentar con la misma Idempotency-Key", async () => {
    // Se corta la red en el camino de vuelta. No sabemos si la plata se movió.
    confirmMoneyIntent
      .mockRejectedValueOnce(
        new ApiError("SERVICIO_CAIDO", "No pudimos comunicarnos.", { ambiguous: true }),
      )
      .mockResolvedValueOnce(receipt);

    const user = userEvent.setup();
    const props = renderConfirmar(buildIntent(120));

    await user.click(screen.getByRole("button", { name: /sí, mandar/i }));

    await waitFor(() => {
      expect(screen.getByText(/no sabemos si se hizo/i)).toBeInTheDocument();
    });
    // No puede ofrecer un "cancelar" que le mienta diciendo que no pasó nada.
    expect(screen.queryByRole("button", { name: "No, volver" })).not.toBeInTheDocument();
    expect(screen.getByText(/no se va a duplicar/i)).toBeInTheDocument();
    expect(props.onCancel).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /confirmar de nuevo/i }));

    await waitFor(() => {
      expect(screen.getByText("Listo, le mandaste plata a Sofía")).toBeInTheDocument();
    });

    // Lo que hace seguro al reintento: la misma key en los dos intentos.
    expect(confirmMoneyIntent).toHaveBeenCalledTimes(2);
    const firstKey = confirmMoneyIntent.mock.calls[0]?.[1];
    const secondKey = confirmMoneyIntent.mock.calls[1]?.[1];
    expect(firstKey).toBeTruthy();
    expect(secondKey).toBe(firstKey);
  });

  it("un rechazo definitivo del backend sí deja cancelar", async () => {
    confirmMoneyIntent.mockRejectedValue(
      new ApiError("SALDO_INSUFICIENTE", "No te alcanza la plata en pesos.", { status: 409 }),
    );

    const user = userEvent.setup();
    renderConfirmar(buildIntent(120));

    await user.click(screen.getByRole("button", { name: /sí, mandar/i }));

    await waitFor(() => {
      expect(screen.getByText("No te alcanza la plata en pesos.")).toBeInTheDocument();
    });
    expect(screen.queryByText(/no sabemos si se hizo/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "No, volver" })).toBeEnabled();
  });
});
