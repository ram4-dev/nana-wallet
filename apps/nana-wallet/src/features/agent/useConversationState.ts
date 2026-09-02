import { useCallback, useEffect, useRef, useState } from "react";

import { api, createConversationTurnSender, getErrorMessage } from "@/lib/api";
import type { ConversationState, ConversationTurnResult } from "@/lib/api-types";

export function useConversationState(
  conversationId: string | null,
  onConversationId: (conversationId: string) => void,
) {
  const [state, setState] = useState<ConversationState | null>(null);
  const [lastTurn, setLastTurn] = useState<ConversationTurnResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  const [isActionPending, setIsActionPending] = useState(false);
  const appliedRevisionRef = useRef(-1);
  const requestedRevisionRef = useRef(-1);
  const refreshQueuedRef = useRef(false);
  const etagRef = useRef<string | undefined>(undefined);
  const actionLockRef = useRef(false);
  const conversationIdRef = useRef(conversationId);
  conversationIdRef.current = conversationId;

  const applyState = useCallback((next: ConversationState) => {
    if (next.revision <= appliedRevisionRef.current) return false;
    appliedRevisionRef.current = next.revision;
    etagRef.current = `"conversation-${next.revision}"`;
    setState(next);
    return true;
  }, []);

  const refresh = useCallback(
    async (minimumRevision = -1) => {
      const id = conversationIdRef.current;
      if (!id) return;
      requestedRevisionRef.current = Math.max(requestedRevisionRef.current, minimumRevision);
      if (refreshingRef.current) {
        refreshQueuedRef.current = true;
        return;
      }
      refreshingRef.current = true;
      setIsRefreshing(true);
      try {
        const knownNewerRevision = requestedRevisionRef.current > appliedRevisionRef.current;
        const next = await api.getConversationState(
          id,
          knownNewerRevision ? undefined : etagRef.current,
        );
        if (next) applyState(next);
      } catch (nextError) {
        setError(getErrorMessage(nextError));
      } finally {
        refreshingRef.current = false;
        setIsRefreshing(false);
        if (refreshQueuedRef.current || requestedRevisionRef.current > appliedRevisionRef.current) {
          refreshQueuedRef.current = false;
          void refresh(requestedRevisionRef.current);
        }
      }
    },
    [applyState],
  );

  const refreshRevision = useCallback(
    (revision: number) => {
      if (revision <= appliedRevisionRef.current) return;
      requestedRevisionRef.current = Math.max(requestedRevisionRef.current, revision);
      void refresh(revision);
    },
    [refresh],
  );

  useEffect(() => {
    if (conversationId) void refresh();
  }, [conversationId, refresh]);

  useEffect(() => {
    if (!conversationId || !state || !["working", "verifying"].includes(state.activity ?? ""))
      return;
    const timer = window.setInterval(() => void refresh(), 750);
    return () => window.clearInterval(timer);
  }, [conversationId, refresh, state]);

  const senderRef = useRef<ReturnType<typeof createConversationTurnSender> | null>(null);
  const sender =
    senderRef.current ??
    createConversationTurnSender(
      () => conversationIdRef.current,
      (nextId) => {
        conversationIdRef.current = nextId;
        if (nextId) onConversationId(nextId);
      },
    );
  senderRef.current ??= sender;

  const submitTyped = useCallback(
    async (message: string) => {
      if (actionLockRef.current) return null;
      actionLockRef.current = true;
      setIsActionPending(true);
      setError(null);
      try {
        const result = await senderRef.current!(message);
        setLastTurn(result);
        void refresh();
        return result;
      } catch (nextError) {
        setError(getErrorMessage(nextError));
        return null;
      } finally {
        actionLockRef.current = false;
        setIsActionPending(false);
      }
    },
    [refresh],
  );

  const decide = useCallback(
    async (decision: "confirm" | "cancel") => {
      const id = conversationIdRef.current;
      const previewId = state?.pendingTransfer?.previewId;
      if (!id || !previewId || actionLockRef.current) return null;
      actionLockRef.current = true;
      setIsActionPending(true);
      setError(null);
      try {
        const response = await api.decideConversation(id, previewId, decision);
        applyState(response.state);
        void refresh(response.revision);
        return response;
      } catch (nextError) {
        setError(getErrorMessage(nextError));
        void refresh();
        return null;
      } finally {
        actionLockRef.current = false;
        setIsActionPending(false);
      }
    },
    [applyState, refresh, state?.pendingTransfer?.previewId],
  );

  const endLive = useCallback(
    async (acknowledgeUnresolvedFinancialWork = false) => {
      const id = conversationIdRef.current;
      const expectedRevision = state?.revision;
      if (!id || expectedRevision === undefined || actionLockRef.current) return false;
      actionLockRef.current = true;
      setIsActionPending(true);
      setError(null);
      try {
        const response = await api.endLiveConversation(
          id,
          expectedRevision,
          acknowledgeUnresolvedFinancialWork,
        );
        applyState(response.state);
        return true;
      } catch (nextError) {
        setError(getErrorMessage(nextError));
        void refresh();
        return false;
      } finally {
        actionLockRef.current = false;
        setIsActionPending(false);
      }
    },
    [applyState, refresh, state?.revision],
  );

  return {
    state,
    lastTurn,
    error,
    isRefreshing,
    isActionPending,
    refresh,
    refreshRevision,
    submitTyped,
    confirm: () => decide("confirm"),
    cancel: () => decide("cancel"),
    endLive,
  };
}
