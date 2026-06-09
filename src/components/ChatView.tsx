import { useRef, useEffect, useMemo, useState } from 'react';
import { GripVertical, ChevronRight, Square } from 'lucide-react';
import { useStore } from '../hooks/useStore';
import { useMissionLive } from '../hooks/useMissionLive';
import { MessageFeed, WorkingIndicator } from './chat';
import { readFile } from '../lib/desktop';
import { interruptAgent } from '../lib/commands';

function DroidWordmark() {
  return (
    <div
      className="font-mono font-black tracking-[0.2em] select-none"
      style={{
        fontSize: 'clamp(48px, 10vw, 120px)',
        lineHeight: 1.1,
        background: 'radial-gradient(circle, #3a3a3a 1.5px, transparent 1.5px)',
        backgroundSize: '8px 8px',
        WebkitBackgroundClip: 'text',
        backgroundClip: 'text',
        color: 'transparent',
      }}
    >
      DROID
    </div>
  );
}

function EmptyState({ folder }: { folder?: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-8">
      <DroidWordmark />
      <div className="mt-6 flex items-center gap-4 text-xs text-droid-text-muted">
        <div className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-droid-green" />
          <span>Local</span>
        </div>
        <div className="flex items-center gap-1.5">
          <FolderIcon />
          <span>{folder || 'anas'}</span>
        </div>
      </div>
    </div>
  );
}

function FolderIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function ChatHeader({ title, live, sub }: {
  title: string;
  live: boolean;
  sub?: { label: string; meta?: string; running: boolean; onBack: () => void; onStop?: () => void };
}) {
  return (
    <div
      data-electron-drag-region
      className="shrink-0 flex items-center gap-2 h-9 pr-4 pl-4"
    >
      <div className="flex min-w-0 items-center gap-1.5 rounded-xl bg-droid-elevated/60 pl-2 pr-3 py-1.5">
        <GripVertical className="w-3.5 h-3.5 shrink-0 text-droid-text-muted/40" />
        {sub ? (
          <button
            type="button"
            onClick={sub.onBack}
            title="Back to main agent"
            className="truncate text-[13px] font-medium text-droid-text-muted transition-colors hover:text-droid-text max-w-[200px]"
          >
            {title}
          </button>
        ) : (
          <span className={`truncate text-[13px] font-medium max-w-[240px] ${live ? 'shimmer-text' : 'text-droid-text'}`}>{title}</span>
        )}
        {sub && (
          <>
            <ChevronRight className="w-3.5 h-3.5 shrink-0 text-droid-text-muted/50" />
            <span className={`truncate text-[13px] font-medium max-w-[200px] ${sub.running ? 'shimmer-text' : 'text-droid-text'}`}>{sub.label}</span>
            {sub.meta && <span className="shrink-0 font-mono text-[10px] text-droid-text-muted/70">{sub.meta}</span>}
          </>
        )}
      </div>
      {sub?.onStop && (
        <button
          type="button"
          onClick={sub.onStop}
          title="Stop subagent"
          className="flex shrink-0 items-center gap-1 rounded-lg bg-droid-elevated/60 px-2.5 py-1.5 text-[11px] text-droid-text-muted transition-colors hover:bg-droid-elevated hover:text-droid-text"
        >
          <Square className="h-3 w-3" />
          Stop
        </button>
      )}
    </div>
  );
}

export default function ChatView({ rightInset = false }: { rightInset?: boolean }) {
  const { state, dispatch } = useStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeMission = state.activeMissionId ? state.missions[state.activeMissionId] : null;
  const allTranscript = activeMission ? state.transcripts[activeMission.id] ?? [] : [];

  const selectedAgent = state.selectedAgentSessionId;
  const viewingSub = !!selectedAgent && selectedAgent !== 'orchestrator';

  const missionWorkers = activeMission ? state.workers[activeMission.id] ?? [] : [];
  const workerIndex = missionWorkers.findIndex((w) => w.sessionId === selectedAgent);
  const selectedWorker = workerIndex >= 0 ? missionWorkers[workerIndex] : undefined;
  const subLabel = selectedWorker ? selectedWorker.label ?? `Sub-agent ${workerIndex + 1}` : 'Sub-agent';
  const subModel = selectedWorker?.modelId
    ? state.models.find((m) => m.id === selectedWorker.modelId)?.displayName ?? selectedWorker.modelId
    : undefined;
  const subMeta = [subModel, selectedWorker?.reasoningEffort].filter(Boolean).join(' · ');

  // Navigate to a spawned subagent from its in-chat card: match the droid name,
  // preferring a still-running instance, then hand off to the right-panel view.
  const openSubagentByLabel = (label?: string) => {
    if (!label) return;
    const matches = missionWorkers.filter((w) => (w.label ?? '').toLowerCase() === label.toLowerCase());
    const target = matches.find((w) => w.status === 'running') ?? matches[matches.length - 1];
    if (target) dispatch({ type: 'SELECT_AGENT', id: target.sessionId });
  };

  const transcript = useMemo(() => {
    if (viewingSub) return allTranscript.filter((t) => t.agentSessionId === selectedAgent);
    return allTranscript.filter((t) => t.role === 'orchestrator' || (t.author === 'user' && t.agentSessionId === 'user'));
  }, [allTranscript, viewingSub, selectedAgent]);

  // Only auto-scroll when the user is already pinned to the bottom; if they've
  // scrolled up to read, leave their position alone while the model responds.
  const stickRef = useRef(true);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  const tailLen = transcript.length > 0 ? (transcript[transcript.length - 1].text?.length ?? 0) : 0;
  useEffect(() => {
    if (scrollRef.current && stickRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [transcript.length, tailLen]);

  const live = useMissionLive(activeMission?.id ?? null);
  const draftFolder = state.draftChat?.cwd.split('/').filter(Boolean).pop();

  const isSpec = activeMission?.kind === 'spec';
  const capturedPlan = activeMission ? state.specPlans[activeMission.id] : undefined;
  const storedSpec = activeMission ? state.missionSpecs[activeMission.id] : undefined;
  // The spec stays available after exiting spec mode: keep detecting/loading it
  // whenever this mission ever produced one (live kind, captured plan, or a
  // previously stored spec).
  const hadSpec = isSpec || !!capturedPlan || !!storedSpec;

  // The real deliverable in spec mode is a markdown file written to disk
  // (e.g. ~/.factory/specs/<date>-<slug>.md). Detect that path anywhere in the
  // transcript (assistant prose or the write tool's args) and load the file.
  const specPath = useMemo(() => {
    if (!hadSpec) return null;
    const re = /(\/[^\s'"`)]*specs\/[^\s'"`)]+\.md)/;
    for (let i = allTranscript.length - 1; i >= 0; i--) {
      const t = allTranscript[i];
      const hay = `${t.text ?? ''} ${t.toolArgs ? JSON.stringify(t.toolArgs) : ''}`;
      const m = hay.match(re);
      if (m) return m[1];
    }
    return null;
  }, [hadSpec, allTranscript]);

  const [fileSpec, setFileSpec] = useState<{ path: string; content: string } | null>(null);
  // Re-read on `capturedPlan` changes too: a revised spec rewrites the same file
  // path, so the path alone wouldn't trigger a reload and the card would go stale.
  useEffect(() => {
    if (!specPath) return;
    let cancelled = false;
    readFile(specPath).then((content) => {
      if (!cancelled && content) setFileSpec({ path: specPath, content });
    });
    return () => {
      cancelled = true;
    };
  }, [specPath, capturedPlan]);

  const hasFileSpec = !!fileSpec && fileSpec.path === specPath;

  const specContent = useMemo(() => {
    if (!hadSpec) return '';
    // 1) The saved spec file (full doc with diagrams/tables) is the best source.
    if (hasFileSpec) return fileSpec!.content;
    // 2) The plan the agent submitted via ExitSpecMode.
    if (capturedPlan) return capturedPlan;
    // 3) Previously persisted spec (e.g. after switching missions and back).
    if (storedSpec?.content) return storedSpec.content;
    // 4) Fallback while still drafting: the largest assistant text block.
    if (!isSpec) return '';
    const texts = allTranscript
      .filter((t) => t.author !== 'user' && t.kind === 'text')
      .map((m) => m.text ?? '')
      .filter(Boolean);
    return texts.reduce((best, t) => (t.length > best.length ? t : best), '');
  }, [hadSpec, isSpec, hasFileSpec, fileSpec, capturedPlan, storedSpec, allTranscript]);

  // Persist the best spec we have so the card, wiki reader, and right-panel
  // button survive exiting spec mode and switching between sessions.
  const missionId = activeMission?.id;
  useEffect(() => {
    if (!missionId || !specContent) return;
    const title = specContent.match(/^#{1,3}\s+(.+)$/m)?.[1]?.trim() ?? 'Specification';
    // Preserve the existing file path when the current source is not file-backed
    // (e.g. a captured plan), so the store never loses a known path on refresh.
    const path = hasFileSpec ? fileSpec!.path : storedSpec?.path;
    dispatch({ type: 'SPEC_SET', missionId, path, title, content: specContent });
  }, [missionId, specContent, hasFileSpec, fileSpec, storedSpec?.path, dispatch]);

  return (
    <div className="flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden">
      {activeMission && (
        <ChatHeader
          title={activeMission.title}
          live={live}
          sub={viewingSub ? {
            label: subLabel,
            meta: subMeta || undefined,
            running: selectedWorker?.status === 'running',
            onBack: () => dispatch({ type: 'SELECT_AGENT', id: null }),
            onStop: activeMission && selectedAgent && selectedWorker?.status === 'running'
              ? () => interruptAgent(activeMission.id, selectedAgent)
              : undefined,
          } : undefined}
        />
      )}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden"
        style={{ paddingRight: rightInset ? 312 : undefined, transition: 'padding-right 0.2s ease' }}
      >
        {activeMission && transcript.length > 0 ? (
          <div className="mx-auto min-w-0 px-6 py-6 max-w-2xl">
            <MessageFeed
              events={transcript}
              pending={live}
              onOpenSubagent={openSubagentByLabel}
              specDraft={isSpec}
              specContent={specContent}
              onOpenSpecWiki={missionId ? () => dispatch({ type: 'SPEC_OPEN_WIKI', missionId }) : undefined}
            />
          </div>
        ) : activeMission && viewingSub ? (
          <div className="mx-auto flex h-full max-w-2xl flex-col items-center justify-center gap-4 px-8 text-center">
            {selectedWorker?.prompt && (
              <div className="max-w-lg rounded-xl bg-droid-elevated/40 px-4 py-3 text-left">
                <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-droid-text-muted">Task</div>
                <div className="text-[12.5px] leading-relaxed text-droid-text-secondary whitespace-pre-wrap [overflow-wrap:anywhere]">{selectedWorker.prompt}</div>
              </div>
            )}
            {selectedWorker?.status === 'running' ? (
              <WorkingIndicator label={`${subLabel} is working`} startTs={selectedWorker.startedAt} />
            ) : (
              <span className="text-[13px] text-droid-text-muted">No activity captured for {subLabel}.</span>
            )}
          </div>
        ) : (
          <EmptyState folder={draftFolder} />
        )}
      </div>
    </div>
  );
}
