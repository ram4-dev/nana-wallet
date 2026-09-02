import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import type { ConversationState } from "@/lib/api-types";

import { useConversationState } from "./useConversationState";

function state(revision: number): ConversationState {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    mode: "live",
    revision,
    activity: "idle",
  };
}

describe("useConversationState", () => {
  afterEach(() => vi.restoreAllMocks());

  it("coalesces revision notifications, rejects stale projections, and uses ETags", async () => {
    const responses = [state(1), state(2), state(3)];
    const getState = vi.spyOn(api, "getConversationState").mockImplementation(async (_id, etag) => {
      if (etag === '"conversation-1"') return null;
      return responses.shift() ?? state(3);
    });
    const { result } = renderHook(() => useConversationState("conversation-1", vi.fn()));
    await waitFor(() => expect(result.current.state?.revision).toBe(1));

    let resolveRevision!: (value: ConversationState) => void;
    getState.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRevision = resolve;
        }),
    );
    await act(async () => {
      result.current.refreshRevision(2);
      result.current.refreshRevision(3);
      await Promise.resolve();
    });
    expect(getState).toHaveBeenCalledTimes(2);
    resolveRevision(state(2));
    await waitFor(() => expect(result.current.state?.revision).toBe(3));
    expect(getState.mock.calls.length).toBeLessThanOrEqual(4);

    getState.mockResolvedValueOnce(null);
    await act(async () => {
      await result.current.refresh();
    });
    expect(getState).toHaveBeenLastCalledWith("conversation-1", '"conversation-3"');
    expect(result.current.state?.revision).toBe(3);
  });

  it("excludes overlapping typed actions synchronously", async () => {
    let resolveTurn!: (value: { status: "answer"; message: string }) => void;
    vi.spyOn(api, "sendConversationTurn").mockImplementation(
      async () =>
        new Promise((resolve) => {
          resolveTurn = resolve;
        }),
    );
    vi.spyOn(api, "getConversationState").mockResolvedValue(state(1));
    const { result } = renderHook(() => useConversationState("conversation-1", vi.fn()));
    await waitFor(() => expect(result.current.state?.revision).toBe(1));

    let first!: Promise<unknown>;
    let second!: Promise<unknown>;
    await act(async () => {
      first = result.current.submitTyped("saldo");
      second = result.current.submitTyped("otro mensaje");
      await Promise.resolve();
    });
    expect(await second).toBeNull();
    await act(async () => {
      resolveTurn({ status: "answer", message: "Tenés saldo." });
      await first;
    });
    expect(api.sendConversationTurn).toHaveBeenCalledOnce();
  });

  it("commits typed mode before the live controller disconnects", async () => {
    vi.spyOn(api, "getConversationState").mockResolvedValue(state(7));
    vi.spyOn(api, "endLiveConversation").mockResolvedValue({
      mode: "typed",
      revision: 8,
      state: { ...state(7), mode: "typed", revision: 8 },
    });
    const { result } = renderHook(() => useConversationState("conversation-1", vi.fn()));
    await waitFor(() => expect(result.current.state?.revision).toBe(7));

    await act(async () => {
      await expect(result.current.endLive()).resolves.toBe(true);
    });
    expect(api.endLiveConversation).toHaveBeenCalledWith("conversation-1", 7, false);
    expect(result.current.state).toMatchObject({ mode: "typed", revision: 8 });
  });
});
