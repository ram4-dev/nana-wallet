import { describe, expect, it } from "vitest";

import { classifySessionSubmission } from "@/lib/session-resolution";

describe("session text resolution", () => {
  it("turns an explicit confirmation phrase into the canonical resolution", () => {
    expect(classifySessionSubmission("Confirmar la transferencia.", true)).toEqual({
      kind: "resolution",
      message: "confirmar la transferencia",
    });
    expect(classifySessionSubmission("sí", true)).toEqual({ kind: "blocked" });
    expect(classifySessionSubmission("yes", true)).toEqual({ kind: "blocked" });
  });

  it("turns an explicit cancellation phrase into the canonical resolution", () => {
    expect(classifySessionSubmission("Cancelar la transferencia", true)).toEqual({
      kind: "resolution",
      message: "cancelar la transferencia",
    });
  });

  it("blocks new or ambiguous instructions while a transfer is pending", () => {
    expect(classifySessionSubmission("mandá el doble", true)).toEqual({ kind: "blocked" });
    expect(classifySessionSubmission("puede ser", true)).toEqual({ kind: "blocked" });
  });

  it("keeps ordinary text as a new message when no confirmation is pending", () => {
    expect(classifySessionSubmission("  ¿Cuánto saldo tengo?  ", false)).toEqual({
      kind: "new",
      message: "¿Cuánto saldo tengo?",
    });
  });
});
