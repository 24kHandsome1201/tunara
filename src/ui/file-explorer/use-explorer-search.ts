import { useCallback, useEffect, useRef, useState } from "react";
import {
  fsCancelActiveNameSearch,
  fsCancelGrep,
  fsGrep,
  fsSearch,
  type GrepResponse,
  type SearchHit,
} from "@/modules/fs/fs-bridge";
import {
  cancelRemoteSearch,
  sshGrep,
  sshSearch,
} from "@/modules/ssh/remote-fs-bridge";
import { groupGrepHitsByFile, type GrepFileGroup } from "@/modules/fs/lib/grep-group";
import { FileSearchGeneration } from "@/ui/lib/file-search-session";
import {
  initialFileSearchLimit,
  maxFileSearchLimit,
  nextFileSearchLimit,
  type FileSearchMode,
} from "@/ui/lib/file-search-pagination";

let nextLocalGrepRequest = 0;

function createLocalGrepRequestId(): string {
  nextLocalGrepRequest += 1;
  return `grep-${Date.now().toString(36)}-${nextLocalGrepRequest.toString(36)}`;
}

// Remember the chosen search mode for this run so it survives directory/session
// switches. The query itself is intentionally not remembered — it is scoped to a
// specific repo and clearing it when the root changes avoids stale lookups.
let lastFileSearchMode: FileSearchMode = "name";

export interface ExplorerSearchOptions {
  baseDir: string | null;
  includeHidden: boolean;
  reloadKey: number;
  isRemote: boolean;
  remotePtyId: number | undefined;
  remoteDisconnected: boolean;
}

export interface ExplorerSearch {
  searchQuery: string;
  searchMode: FileSearchMode;
  searchHits: SearchHit[];
  grepHits: GrepFileGroup[];
  searchLoading: boolean;
  searchError: boolean;
  searchTruncated: boolean;
  grepTruncated: boolean;
  searchLimit: number;
  searchMaxLimit: number;
  isSearching: boolean;
  setQuery: (next: string) => void;
  toggleSearchMode: () => void;
  loadMoreSearchResults: () => void;
  retrySearch: () => void;
  resetSearch: () => void;
}

/**
 * Owns the file-explorer search state machine: name search vs. content grep,
 * local vs. remote transport, debounce, request-generation guards, explicit
 * cancellation of superseded requests, and limit pagination.
 */
export function useExplorerSearch({
  baseDir,
  includeHidden,
  reloadKey,
  isRemote,
  remotePtyId,
  remoteDisconnected,
}: ExplorerSearchOptions): ExplorerSearch {
  const [searchQuery, setSearchQuery] = useState("");
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [searchRetryNonce, setSearchRetryNonce] = useState(0);
  const [searchTruncated, setSearchTruncated] = useState(false);
  const [searchMode, setSearchMode] = useState<FileSearchMode>(lastFileSearchMode);
  const [searchLimit, setSearchLimit] = useState(() => initialFileSearchLimit(lastFileSearchMode));
  const [grepHits, setGrepHits] = useState<GrepFileGroup[]>([]);
  const [grepTruncated, setGrepTruncated] = useState(false);
  const searchGenerationRef = useRef(new FileSearchGeneration());

  useEffect(() => {
    const q = searchQuery.trim();
    if (!q || baseDir === null) {
      setSearchHits([]);
      setGrepHits([]);
      setGrepTruncated(false);
      setSearchTruncated(false);
      setSearchLoading(false);
      setSearchError(false);
      return;
    }
    if (remoteDisconnected) {
      setSearchLoading(false);
      return;
    }

    const mode = searchMode;
    const searchGen = searchGenerationRef.current;
    const token = searchGen.start();
    const localGrepRequestId = mode === "content" && !isRemote
      ? createLocalGrepRequestId()
      : null;
    let requestStarted = false;
    let requestSettled = false;
    setSearchLoading(true);
    setSearchError(false);
    // Fire the request inside the debounce timer, not before it: building the
    // promise eagerly would start the find/grep on every keystroke and only
    // debounce the setState. The generation token discards any in-flight
    // response when searchQuery, searchMode, baseDir, or remotePtyId changes.
    // Local content searches also send an explicit cancellation IPC so stale
    // parallel filesystem walks stop consuming CPU and disk. Both modes split local/remote:
    // content search runs fs_grep locally and ssh_fs_grep over the exec channel
    // remotely (shared GrepResponse shape); name search keeps the fs_search /
    // ssh_fs_search split with the shared SearchHit shape. The remote bridge
    // caches per (ptyId, root, query) so backspacing doesn't re-run find/grep.
    const timer = window.setTimeout(() => {
      requestStarted = true;
      const runSearch: Promise<SearchHit[] | GrepResponse> =
        mode === "content"
          ? isRemote && remotePtyId !== undefined
            ? sshGrep(remotePtyId, baseDir, q, searchLimit)
            : fsGrep(q, baseDir, { requestId: localGrepRequestId!, caseInsensitive: false, maxResults: searchLimit })
          : isRemote && remotePtyId !== undefined
            ? sshSearch(remotePtyId, baseDir, q, searchLimit)
            : fsSearch(baseDir, q, searchLimit, includeHidden);
      runSearch
        .then((result) => {
          requestSettled = true;
          if (!searchGen.isCurrent(token)) return;
          if (mode === "content") {
            const resp = result as GrepResponse;
            setGrepHits(groupGrepHitsByFile(resp.hits));
            setGrepTruncated(resp.truncated);
            setSearchHits([]);
            setSearchTruncated(false);
          } else {
            const hits = result as SearchHit[];
            setSearchHits(hits);
            // fs_search/ssh_fs_search cap results at searchLimit without a
            // truncated flag, so infer truncation from hitting the cap exactly.
            setSearchTruncated(hits.length >= searchLimit);
            setGrepHits([]);
            setGrepTruncated(false);
          }
          setSearchLoading(false);
        })
        .catch(() => {
          requestSettled = true;
          if (!searchGen.isCurrent(token)) return;
          setSearchHits([]);
          setGrepHits([]);
          setGrepTruncated(false);
          setSearchTruncated(false);
          setSearchError(true);
          setSearchLoading(false);
        });
    }, 180);

    return () => {
      searchGen.invalidate();
      window.clearTimeout(timer);
      if (localGrepRequestId && requestStarted && !requestSettled) {
        void fsCancelGrep(localGrepRequestId).catch(() => {});
      }
      if (mode === "name" && !isRemote && requestStarted && !requestSettled) {
        fsCancelActiveNameSearch();
      }
      if (isRemote && remotePtyId !== undefined && requestStarted && !requestSettled) {
        cancelRemoteSearch(remotePtyId);
      }
    };
  }, [baseDir, searchQuery, searchMode, searchLimit, includeHidden, reloadKey, isRemote, remotePtyId, remoteDisconnected, searchRetryNonce]);

  const setQuery = useCallback((next: string) => {
    setSearchQuery(next);
    setSearchLimit(initialFileSearchLimit(searchMode));
  }, [searchMode]);

  const toggleSearchMode = useCallback(() => {
    setSearchMode((m) => {
      const next = m === "name" ? "content" : "name";
      lastFileSearchMode = next;
      setSearchLimit(initialFileSearchLimit(next));
      return next;
    });
    setSearchQuery("");
  }, []);

  const loadMoreSearchResults = useCallback(() => {
    setSearchLimit((current) => nextFileSearchLimit(current, searchMode, isRemote));
  }, [searchMode, isRemote]);

  const retrySearch = useCallback(() => {
    setSearchRetryNonce((n) => n + 1);
  }, []);

  /** Restores the run-scoped mode and drops the repo-scoped query, e.g. when the session or root changes. */
  const resetSearch = useCallback(() => {
    setSearchQuery("");
    setSearchMode(lastFileSearchMode);
    setSearchLimit(initialFileSearchLimit(lastFileSearchMode));
  }, []);

  return {
    searchQuery,
    searchMode,
    searchHits,
    grepHits,
    searchLoading,
    searchError,
    searchTruncated,
    grepTruncated,
    searchLimit,
    searchMaxLimit: maxFileSearchLimit(searchMode, isRemote),
    isSearching: searchQuery.trim().length > 0,
    setQuery,
    toggleSearchMode,
    loadMoreSearchResults,
    retrySearch,
    resetSearch,
  };
}
