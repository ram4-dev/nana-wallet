import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AgentAudioUnlock } from "./AgentAudioUnlock";

describe("AgentAudioUnlock", () => {
  it("stays out of the way while the browser plays Nani's audio", () => {
    render(<AgentAudioUnlock blocked={false} intro="Hola, soy Nani." onUnlock={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "Escuchar a Nani" })).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows the opening turn in writing and unlocks playback on tap", () => {
    const onUnlock = vi.fn();
    render(
      <AgentAudioUnlock
        blocked
        intro="Hola, soy Nani. Tenés 12 USDC disponibles."
        onUnlock={onUnlock}
      />,
    );

    expect(screen.getByText("“Hola, soy Nani. Tenés 12 USDC disponibles.”")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Escuchar a Nani" }));
    expect(onUnlock).toHaveBeenCalledOnce();
  });

  it("degrades visibly and keeps the unlock control while Nani's words have not arrived", () => {
    const onUnlock = vi.fn();
    render(<AgentAudioUnlock blocked intro={null} onUnlock={onUnlock} />);

    expect(screen.getByRole("status")).toHaveTextContent("bloqueó el audio");
    fireEvent.click(screen.getByRole("button", { name: "Escuchar a Nani" }));
    expect(onUnlock).toHaveBeenCalledOnce();
  });
});
