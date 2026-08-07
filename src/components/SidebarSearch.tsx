import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { useStore } from '../hooks/useStore';
import { bridge } from '../lib/bridge';
import { searchSessions } from '../lib/commands';
import { formatRelativeTime } from '../lib/time';
import type { SessionSearchMatch, SessionSummary } from '../types/bridge';
import PaletteShell from './PaletteShell';
import { usePaletteNavigation } from './usePaletteNavigation';

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
  const [contentResults, setContentResults] = useState<ReadonlyMap<string, SessionSearchMatch[]>>(
    new Map(),
  );
  const [searchPending, setSearchPending] = useState(false);
  const requestSeq = useRef(0);
  const latestRequestId = useRef<string | null>(null);
  // searchResults are broadcast to every connected window, so the requestId
  // carries a per-instance prefix: two open palettes never accept each
  // other's responses.
  const instanceId = useRef(Math.random().toString(36).slice(2));

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
    const requestId = `sidebar-search-${instanceId.current}-${String(++requestSeq.current)}`;
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
    // byId iterates in insertion order, which already follows the recency
    // sort applied to sessions above — no second sort needed.
    return [...byId.values()].slice(0, MAX_ENTRIES);
  }, [query, state.sessionOrder, state.sessions, contentResults]);

  const open = (entry: SearchEntry) => {
    dispatch({ type: 'SET_ACTIVE_SESSION', id: entry.session.appSessionId });
    dispatch({ type: 'SELECT_CHILD', selection: null });
    onClose();
  };

  const { selected, setSelected, handleKeyDown } = usePaletteNavigation(
    query,
    entries,
    open,
    onClose,
  );

  const now = Date.now();
  const trimmed = query.trim();

  return (
    <PaletteShell
      onClose={onClose}
      query={query}
      onQueryChange={setQuery}
      onKeyDown={handleKeyDown}
      placeholder="Search sessions and messages..."
      inputAriaLabel="Search sessions and messages"
      enterHint="Open session"
      footerRight={trimmed ? 'Titles and message text' : 'Recent sessions'}
    >
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
          {i === selected && <ArrowRight className="w-3.5 h-3.5 mt-1 shrink-0 text-droid-accent" />}
        </button>
      ))}
    </PaletteShell>
  );
}
