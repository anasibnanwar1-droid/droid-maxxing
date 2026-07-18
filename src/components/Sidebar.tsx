import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { useStore } from '../hooks/useStore';
import { pickDirectory } from '../lib/desktop';
import {
  Folder,
  FolderPlus,
  Plus,
  Settings,
  ChevronRight,
  ArrowUpCircle,
  Loader2,
  SquarePen,
} from 'lucide-react';
import {
  buildWorkspaceSections,
  isSubagentSession,
  SIDEBAR_VISIBLE_SESSION_LIMIT,
} from '../lib/workspaces';
import { useMissionLive } from '../hooks/useMissionLive';
import { useAppUpdate } from '../lib/appUpdate';
import { formatRelativeTime } from '../lib/time';
import type { MissionSummary } from '../types/bridge';

// Shown in the title-bar strip when a newer DROIDEX build is available.
function UpdatePill() {
  const { update, downloading, start } = useAppUpdate();
  if (!update?.updateAvailable) return null;
  return (
    <button
      onClick={() => {
        void start();
      }}
      disabled={downloading}
      title={`Update to ${update.latest} and restart`}
      className="no-drag flex items-center gap-1.5 h-6 px-2 rounded-full bg-droid-accent text-droid-bg text-[11px] font-medium hover:opacity-90 transition-opacity disabled:opacity-60"
    >
      {downloading ? (
        <Loader2 className="w-3 h-3 animate-spin" />
      ) : (
        <ArrowUpCircle className="w-3 h-3" />
      )}
      {downloading ? 'Updating…' : 'Update'}
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

// Typing-style animated ellipsis shown where the timestamp sits while the model
// is generating, so an in-flight turn reads as "working…" at a glance.
function WorkingDots() {
  return (
    <span className="flex items-center gap-[3px]" aria-label="working">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="rounded-full bg-current"
          style={{ width: 3, height: 3 }}
          animate={{ opacity: [0.25, 1, 0.25], y: [1, -1.5, 1] }}
          transition={{ duration: 0.9, repeat: Infinity, ease: 'easeInOut', delay: i * 0.16 }}
        />
      ))}
    </span>
  );
}

function SessionRow({
  mission,
  active,
  unread,
  now,
  onClick,
}: {
  mission: MissionSummary;
  active: boolean;
  unread: boolean;
  now: number;
  onClick: () => void;
}) {
  const running = useMissionLive(mission.id);
  const timeLabel = formatRelativeTime(mission.updatedAt, now);
  return (
    <div>
      <button
        onClick={onClick}
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
          {mission.title}
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
}

export default function Sidebar() {
  const { state, dispatch } = useStore();
  const activeMission = state.activeMissionId ? state.missions[state.activeMissionId] : null;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // Per-section count of rows to show; grows by SIDEBAR_VISIBLE_SESSION_LIMIT on
  // each "Show more" so long lists page in (5 + 5 + 5...) rather than loading all.
  const [shownCount, setShownCount] = useState<Map<string, number>>(new Map());

  // Re-render on a slow cadence so relative timestamps ("23m") stay fresh while
  // the window sits idle; activity already triggers its own renders.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const toggleCollapse = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  const visibleCountFor = (key: string) => shownCount.get(key) ?? SIDEBAR_VISIBLE_SESSION_LIMIT;

  const showMore = (key: string) =>
    setShownCount((prev) =>
      new Map(prev).set(key, visibleCountFor(key) + SIDEBAR_VISIBLE_SESSION_LIMIT),
    );

  const showLess = (key: string) =>
    setShownCount((prev) => {
      const next = new Map(prev);
      next.delete(key);
      return next;
    });

  // A session reads as unread when the model has newer activity than the last
  // time the user opened it. The active session is always considered read.
  const isUnread = (m: MissionSummary) =>
    m.id !== state.activeMissionId && m.updatedAt > (state.missionLastSeen[m.id] ?? m.updatedAt);

  const startChat = (cwd: string) => dispatch({ type: 'START_CHAT', cwd });

  const pickAndChat = async () => {
    const dir = await pickDirectory();
    if (!dir) return;
    dispatch({ type: 'ADD_WORKSPACE', cwd: dir });
    startChat(dir);
  };

  // New chat respects context: if the user is currently in a workspace session,
  // start another chat in that workspace; otherwise start a plain no-folder chat.
  const newChat = () => {
    const cwd = activeMission?.cwd ?? state.draftChat?.cwd ?? '';
    startChat(cwd);
  };

  // Plain, folder-less chats (subagent sessions never appear as standalone rows).
  const chatMissions = useMemo<MissionSummary[]>(() => {
    return (state.missionOrder.map((id) => state.missions[id]).filter(Boolean) as MissionSummary[])
      .filter((m) => !m.cwd && !isSubagentSession(m))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [state.missionOrder, state.missions]);

  const workspaces = useMemo(() => {
    const missions = (
      state.missionOrder.map((id) => state.missions[id]).filter(Boolean) as MissionSummary[]
    ).filter((m) => !isSubagentSession(m));
    return buildWorkspaceSections(state.workspaceCwds, missions);
  }, [state.missionOrder, state.missions, state.workspaceCwds]);

  const renderRow = (m: MissionSummary) => (
    <SessionRow
      key={m.id}
      mission={m}
      active={state.activeMissionId === m.id}
      unread={isUnread(m)}
      now={now}
      onClick={() => {
        dispatch({ type: 'SET_ACTIVE_MISSION', id: m.id });
        dispatch({ type: 'SELECT_AGENT', id: null });
      }}
    />
  );

  // Show the latest sessions and tuck the rest behind a "Show more" toggle. The
  // active session is always kept visible so selecting an older one never hides
  // it on the next render.
  const renderSessionList = (sectionKey: string, sessions: MissionSummary[]) => {
    const total = sessions.length;
    const count = Math.min(visibleCountFor(sectionKey), total);
    let visible = sessions.slice(0, count);
    // Keep the active session visible even if it sits below the paged window so
    // selecting an older chat never hides it on the next render.
    if (
      activeMission &&
      sessions.some((m) => m.id === activeMission.id) &&
      !visible.some((m) => m.id === activeMission.id)
    ) {
      visible = [...visible, state.missions[activeMission.id]];
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
                onClick={() => showMore(sectionKey)}
                className="text-[12px] text-droid-text-muted hover:text-droid-text transition-colors"
              >
                Show more
              </button>
            )}
            {isExpanded && (
              <button
                onClick={() => showLess(sectionKey)}
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
      className="w-[280px] h-full flex flex-col border-r border-droid-border shrink-0"
      style={{
        background: 'var(--sidebar-bg)',
        backdropFilter: 'var(--sidebar-blur)',
        WebkitBackdropFilter: 'var(--sidebar-blur)',
      }}
    >
      {/* Draggable top strip (clears macOS traffic lights) */}
      <div data-electron-drag-region className="h-9 shrink-0 flex items-center justify-end pr-2">
        <UpdatePill />
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
        {/* Workspaces — folder-scoped, where missions run (main area) */}
        {(() => {
          const open = !collapsed.has('__workspaces__');
          return (
            <div>
              <div className="group/header flex items-center gap-1 px-1 pt-1 pb-1.5">
                <button
                  onClick={() => toggleCollapse('__workspaces__')}
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
                  onClick={pickAndChat}
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
                            onClick={() => toggleCollapse(ws.cwd)}
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
                            onClick={() => startChat(ws.cwd)}
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
                      onClick={pickAndChat}
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
          const open = !collapsed.has('__chats__');
          return (
            <div>
              <div className="group/header flex items-center gap-1 px-1 pt-1 pb-1.5">
                <button
                  onClick={() => toggleCollapse('__chats__')}
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
                (chatMissions.length === 0 ? (
                  <div className="mt-0.5 px-3 py-2 text-[12px] text-droid-text-muted">
                    No chats yet.
                  </div>
                ) : (
                  renderSessionList('__chats__', chatMissions)
                ))}
            </div>
          );
        })()}
      </div>

      {/* Settings */}
      <div className="px-2 py-2 border-t border-droid-border">
        <button
          onClick={() => dispatch({ type: 'TOGGLE_SETTINGS' })}
          className="w-full flex items-center gap-2.5 px-2 py-2 rounded-lg text-droid-text-secondary hover:text-droid-text hover:bg-droid-elevated transition-colors text-left"
          title="Open settings"
        >
          <Settings className="w-4 h-4 shrink-0" />
          <span className="text-[13px] font-medium">Settings</span>
        </button>
      </div>
    </aside>
  );
}
