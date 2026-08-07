import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowRight, Search, X } from 'lucide-react';
import { useStore } from '../hooks/useStore';
import { bridge } from '../lib/bridge';
import { searchSessions } from '../lib/commands';
import { formatRelativeTime } from '../lib/time';
import type { SessionSearchMatch, SessionSummary } from '../types/bridge';

// A session row in the search palette: a title hit, a transcript content hit
// (with snippets), or both merged into one row.
interface SearchEntry {
  session: SessionSummary;
  matches: SessionSearchMatch[];
}

const DEBOUNCE_MS = 250;
const MIN_CONTENT_QUERY = 2;
const MAX_ENTRIES = 12;
const RECENT_ENTRIES = 8;
const SNIPPETS_PER_ROW = 2;

// Sidebar-wide session search (Codex-style): matches session titles locally
// and chat message text via the sidecar's transcript scan, showing a snippet
// preview so a query like "hi bro whatsapp" finds the session that contains
// it even when the title says something else. Local state only — the palette
// is a sidebar-local feature and closes itself after opening a session.
export default function SidebarSearch({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useStore();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [contentResults, setContentResults] = useState<ReadonlyMap<string, SessionSearchMatch[]>>(
    new Map(),
  );
  const [searchPending, setSearchPending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestSeq = useRef(0);
  const latestRequestId = useRef<string | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  // Content search is debounced; stale responses are dropped by requestId so
  // a slow scan of a previous keystroke never overwrites newer results.
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < MIN_CONTENT_QUERY) {
      latestRequestId.current = null;
      setSearchPending(false);
      setContentResults(new Map());
      return;
    }
    const requestId = `sidebar-search-${String(++requestSeq.current)}`;
    // Invalidate any in-flight request at scheduling time, not when the timer
    // fires: a slow response for a superseded query must not overwrite the
    // results shown under the query the user has already typed ahead to.
    latestRequestId.current = requestId;
    setSearchPending(true);
    const timer = setTimeout(() => {
      searchSessions(requestId, trimmed);
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [query]);

  useEffect(() => {
    return bridge.subscribe((ev) => {
      if (ev.type !== 'sessions.searchResults') return;
      if (ev.requestId !== latestRequestId.current) return;
      setSearchPending(false);
      setContentResults(new Map(ev.results.map((r) => [r.appSessionId, r.matches])));
    });
  }, []);

  // Merge title hits and content hits into one recency-ordered list. Content
  // hits for sessions outside the current sidebar list are dropped: opening
  // a row must land on a session the store can activate.
  const entries = useMemo<SearchEntry[]>(() => {
    const sessions = state.sessionOrder
      .map((id) => state.sessions[id])
      .filter((s): s is SessionSummary => Boolean(s))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) {
      return sessions.slice(0, RECENT_ENTRIES).map((session) => ({ session, matches: [] }));
    }
    const byId = new Map<string, SearchEntry>();
    for (const session of sessions) {
      const titleHit = session.title.toLowerCase().includes(trimmed);
      const contentMatches = contentResults.get(session.appSessionId);
      if (!titleHit && !contentMatches) continue;
      byId.set(session.appSessionId, { session, matches: contentMatches ?? [] });
    }
    return [...byId.values()]
      .sort((a, b) => b.session.updatedAt - a.session.updatedAt)
      .slice(0, MAX_ENTRIES);
  }, [query, state.sessionOrder, state.sessions, contentResults]);

  const open = (entry: SearchEntry) => {
    dispatch({ type: 'SET_ACTIVE_SESSION', id: entry.session.appSessionId });
    dispatch({ type: 'SELECT_CHILD', selection: null });
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (entries.length > 0) setSelected((prev) => (prev + 1) % entries.length);
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (entries.length > 0) setSelected((prev) => (prev - 1 + entries.length) % entries.length);
    }
    if (e.key === 'Enter') {
      const entry = entries.at(selected);
      if (entry) open(entry);
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  const now = Date.now();
  const trimmed = query.trim();

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.96, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.96, opacity: 0 }}
        transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
        className="w-full max-w-[560px] bg-droid-elevated border border-droid-border rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-droid-border">
          <Search className="w-4 h-4 text-droid-text-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Search sessions and messages..."
            aria-label="Search sessions and messages"
            className="flex-1 bg-transparent text-sm text-droid-text placeholder-droid-text-muted focus:outline-none"
          />
          <button
            onClick={onClose}
            title="Close search"
            aria-label="Close search"
            className="p-1 rounded-md text-droid-text-muted hover:text-droid-text hover:bg-droid-surface transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Results */}
        <div className="py-2 max-h-[400px] overflow-y-auto">
          {entries.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-droid-text-muted">
              {searchPending ? 'Searching messages...' : 'No sessions found'}
            </div>
          )}
          {entries.map((entry, i) => (
            <button
              key={entry.session.appSessionId}
              data-testid="sidebar-search-result"
              onMouseEnter={() => {
                setSelected(i);
              }}
              onClick={() => {
                open(entry);
              }}
              className={`w-full flex items-start gap-3 px-4 py-2.5 text-left transition-colors ${
                i === selected ? 'bg-droid-accent/10' : 'hover:bg-droid-surface'
              }`}
            >
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm text-droid-text">
                    {entry.session.title}
                  </span>
                  <span className="shrink-0 text-[10.5px] tabular-nums text-droid-text-muted">
                    {formatRelativeTime(entry.session.updatedAt, now)}
                  </span>
                </span>
                {entry.matches.slice(0, SNIPPETS_PER_ROW).map((m, j) => (
                  <span key={j} className="block truncate text-[12px] text-droid-text-muted mt-0.5">
                    {m.author === 'user' ? 'You: ' : ''}
                    {m.snippet}
                  </span>
                ))}
              </span>
              {i === selected && (
                <ArrowRight className="w-3.5 h-3.5 mt-1 shrink-0 text-droid-accent" />
              )}
            </button>
          ))}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-2 border-t border-droid-border bg-droid-surface/50">
          <div className="flex items-center gap-3 text-[10px] text-droid-text-muted">
            <span className="flex items-center gap-1">
              <span className="px-1 py-0.5 rounded bg-droid-elevated border border-droid-border font-mono text-[9px]">
                ↑↓
              </span>
              Navigate
            </span>
            <span className="flex items-center gap-1">
              <span className="px-1 py-0.5 rounded bg-droid-elevated border border-droid-border font-mono text-[9px]">
                ↵
              </span>
              Open session
            </span>
          </div>
          <div className="text-[10px] text-droid-text-muted">
            {trimmed ? 'Titles and message text' : 'Recent sessions'}
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
