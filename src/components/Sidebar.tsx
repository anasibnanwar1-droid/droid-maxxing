import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { useStore } from '../hooks/useStore';
import { useDocumentVisible } from '../hooks/useDocumentVisible';
import { pickDirectory } from '../lib/desktop';
import { dismissSidebarCard, loadSidebarCardSeen } from '../lib/sidebarCards';
import { SIDEBAR_WELCOME_CARD_ID, SidebarWelcomeCard } from './SidebarWelcomeCard';
import { BrandMark } from './BrandMark';
import SidebarSearch from './SidebarSearch';
import {
  Bell,
  Folder,
  FolderPlus,
  Plus,
  Search,
  Settings,
  ChevronRight,
  Download,
  Loader2,
  SquarePen,
} from 'lucide-react';
import {
  buildWorkspaceSections,
  resolveNewChatCwd,
  SIDEBAR_VISIBLE_SESSION_LIMIT,
} from '../lib/workspaces';
import { sessionIsLive, sessionIsUnread } from '../lib/sessions';
import { useAppUpdate } from '../lib/appUpdate';
import { formatRelativeTime } from '../lib/time';
import type { SessionSummary } from '../types/bridge';

interface UnreadFilterActionsProps {
  unreadOnly: boolean;
  unreadCount: number;
  onToggleUnread: () => void;
  onMarkAllRead: () => void;
}

export function UnreadFilterActions({
  unreadOnly,
  unreadCount,
  onToggleUnread,
  onMarkAllRead,
}: UnreadFilterActionsProps) {
  return (
    <>
      {unreadOnly && unreadCount > 0 && (
        <button
          type="button"
          onClick={onMarkAllRead}
          className="rounded-md px-2 py-1.5 text-[10.5px] font-medium text-droid-text-muted transition-colors hover:bg-droid-elevated hover:text-droid-text"
        >
          Mark all as read
        </button>
      )}
      <button
        type="button"
        onClick={onToggleUnread}
        title={unreadOnly ? 'Show all sessions' : 'Show unread only'}
        aria-label={unreadOnly ? 'Show all sessions' : 'Show unread only'}
        aria-pressed={unreadOnly}
        className={`relative rounded-md p-1.5 transition-colors hover:bg-droid-elevated ${
          unreadOnly ? 'text-droid-accent' : 'text-droid-text-muted hover:text-droid-text'
        }`}
      >
        <Bell className="w-4 h-4" strokeWidth={1.75} />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-3 min-w-3 items-center justify-center rounded-full bg-droid-accent px-0.5 text-[8px] font-semibold tabular-nums text-droid-bg">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>
    </>
  );
}

// Blue download glyph docked beside Settings when a newer DROIDEX build is
// available; spins while the artifact is on its way.
function UpdateButton() {
  const { update, downloading, start } = useAppUpdate();
  if (!update?.updateAvailable) return null;
  const actionLabel = `Review DROIDEX ${update.latest} update`;
  return (
    <button
      onClick={() => {
        void start();
      }}
      disabled={downloading}
      title={actionLabel}
      aria-label={actionLabel}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-blue-500 transition-colors hover:bg-droid-elevated disabled:opacity-60"
    >
      {downloading ? (
        <Loader2 className="w-4 h-4 animate-spin" />
      ) : (
        <Download className="w-4 h-4" />
      )}
    </button>
  );
}

// Simple, smooth ring spinner shown on the left of a row while its model works.
function WorkingSpinner() {
  return (
    <span
      className="w-3 h-3 rounded-full border-[1.5px] border-droid-text-muted/30 border-t-droid-text animate-spin"
      style={{ animationDuration: '1.5s' }}
      aria-label="working"
    />
  );
}

// Typing-style ellipsis shown in place of the timestamp while the model works.
function WorkingDots() {
  return (
    <span className="flex items-center gap-[3px]" aria-label="working">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="dot-pulse rounded-full bg-current"
          style={{ width: 3, height: 3, animationDelay: `${i * 0.16}s` }}
        />
      ))}
    </span>
  );
}

export interface SessionRowProps {
  session: SessionSummary;
  active: boolean;
  unread: boolean;
  running: boolean;
  now: number;
  onSelect: (appSessionId: string) => void;
}

export function areSessionRowPropsEqual(prev: SessionRowProps, next: SessionRowProps): boolean {
  return (
    prev.session.appSessionId === next.session.appSessionId &&
    prev.session.title === next.session.title &&
    prev.session.updatedAt === next.session.updatedAt &&
    prev.active === next.active &&
    prev.unread === next.unread &&
    prev.running === next.running &&
    prev.now === next.now &&
    prev.onSelect === next.onSelect
  );
}

// `running` is derived by the parent so this row can skip unrelated store updates.
export const SessionRow = memo(function SessionRow({
  session,
  active,
  unread,
  running,
  now,
  onSelect,
}: SessionRowProps) {
  const timeLabel = formatRelativeTime(session.updatedAt, now);
  return (
    <div>
      <button
        data-testid="top-level-session-row"
        data-app-session-id={session.appSessionId}
        onClick={() => {
          onSelect(session.appSessionId);
        }}
        className={`group w-full flex items-center gap-2.5 pl-3 pr-2 py-1.5 rounded-xl text-left transition-colors ${
          active ? 'bg-droid-active' : 'hover:bg-droid-elevated/40'
        }`}
      >
        <span
          className={`w-3 flex items-center justify-center shrink-0 ${active ? 'text-droid-text' : 'text-droid-text-secondary group-hover:text-droid-text'}`}
        >
          {running && <WorkingSpinner />}
        </span>
        <span
          className={`min-w-0 flex-1 truncate text-[13px] ${
            active
              ? 'text-droid-text'
              : unread
                ? 'text-droid-text font-semibold'
                : 'text-droid-text-secondary group-hover:text-droid-text'
          }`}
        >
          {session.title}
        </span>
        {running ? (
          <span className="shrink-0 text-droid-text-secondary">
            <WorkingDots />
          </span>
        ) : (
          timeLabel && (
            <span
              className={`shrink-0 text-[10.5px] tabular-nums ${
                unread ? 'text-droid-text font-medium' : 'text-droid-text-muted'
              }`}
            >
              {timeLabel}
            </span>
          )
        )}
      </button>
    </div>
  );
}, areSessionRowPropsEqual);

export default function Sidebar() {
  const { state, dispatch } = useStore();
  const activeSession = state.activeAppSessionId ? state.sessions[state.activeAppSessionId] : null;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // Sidebar-local chrome state: the search palette and the unread-only filter
  // (Codex-style bell toggle) belong to the sidebar, not the root store.
  const [searchOpen, setSearchOpen] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);
  // Per-section count of rows to show; grows by SIDEBAR_VISIBLE_SESSION_LIMIT on
  // each "Show more" so long lists page in (5 + 5 + 5...) rather than loading all.
  const [shownCount, setShownCount] = useState<Map<string, number>>(new Map());

  const documentVisible = useDocumentVisible();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!documentVisible) return;
    setNow(Date.now());
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 30_000);
    return () => {
      clearInterval(timer);
    };
  }, [documentVisible]);

  const toggleCollapse = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const visibleCountFor = (key: string) => shownCount.get(key) ?? SIDEBAR_VISIBLE_SESSION_LIMIT;

  const showMore = (key: string) => {
    setShownCount((prev) => {
      const cur = prev.get(key) ?? SIDEBAR_VISIBLE_SESSION_LIMIT;
      return new Map(prev).set(key, cur + SIDEBAR_VISIBLE_SESSION_LIMIT);
    });
  };

  const showLess = (key: string) => {
    setShownCount((prev) => {
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
  };

  const activeId = state.activeAppSessionId;
  const lastSeen = state.sessionLastSeen;
  const isUnread = useCallback(
    (m: SessionSummary) => sessionIsUnread(m, activeId, lastSeen[m.appSessionId]),
    [activeId, lastSeen],
  );

  const unreadCount = useMemo(
    () =>
      state.sessionOrder
        .map((id) => state.sessions[id])
        .filter(Boolean)
        .filter(isUnread).length,
    [state.sessionOrder, state.sessions, isUnread],
  );

  const markAllSessionsRead = useCallback(() => {
    dispatch({ type: 'MARK_ALL_SESSIONS_READ', seenAt: Date.now() });
    setUnreadOnly(false);
  }, [dispatch]);

  const startChat = (cwd: string) => {
    dispatch({ type: 'START_CHAT', cwd });
  };

  const pickAndChat = async () => {
    const dir = await pickDirectory();
    if (!dir) return;
    dispatch({ type: 'ADD_WORKSPACE', cwd: dir });
    startChat(dir);
  };

  // New chat follows the active session: workspace chats stay in that folder,
  // folder-less Chats stay folder-less. Draft cwd is only used when nothing is
  // selected (see resolveNewChatCwd).
  const newChat = () => {
    startChat(resolveNewChatCwd(activeSession, state.draftChat));
  };

  // First-run welcome card above Settings: shows on every launch until the
  // user dismisses it, then stays hidden for the profile.
  const [welcomeVisible, setWelcomeVisible] = useState(
    () => !loadSidebarCardSeen(SIDEBAR_WELCOME_CARD_ID),
  );
  const dismissWelcome = () => {
    setWelcomeVisible(false);
    dismissSidebarCard(SIDEBAR_WELCOME_CARD_ID);
  };

  // The sidecar publishes top-level sessions only; children live in the right panel.
  const chatSessions = useMemo<SessionSummary[]>(() => {
    const rows = state.sessionOrder
      .map((id) => state.sessions[id])
      .filter(Boolean)
      .filter((m) => !m.cwd);
    const visible = unreadOnly ? rows.filter(isUnread) : rows;
    return visible.sort((a, b) => b.updatedAt - a.updatedAt);
  }, [state.sessionOrder, state.sessions, unreadOnly, isUnread]);

  const workspaces = useMemo(() => {
    const sessions = state.sessionOrder.map((id) => state.sessions[id]).filter(Boolean);
    const sections = buildWorkspaceSections(state.workspaceCwds, sessions);
    // In unread-only mode, drop read sessions and workspaces left empty.
    if (!unreadOnly) return sections;
    return sections
      .map((ws) => ({ ...ws, sessions: ws.sessions.filter(isUnread) }))
      .filter((ws) => ws.sessions.length > 0);
  }, [state.sessionOrder, state.sessions, state.workspaceCwds, unreadOnly, isUnread]);

  const handleSelectSession = useCallback(
    (appSessionId: string) => {
      dispatch({ type: 'SET_ACTIVE_SESSION', id: appSessionId });
      dispatch({ type: 'SELECT_CHILD', selection: null });
      // Opening a session from the unread-only view drops the filter: the
      // opened session is no longer unread, so keeping it would make the row
      // vanish from under the user.
      if (unreadOnly) setUnreadOnly(false);
    },
    [dispatch, unreadOnly],
  );

  const renderRow = (m: SessionSummary) => (
    <SessionRow
      key={m.appSessionId}
      session={m}
      active={state.activeAppSessionId === m.appSessionId}
      unread={isUnread(m)}
      running={sessionIsLive(m)}
      now={now}
      onSelect={handleSelectSession}
    />
  );

  // Show the latest sessions and tuck the rest behind a "Show more" toggle. The
  // active session is always kept visible so selecting an older one never hides
  // it on the next render.
  const renderSessionList = (sectionKey: string, sessions: SessionSummary[]) => {
    const total = sessions.length;
    const count = Math.min(visibleCountFor(sectionKey), total);
    let visible = sessions.slice(0, count);
    // Keep the active session visible even if it sits below the paged window so
    // selecting an older chat never hides it on the next render.
    if (
      activeSession &&
      sessions.some((m) => m.appSessionId === activeSession.appSessionId) &&
      !visible.some((m) => m.appSessionId === activeSession.appSessionId)
    ) {
      visible = [...visible, state.sessions[activeSession.appSessionId]];
    }
    const remaining = total - count;
    const isExpanded = count > SIDEBAR_VISIBLE_SESSION_LIMIT;
    return (
      <div className="mt-0.5 space-y-0.5">
        {visible.map(renderRow)}
        {(remaining > 0 || isExpanded) && (
          <div className="flex items-center gap-3 pl-3 pr-2 pt-0.5">
            {remaining > 0 && (
              <button
                onClick={() => {
                  showMore(sectionKey);
                }}
                className="text-[12px] text-droid-text-muted hover:text-droid-text transition-colors"
              >
                Show more
              </button>
            )}
            {isExpanded && (
              <button
                onClick={() => {
                  showLess(sectionKey);
                }}
                className="text-[12px] text-droid-text-muted hover:text-droid-text transition-colors"
              >
                Show less
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <aside
      data-testid="left-navigation"
      className="w-[280px] h-full flex flex-col border-r border-droid-border shrink-0"
      style={{
        background: 'var(--sidebar-bg)',
        backdropFilter: 'var(--sidebar-blur)',
        WebkitBackdropFilter: 'var(--sidebar-blur)',
      }}
    >
      {/* Empty titlebar strip so traffic lights never collide with chrome. */}
      <div data-electron-drag-region className="h-9 shrink-0" />

      {/* Brand row: wordmark left; Codex-style ghost icon actions right
          (session search palette + unread-only filter). No button chrome —
          hover state only. */}
      <div className="px-3 pb-1 pt-0.5 flex items-center justify-between">
        <BrandMark size={13} className="text-droid-text" />
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => {
              setSearchOpen(true);
            }}
            title="Search sessions and messages"
            aria-label="Search sessions and messages"
            className="rounded-md p-1.5 text-droid-text-muted transition-colors hover:bg-droid-elevated hover:text-droid-text"
          >
            <Search className="w-4 h-4" strokeWidth={1.75} />
          </button>
          <UnreadFilterActions
            unreadOnly={unreadOnly}
            unreadCount={unreadCount}
            onToggleUnread={() => {
              setUnreadOnly((value) => !value);
            }}
            onMarkAllRead={markAllSessionsRead}
          />
        </div>
      </div>

      <div className="px-2 pb-1.5">
        <button
          onClick={newChat}
          className="group w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-[13px] font-medium text-droid-text hover:bg-droid-elevated transition-colors"
        >
          <SquarePen className="w-[18px] h-[18px] shrink-0 text-droid-text-secondary transition-colors group-hover:text-droid-text" />
          New chat
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-3">
        {unreadOnly && unreadCount === 0 && (
          <div className="px-3 pt-2 pb-1 text-[12px] text-droid-text-muted">
            No unread sessions.
          </div>
        )}
        {/* Workspaces — folder-scoped, where sessions run (main area) */}
        {(() => {
          // Unread-only mode hides sections that have no unread rows left.
          if (unreadOnly && workspaces.length === 0) return null;
          const open = !collapsed.has('__workspaces__');
          return (
            <div>
              <div className="group/header flex items-center gap-1 px-1 pt-1 pb-1.5">
                <button
                  onClick={() => {
                    toggleCollapse('__workspaces__');
                  }}
                  className="flex items-center gap-2 min-w-0 flex-1 text-left rounded-lg px-1 py-0.5 hover:bg-droid-elevated/40 transition-colors"
                >
                  <ChevronRight
                    className={`w-3 h-3 text-droid-text-muted/70 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
                  />
                  <span className="text-[11px] font-medium tracking-wide text-droid-text-muted">
                    Workspaces
                  </span>
                </button>
                <button
                  onClick={() => {
                    void pickAndChat();
                  }}
                  title="Add workspace"
                  className="p-0.5 rounded-md text-droid-text-muted hover:text-droid-text hover:bg-droid-elevated/60 transition-colors shrink-0"
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
              </div>

              {open && (
                <div className="space-y-2.5">
                  {workspaces.map((ws) => {
                    const wsOpen = !collapsed.has(ws.cwd);
                    return (
                      <div key={ws.cwd}>
                        <div className="group flex items-center gap-1 px-1 py-1">
                          <button
                            onClick={() => {
                              toggleCollapse(ws.cwd);
                            }}
                            className="flex items-center gap-2 min-w-0 flex-1 text-left rounded-lg px-1 py-0.5 hover:bg-droid-elevated/40 transition-colors"
                          >
                            <ChevronRight
                              className={`w-3 h-3 text-droid-text-muted/70 shrink-0 transition-transform ${wsOpen ? 'rotate-90' : ''}`}
                            />
                            <Folder className="w-4 h-4 text-droid-text-muted shrink-0" />
                            <span className="min-w-0 flex-1 truncate text-[13.5px] text-droid-text">
                              {ws.name}
                            </span>
                          </button>
                          <button
                            onClick={() => {
                              startChat(ws.cwd);
                            }}
                            title="New chat here"
                            className="p-0.5 rounded-md text-droid-text-muted/0 group-hover:text-droid-text-muted hover:text-droid-text hover:bg-droid-elevated/60 transition-colors shrink-0"
                          >
                            <Plus className="w-3.5 h-3.5" />
                          </button>
                        </div>
                        {wsOpen && renderSessionList(ws.cwd, ws.sessions)}
                      </div>
                    );
                  })}

                  {workspaces.length === 0 && (
                    <button
                      onClick={() => {
                        void pickAndChat();
                      }}
                      className="group w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg text-left text-droid-text-muted hover:text-droid-text hover:bg-droid-elevated/40 transition-colors"
                    >
                      <FolderPlus className="w-4 h-4 shrink-0" />
                      <span className="text-[13.5px]">Open workspace</span>
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })()}

        {/* Chats — plain, folder-less conversations */}
        {(() => {
          if (unreadOnly && chatSessions.length === 0) return null;
          const open = !collapsed.has('__chats__');
          return (
            <div>
              <div className="group/header flex items-center gap-1 px-1 pt-1 pb-1.5">
                <button
                  onClick={() => {
                    toggleCollapse('__chats__');
                  }}
                  className="flex items-center gap-2 min-w-0 flex-1 text-left rounded-lg px-1 py-0.5 hover:bg-droid-elevated/40 transition-colors"
                >
                  <ChevronRight
                    className={`w-3 h-3 text-droid-text-muted/70 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
                  />
                  <span className="text-[11px] font-medium tracking-wide text-droid-text-muted">
                    Chats
                  </span>
                </button>
              </div>
              {open &&
                (chatSessions.length === 0 ? (
                  <div className="mt-0.5 px-3 py-2 text-[12px] text-droid-text-muted">
                    No chats yet.
                  </div>
                ) : (
                  renderSessionList('__chats__', chatSessions)
                ))}
            </div>
          );
        })()}
      </div>

      {/* Settings */}
      <div className="px-2 py-2 border-t border-droid-border">
        <AnimatePresence>
          {welcomeVisible && (
            <SidebarWelcomeCard
              onStart={() => {
                dismissWelcome();
                newChat();
              }}
              onDismiss={dismissWelcome}
            />
          )}
        </AnimatePresence>
        <div className="flex items-center gap-1">
          <button
            onClick={() => {
              dispatch({ type: 'TOGGLE_SETTINGS' });
            }}
            className="flex min-w-0 flex-1 items-center gap-2.5 px-2 py-2 rounded-lg text-droid-text-secondary hover:text-droid-text hover:bg-droid-elevated transition-colors text-left"
            title="Open settings"
          >
            <Settings className="w-4 h-4 shrink-0" />
            <span className="text-[13px] font-medium">Settings</span>
          </button>
          <UpdateButton />
        </div>
      </div>

      <AnimatePresence>
        {searchOpen && (
          <SidebarSearch
            onClose={() => {
              setSearchOpen(false);
            }}
            onOpen={handleSelectSession}
          />
        )}
      </AnimatePresence>
    </aside>
  );
}
