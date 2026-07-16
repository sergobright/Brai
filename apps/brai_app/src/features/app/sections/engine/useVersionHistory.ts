"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { VersionHistoryItem, VersionHistoryPage, VersionHistoryType, VersionHistoryTypeId } from "@/shared/api/braiApi";

export type VersionHistoryApi = {
  versionHistory: (query?: { type?: VersionHistoryTypeId | null; cursor?: string | null; limit?: number }) => Promise<VersionHistoryPage>;
};

type VersionHistoryStatus = "loading" | "loading-more" | "ready" | "error";

/** Loads and progressively appends one filtered public version-history stream. */
export function useVersionHistory(api: VersionHistoryApi) {
  const [filter, setFilter] = useState<VersionHistoryTypeId | null>(null);
  const [items, setItems] = useState<VersionHistoryItem[]>([]);
  const [types, setTypes] = useState<VersionHistoryType[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [failedCursor, setFailedCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<VersionHistoryStatus>("loading");
  const requestId = useRef(0);

  const requestPage = useCallback(async (cursor: string | null, replace: boolean) => {
    const id = ++requestId.current;
    try {
      const page = await api.versionHistory({ type: filter, cursor, limit: 30 });
      if (requestId.current !== id) return;
      setItems((current) => replace ? page.items : [...current, ...page.items]);
      setTypes(page.types);
      setNextCursor(page.next_cursor);
      setFailedCursor(null);
      setStatus("ready");
    } catch {
      if (requestId.current !== id) return;
      setFailedCursor(cursor);
      setStatus("error");
    }
  }, [api, filter]);

  useEffect(() => {
    const scheduledRequestId = requestId.current;
    void Promise.resolve().then(() => {
      if (requestId.current !== scheduledRequestId) return;
      return requestPage(null, true);
    });
    return () => {
      requestId.current += 1;
    };
  }, [requestPage]);

  const selectFilter = useCallback((nextFilter: VersionHistoryTypeId | null) => {
    if (nextFilter === filter) return;
    requestId.current += 1;
    setItems([]);
    setNextCursor(null);
    setFailedCursor(null);
    setStatus("loading");
    setFilter(nextFilter);
  }, [filter]);

  return {
    filter,
    items,
    types,
    status,
    hasMore: nextCursor != null,
    loadMore: () => {
      if (!nextCursor || status === "loading-more") return Promise.resolve();
      setStatus("loading-more");
      return requestPage(nextCursor, false);
    },
    retry: () => {
      setStatus(failedCursor == null ? "loading" : "loading-more");
      return requestPage(failedCursor, failedCursor == null);
    },
    selectFilter,
  };
}
