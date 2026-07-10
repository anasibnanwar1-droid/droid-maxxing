import { useMemo, useState, type MutableRefObject } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, History, Plus } from 'lucide-react';
import { useStore } from '../../hooks/useStore';
import { useDesignStore } from '../../hooks/useDesignStore';
import { listMissions, loadMissionHistory } from '../../lib/commands';
import type { StudioCanvasState } from './StudioCanvasContext';
import { emptyStudioCanvasState, useStudioCanvas } from './StudioCanvasContext';

function relativeTime(ts?: number): string {
  if (!ts) return '';
  const delta = Date.now() - ts;
  const mins = Math.floor(delta / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Top-bar history control: open earlier design threads for this project, start
 * a new one, and restore each thread's canvas snapshot on switch.
 */
export default function ThreadHistoryMenu({
  cwd,
  canvasCache,
}: {
  cwd: string;
  /** Mutable per-thread canvas snapshots shared with StudioShell. */
  canvasCache: MutableRefObject<Record<string, StudioCanvasState>>;
}) {
  const { state } = useStore();
  const { design, designDispatch } = useDesignStore();
  const { studio, studioDispatch } = useStudioCanvas();
  const [open, setOpen] = useState(false);
  const activeId = design.sessions[cwd] || null;

  const threads = useMemo(() => {
    return Object.values(state.missions)
      .filter(
        (m) =>
          m.cwd === cwd &&
          m.kind !== 'mission_orchestrator' &&
          (m.title === 'Design' || m.kind === 'chat' || m.kind === 'spec'),
      )
      .sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0))
      .slice(0, 24);
  }, [state.missions, cwd]);

  const openMenu = () => {
    setOpen(true);
    // Refresh the mission list so older design chats show up.
    listMissions({ workspaceCwds: cwd ? [cwd] : undefined, includePlainChats: true, limitPerWorkspace: 40 });
  };

  const switchTo = (missionId: string) => {
    // Snapshot the current canvas under the current thread key (or "new" if none).
    const prevKey = activeId ?? `__new__:${cwd}`;
    canvasCache.current[prevKey] = {
      ...studio,
      frames: studio.frames.map((f) => ({ ...f })),
      selectedFrameIds: [...studio.selectedFrameIds],
      selection: studio.selection.map((s) => ({ ...s })),
      view: { ...studio.view },
      settings: { ...studio.settings },
      interactingFrameId: null,
    };
    designDispatch({ type: 'SET_SESSION', cwd, missionId });
    const next = canvasCache.current[missionId] ?? emptyStudioCanvasState();
    studioDispatch({ type: 'HYDRATE', state: next });
    if (!state.historyLoaded[missionId] && (state.transcripts[missionId]?.length ?? 0) === 0) {
      loadMissionHistory(missionId);
    }
    setOpen(false);
  };

  const startNew = () => {
    const prevKey = activeId ?? `__new__:${cwd}`;
    canvasCache.current[prevKey] = {
      ...studio,
      frames: studio.frames.map((f) => ({ ...f })),
      selectedFrameIds: [...studio.selectedFrameIds],
      selection: studio.selection.map((s) => ({ ...s })),
      view: { ...studio.view },
      settings: { ...studio.settings },
      interactingFrameId: null,
    };
    designDispatch({ type: 'SET_SESSION', cwd, missionId: null });
    studioDispatch({ type: 'HYDRATE', state: emptyStudioCanvasState() });
    setOpen(false);
  };

  return (
    <div className="relative">
      <button
        onClick={() => (open ? setOpen(false) : openMenu())}
        title="Thread history"
        className="no-drag flex h-7 w-7 items-center justify-center rounded-md text-droid-text-muted transition-colors hover:bg-white/10 hover:text-droid-text"
      >
        <History className="h-4 w-4" />
      </button>
      <AnimatePresence>
        {open && (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
            <motion.div
              initial={{ opacity: 0, y: 6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.98 }}
              transition={{ type: 'spring', damping: 24, stiffness: 340 }}
              className="no-drag absolute right-0 top-full z-40 mt-1.5 w-72 overflow-hidden rounded-xl border border-droid-border bg-droid-elevated shadow-2xl"
            >
              <div className="flex items-center justify-between border-b border-droid-border px-2.5 py-2">
                <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-droid-text-muted">
                  Threads
                </span>
                <button
                  onClick={startNew}
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-droid-text-secondary transition-colors hover:bg-white/[0.06] hover:text-droid-text"
                >
                  <Plus className="h-3 w-3" />
                  New
                </button>
              </div>
              <div className="max-h-[280px] overflow-y-auto p-1">
                {!activeId && (
                  <div className="flex items-center gap-2 rounded-lg bg-[#ee6018]/[0.1] px-2.5 py-2 text-[12px] text-[#f0a060]">
                    <Check className="h-3.5 w-3.5 shrink-0" />
                    New thread (not started)
                  </div>
                )}
                {threads.length === 0 && activeId == null && (
                  <div className="px-2.5 py-3 text-center text-[11.5px] text-droid-text-muted">
                    No earlier design threads yet.
                  </div>
                )}
                {threads.map((m) => {
                  const selected = m.id === activeId;
                  return (
                    <button
                      key={m.id}
                      onClick={() => switchTo(m.id)}
                      className={`flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors ${
                        selected ? 'bg-[#ee6018]/[0.12]' : 'hover:bg-white/[0.05]'
                      }`}
                    >
                      <span className="min-w-0 flex-1">
                        <span
                          className={`block truncate text-[12.5px] ${selected ? 'text-[#f0a060]' : 'text-droid-text'}`}
                        >
                          {m.title || 'Design'}
                        </span>
                        <span className="mt-0.5 block truncate text-[10.5px] text-droid-text-muted">
                          {relativeTime(m.updatedAt ?? m.createdAt)}
                          {m.modelId ? ` · ${m.modelId}` : ''}
                        </span>
                      </span>
                      {selected && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#ee6018]" />}
                    </button>
                  );
                })}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
