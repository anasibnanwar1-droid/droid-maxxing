import { useMemo, useRef, useState } from 'react';
import { Check, History, Plus } from 'lucide-react';
import { useStore } from '../../hooks/useStore';
import { useDesignStore } from '../../hooks/useDesignStore';
import { listSessions, loadSessionHistory } from '../../lib/commands';
import type { TranscriptEvent } from '../../types/bridge';
import { Popover } from '../environment/Popover';
import { emptyStudioCanvasState, useStudioCanvas } from './StudioCanvasContext';
import type { StudioCanvasState } from './StudioCanvasContext';

function relativeTime(ts?: number): string {
  if (!ts) return '';
  const delta = Date.now() - ts;
  const mins = Math.floor(delta / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${String(mins)}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  const days = Math.floor(hours / 24);
  return `${String(days)}d ago`;
}

function threadKey(projectKey: string, appSessionId: string | null | undefined): string {
  // Empty / null = intentional new thread. Never use || here — '' is falsy.
  return appSessionId != null && appSessionId !== '' ? appSessionId : `__new__:${projectKey}`;
}

function snapshotCanvas(studio: StudioCanvasState): StudioCanvasState {
  return {
    ...studio,
    frames: studio.frames.map((f) => ({ ...f })),
    selectedFrameIds: [...studio.selectedFrameIds],
    selection: studio.selection.map((s) => ({ ...s })),
    annotations: studio.annotations.map((annotation) => ({
      ...annotation,
      points: annotation.points.map((point) => ({ ...point })),
    })),
    attachedAnnotationIds: [...studio.attachedAnnotationIds],
    drawingStyle: { ...studio.drawingStyle },
    view: { ...studio.view },
    settings: { ...studio.settings },
    interactingFrameId: null,
  };
}

/**
 * History control: open earlier design threads, start a new one, restore each
 * thread's canvas from design.canvasByThread (store-backed so remounts keep it).
 */
export default function ThreadHistoryMenu({
  cwd,
  sessionKey,
  variant = 'icon',
}: {
  cwd: string;
  sessionKey?: string;
  variant?: 'icon' | 'tab';
}) {
  const { state } = useStore();
  const { design, designDispatch } = useDesignStore();
  const { studio, studioDispatch } = useStudioCanvas();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // sessionKey may be '' — the cwd fallback must still apply for it.
  const key = sessionKey === undefined || sessionKey === '' ? cwd : sessionKey;
  // Distinguish intentional new thread ('') from "not set" (undefined).
  const rawSession = design.sessions[key] ?? design.sessions[cwd];
  const intentionalNew = rawSession === '';
  const activeId = intentionalNew ? null : rawSession || null;

  const projectCwds = useMemo(() => {
    const set = new Set<string>([cwd, key].filter(Boolean));
    for (const ws of Object.values(design.workspaces)) {
      if (ws.liveCwd === key || ws.liveCwd === cwd || ws.path === cwd || ws.path === key) {
        set.add(ws.liveCwd);
        set.add(ws.path);
      }
    }
    return set;
  }, [cwd, key, design.workspaces]);

  const threads = useMemo(() => {
    return Object.values(state.sessions)
      .filter((m) => projectCwds.has(m.cwd) && m.sessionPurpose === 'design')
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 24);
  }, [state.sessions, projectCwds]);

  const openMenu = () => {
    setOpen(true);
    // Fire-and-forget list refresh; don't block the menu open.
    const cwds = [...projectCwds];
    listSessions({
      workspaceCwds: cwds.length ? cwds : undefined,
      includePlainChats: true,
      limitPerWorkspace: 40,
    });
  };

  const switchTo = (appSessionId: string) => {
    if (appSessionId === activeId) {
      setOpen(false);
      return;
    }
    const prevKey = threadKey(key, activeId);
    designDispatch({ type: 'SAVE_CANVAS', threadKey: prevKey, state: snapshotCanvas(studio) });
    designDispatch({ type: 'SET_SESSION', cwd: key, appSessionId });
    const next = design.canvasByThread[appSessionId] ?? emptyStudioCanvasState();
    studioDispatch({ type: 'HYDRATE', state: next });
    // Record index access can miss at runtime; widen so the empty-check stays safe.
    const transcript = state.transcripts[appSessionId] as TranscriptEvent[] | undefined;
    if (!state.historyLoaded[appSessionId] && (transcript?.length ?? 0) === 0) {
      loadSessionHistory(appSessionId);
    }
    setOpen(false);
  };

  const startNew = () => {
    if (intentionalNew) {
      setOpen(false);
      return;
    }
    const prevKey = threadKey(key, activeId);
    designDispatch({ type: 'SAVE_CANVAS', threadKey: prevKey, state: snapshotCanvas(studio) });
    designDispatch({ type: 'SET_SESSION', cwd: key, appSessionId: null });
    const next = design.canvasByThread[threadKey(key, null)] ?? emptyStudioCanvasState();
    studioDispatch({ type: 'HYDRATE', state: next });
    setOpen(false);
  };

  const trigger = (
    <button
      ref={triggerRef}
      onClick={() => {
        if (open) {
          setOpen(false);
        } else {
          openMenu();
        }
      }}
      title="Earlier threads & canvases"
      aria-label="Earlier design threads"
      aria-expanded={open}
      className={
        variant === 'tab'
          ? 'flex h-8 w-8 items-center justify-center rounded-lg text-droid-text-muted transition-colors hover:bg-droid-elevated hover:text-droid-text'
          : 'no-drag flex h-8 w-8 items-center justify-center rounded-lg text-droid-text-muted transition-colors hover:bg-droid-elevated hover:text-droid-text'
      }
    >
      <History className="h-3.5 w-3.5" strokeWidth={1.75} />
    </button>
  );

  return (
    <>
      {trigger}
      <Popover
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        anchorRef={triggerRef}
        label="Design threads"
        align="right"
        width={288}
        className="studio-popover no-drag"
      >
        <div data-studio-dismissable-layer className="min-h-0">
          <div className="flex items-center justify-between border-b border-droid-border px-2.5 py-2">
            <span className="text-[11.5px] font-medium text-droid-text-secondary">Threads</span>
            <button
              onClick={startNew}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-droid-text-secondary transition-colors hover:bg-droid-active/70 hover:text-droid-text"
            >
              <Plus className="h-3 w-3" />
              New
            </button>
          </div>
          <div className="max-h-[280px] overflow-y-auto p-1">
            {intentionalNew && (
              <div className="flex items-center gap-2 rounded-lg bg-droid-accent/10 px-2.5 py-2 text-[12px] text-droid-accent">
                <Check className="h-3.5 w-3.5 shrink-0" />
                New thread (not started)
              </div>
            )}
            {threads.length === 0 && !activeId && !intentionalNew && (
              <div className="px-2.5 py-3 text-center text-[11.5px] text-droid-text-muted">
                No earlier design threads yet.
              </div>
            )}
            {threads.map((m) => {
              const selected = m.appSessionId === activeId;
              return (
                <button
                  key={m.appSessionId}
                  onClick={() => {
                    switchTo(m.appSessionId);
                  }}
                  className={`flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors ${
                    selected ? 'bg-droid-accent/10' : 'hover:bg-droid-active/70'
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span
                      className={`block truncate text-[12.5px] ${selected ? 'text-droid-accent' : 'text-droid-text'}`}
                    >
                      {m.title || 'Untitled design'}
                    </span>
                    <span className="mt-0.5 block truncate text-[10.5px] text-droid-text-muted">
                      {relativeTime(m.updatedAt)}
                      {m.modelId ? ` · ${m.modelId}` : ''}
                    </span>
                  </span>
                  {selected && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-droid-accent" />}
                </button>
              );
            })}
          </div>
        </div>
      </Popover>
    </>
  );
}
