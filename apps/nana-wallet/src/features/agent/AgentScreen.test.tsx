import { fireEvent, render, screen } from "@testing-library/react";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { AgentScreen } from "./AgentScreen";

const preview = {
  network: "sepolia",
  token: "USDT",
  recipient: "0x1234567890123456789012345678901234567890",
  amount: "10",
  estimatedFee: "0.0003 ETH",
  to: "0x1234567890123456789012345678901234567890",
  wallet: "agent-demo",
  previewId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
};

describe("AgentScreen financial projection", () => {
  it("keeps decisions enabled while live text input is disabled", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <AgentScreen
        voiceState={{ phase: "listening" }}
        liveMode
        conversationState={{
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          mode: "live",
          revision: 8,
          pendingTransfer: preview,
          activity: "awaiting_confirmation",
        }}
        text="send another transfer"
        onTextChange={vi.fn()}
        onTypedSubmit={vi.fn()}
        onAvatarPress={vi.fn()}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Confirmar" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancelar" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onCancel).toHaveBeenCalledOnce();
    expect(screen.getByText("10 USDT")).toBeInTheDocument();
    expect(screen.getByText("0.0003 ETH")).toBeInTheDocument();
  });

  it("shows durable verification progress and a terminal transaction card", () => {
    render(
      <AgentScreen
        voiceState={{ phase: "thinking" }}
        liveMode
        conversationState={{
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          mode: "live",
          revision: 12,
          activity: "verifying",
          progress: { phase: "verifying", label: "Verificando la transferencia." },
          transaction: {
            network: "sepolia",
            transactionHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            explorerUrl:
              "https://sepolia.etherscan.io/tx/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          },
        }}
        text=""
        onTextChange={vi.fn()}
        onTypedSubmit={vi.fn()}
        onAvatarPress={vi.fn()}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText("Verificando la transferencia.")).toBeInTheDocument();
    expect(screen.getByRole("link")).toHaveAttribute("href", expect.stringContaining("0xaaaaaaaa"));
  });

  it("shows the one waiting request without reopening typed input", () => {
    render(
      <AgentScreen
        voiceState={{ phase: "request_waiting" }}
        liveMode
        conversationState={{
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          mode: "live",
          revision: 10,
          activity: "request_waiting",
        }}
        text="send another transfer"
        onTextChange={vi.fn()}
        onTypedSubmit={vi.fn()}
        onAvatarPress={vi.fn()}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Tu solicitud está esperando");
    expect(screen.getByRole("textbox")).toBeDisabled();
  });

  it("requires acknowledgement before ending live voice during financial work", () => {
    const onEndConversation = vi.fn();
    render(
      <AgentScreen
        voiceState={{ phase: "listening" }}
        liveMode
        conversationState={{
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          mode: "live",
          revision: 9,
          activity: "verifying",
        }}
        text=""
        onTextChange={vi.fn()}
        onTypedSubmit={vi.fn()}
        onAvatarPress={vi.fn()}
        onEndConversation={onEndConversation}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Terminar conversación" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("no cancela");
    expect(screen.getByRole("button", { name: "Seguir hablando" })).toHaveFocus();
    expect(onEndConversation).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Terminar voz" }));
    expect(onEndConversation).toHaveBeenCalledWith(true);
  });

  it("exposes distinct accessible labels for speaking, muted, and paused states", () => {
    const { rerender } = render(
      <AgentScreen
        voiceState={{ phase: "speaking" }}
        liveMode
        conversationState={null}
        text=""
        onTextChange={vi.fn()}
        onTypedSubmit={vi.fn()}
        onAvatarPress={vi.fn()}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Interrumpir a Nani" })).toHaveAttribute(
      "data-live-phase",
      "speaking",
    );

    rerender(
      <AgentScreen
        voiceState={{ phase: "muted" }}
        liveMode
        conversationState={null}
        text=""
        onTextChange={vi.fn()}
        onTypedSubmit={vi.fn()}
        onAvatarPress={vi.fn()}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Micrófono pausado" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByRole("status")).toHaveTextContent("Micrófono pausado");
  });

  it("keeps reduced-motion styling explicit for every live phase", async () => {
    const css = await readFile(resolve(process.cwd(), "src/styles.css"), "utf8");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain(".agent-stage--speaking .nani-avatar-frame");
    expect(css).toContain(".agent-stage--reconnecting .nani-avatar-frame");
  });
});
