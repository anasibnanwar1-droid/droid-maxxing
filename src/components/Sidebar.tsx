import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { useStore } from '../hooks/useStore';
import { pickDirectory } from '../lib/desktop';
import { Folder, MessageSquare, FolderPlus, Plus, User, Settings, ChevronRight, CornerDownRight } from 'lucide-react';
import { subscribeWorker } from '../lib/commands';
import type { MissionSummary } from '../types/bridge';
import type { WorkerInfo } from '../hooks/useStore';

const RUNNING_PHASES = ['running', 'initializing', 'orchestrator_turn'];

function RunningGrid() {
  return (
    <span className="grid grid-cols-3 gap-[2px] shrink-0" style={{ width: 12, height: 12 }} aria-label="running">
      {Array.from({ length: 9 }).map((_, i) => (
        <motion.span
          key={i}
          className="rounded-[1px]"
          style={{ width: 2.5, height: 2.5, background: 'currentColor' }}
          animate={{ opacity: [0.2, 1, 0.2] }}
          transition={{
            duration: 1.1,
            repeat: Infinity,
            ease: 'easeInOut',
            delay: ((i % 3) + Math.floor(i / 3)) * 0.12,
          }}
        />
      ))}
    </span>
  );
}

function workspaceName(cwd?: string): string {
  if (!cwd) return 'Home';
  const base = cwd.split('/').filter(Boolean).pop();
  return base || 'Home';
}

interface Workspace {
  key: string;
  name: string;
  isHome: boolean;
  missions: MissionSummary[];
}

function SubAgentRow({ label, running, selected, onClick }: { label: string; running: boolean; selected: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`group w-full flex items-center gap-1.5 pl-6 pr-2 py-1 rounded-lg text-left transition-colors ${
        selected ? 'bg-droid-elevated/70' : 'hover:bg-droid-elevated/30'
      }`}
    >
      <CornerDownRight className={`w-3 h-3 shrink-0 ${selected ? 'text-droid-accent' : 'text-droid-text-muted/60'}`} />
      <span className={`min-w-0 flex-1 truncate text-[12px] ${selected ? 'text-droid-text' : 'text-droid-text-muted group-hover:text-droid-text-secondary'}`}>
        {label}
      </span>
      {running && (
        <motion.span
          className="w-1.5 h-1.5 rounded-full bg-droid-accent shrink-0"
          animate={{ opacity: [0.3, 1, 0.3] }}
          transition={{ duration: 1.2, repeat: Infinity, ease: 'easeInOut' }}
        />
      )}
    </button>
  );
}

function SessionRow({
  mission, active, workers, selectedAgentId, onClick, onSelectAgent,
}: {
  mission: MissionSummary;
  active: boolean;
  workers: WorkerInfo[];
  selectedAgentId: string | null;
  onClick: () => void;
  onSelectAgent: (sessionId: string) => void;
}) {
  const running = Boolean(mission.streaming) || RUNNING_PHASES.includes(mission.phase);
  const onMain = active && !selectedAgentId;
  return (
    <div>
      <button
        onClick={onClick}
        className={`group w-full flex items-center gap-2.5 pl-3 pr-2 py-1.5 rounded-xl text-left transition-colors ${
          onMain
            ? 'bg-droid-elevated'
            : 'hover:bg-droid-elevated/40'
        }`}
      >
        <span className={`w-3 flex items-center justify-center shrink-0 ${active ? 'text-droid-text' : 'text-droid-text-secondary group-hover:text-droid-text'}`}>
          {running && <RunningGrid />}
        </span>
        <span className={`min-w-0 flex-1 truncate text-[13px] ${active ? 'text-droid-text' : 'text-droid-text-secondary group-hover:text-droid-text'}`}>
          {mission.title}
        </span>
      </button>
      {workers.length > 0 && (
        <div className="mt-0.5 space-y-0.5">
          {workers.map((w, i) => (
            <SubAgentRow
              key={w.sessionId}
              label={w.label ?? `Sub-agent ${i + 1}`}
              running={w.status === 'running'}
              selected={active && selectedAgentId === w.sessionId}
              onClick={() => onSelectAgent(w.sessionId)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function Sidebar() {
  const { state, dispatch } = useStore();
  const activeMission = state.activeMissionId ? state.missions[state.activeMissionId] : null;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggleCollapse = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  const startChat = (cwd: string) => dispatch({ type: 'START_CHAT', cwd });

  const pickAndChat = async () => {
    const dir = await pickDirectory();
    if (dir) startChat(dir);
  };

  // New chat respects context: if the user is currently in a workspace session,
  // start another chat in that workspace; otherwise start a plain no-folder chat.
  const newChat = () => {
    const cwd = activeMission?.cwd ?? '';
    startChat(cwd);
  };

  // Plain, folder-less chats.
  const chatMissions = useMemo<MissionSummary[]>(() => {
    return (state.missionOrder.map((id) => state.missions[id]).filter(Boolean) as MissionSummary[])
      .filter((m) => !m.cwd)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [state.missionOrder, state.missions]);

  // Folder-scoped workspaces (where missions run).
  const workspaces = useMemo<Workspace[]>(() => {
    const missions = state.missionOrder.map((id) => state.missions[id]).filter(Boolean) as MissionSummary[];
    const map = new Map<string, Workspace>();
    for (const m of missions) {
      if (!m.cwd) continue; // plain chats belong to the Chats section
      const key = m.cwd;
      if (!map.has(key)) map.set(key, { key, name: workspaceName(m.cwd), isHome: false, missions: [] });
      map.get(key)!.missions.push(m);
    }
    const list = Array.from(map.values());
    list.forEach((w) => w.missions.sort((a, b) => b.updatedAt - a.updatedAt));
    return list.sort((a, b) => {
      const am = Math.max(...a.missions.map((m) => m.updatedAt));
      const bm = Math.max(...b.missions.map((m) => m.updatedAt));
      return bm - am;
    });
  }, [state.missionOrder, state.missions]);

  const renderRow = (m: MissionSummary) => (
    <SessionRow
      key={m.id}
      mission={m}
      active={state.activeMissionId === m.id}
      workers={state.workers[m.id] ?? []}
      selectedAgentId={state.activeMissionId === m.id ? state.selectedAgentSessionId : null}
      onClick={() => {
        dispatch({ type: 'SET_ACTIVE_MISSION', id: m.id });
        dispatch({ type: 'SELECT_AGENT', id: null });
      }}
      onSelectAgent={(sessionId) => {
        dispatch({ type: 'SET_ACTIVE_MISSION', id: m.id });
        dispatch({ type: 'SELECT_AGENT', id: sessionId });
        subscribeWorker(m.id, sessionId);
      }}
    />
  );

  return (
    <aside className="w-[280px] h-full flex flex-col bg-droid-surface border-r border-droid-border shrink-0">
      {/* Draggable top strip (clears macOS traffic lights) */}
      <div data-electron-drag-region className="h-9 shrink-0" />

      <div className="px-2 pb-2">
        <button
          onClick={newChat}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-[13px] font-medium text-droid-text bg-droid-elevated/70 hover:bg-droid-elevated transition-colors"
        >
          <Plus className="w-4 h-4 shrink-0" />
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
                  <ChevronRight className={`w-3 h-3 text-droid-text-muted/70 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
                  <span className="text-[11px] font-medium tracking-wide text-droid-text-muted">Workspaces</span>
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
                    const wsOpen = !collapsed.has(ws.key);
                    return (
                      <div key={ws.key}>
                        <div className="group flex items-center gap-1 px-1 py-1">
                          <button
                            onClick={() => toggleCollapse(ws.key)}
                            className="flex items-center gap-2 min-w-0 flex-1 text-left rounded-lg px-1 py-0.5 hover:bg-droid-elevated/40 transition-colors"
                          >
                            <ChevronRight className={`w-3 h-3 text-droid-text-muted/70 shrink-0 transition-transform ${wsOpen ? 'rotate-90' : ''}`} />
                            <Folder className="w-4 h-4 text-droid-text-muted shrink-0" />
                            <span className="min-w-0 flex-1 truncate text-[13.5px] text-droid-text">{ws.name}</span>
                          </button>
                          <button
                            onClick={() => startChat(ws.key)}
                            title="New chat here"
                            className="p-0.5 rounded-md text-droid-text-muted/0 group-hover:text-droid-text-muted hover:text-droid-text hover:bg-droid-elevated/60 transition-colors shrink-0"
                          >
                            <Plus className="w-3.5 h-3.5" />
                          </button>
                        </div>
                        {wsOpen && <div className="mt-0.5 space-y-0.5">{ws.missions.map(renderRow)}</div>}
                      </div>
                    );
                  })}

                  {workspaces.length === 0 && (
                    <div className="px-3 py-2 text-[12px] text-droid-text-muted">No workspaces yet.</div>
                  )}

                  <button
                    onClick={pickAndChat}
                    className="group w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg text-left text-droid-text-muted hover:text-droid-text hover:bg-droid-elevated/40 transition-colors"
                  >
                    <FolderPlus className="w-4 h-4 shrink-0" />
                    <span className="text-[13.5px]">Open Workspace</span>
                  </button>
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
                  <ChevronRight className={`w-3 h-3 text-droid-text-muted/70 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
                  <MessageSquare className="w-3.5 h-3.5 text-droid-text-muted shrink-0" />
                  <span className="text-[11px] font-medium tracking-wide text-droid-text-muted">Chats</span>
                </button>
                <button
                  onClick={() => startChat('')}
                  title="New chat"
                  className="p-0.5 rounded-md text-droid-text-muted hover:text-droid-text hover:bg-droid-elevated/60 transition-colors shrink-0"
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
              </div>
              {open && (
                <div className="mt-0.5 space-y-0.5">
                  {chatMissions.map(renderRow)}
                  {chatMissions.length === 0 && (
                    <div className="px-3 py-2 text-[12px] text-droid-text-muted">No chats yet.</div>
                  )}
                </div>
              )}
            </div>
          );
        })()}
      </div>

      {/* Account bar */}
      <div className="px-2 py-2 border-t border-droid-border">
        <button
          onClick={() => dispatch({ type: 'TOGGLE_SETTINGS' })}
          className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg hover:bg-droid-elevated transition-colors text-left"
          title="Open settings"
        >
          <span className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 bg-droid-accent/15 text-droid-accent">
            <User className="w-4 h-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[12px] text-droid-text leading-tight truncate">Anas</span>
            <span className="block text-[10.5px] text-droid-text-muted leading-tight truncate">Max Plan</span>
          </span>
          <Settings className="w-4 h-4 text-droid-text-muted shrink-0" />
        </button>
      </div>
    </aside>
  );
}
