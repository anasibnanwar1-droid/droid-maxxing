import { useRef, useEffect, useMemo, useState } from 'react';
import { GripVertical, CornerDownRight, X } from 'lucide-react';
import { useStore } from '../hooks/useStore';
import { useMissionLive } from '../hooks/useMissionLive';
import { MessageFeed } from './chat';
import { readFile } from '../lib/desktop';

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

function ChatHeader({ title, live }: { title: string; live: boolean }) {
  return (
    <div
      data-electron-drag-region
      className="shrink-0 flex items-center h-9 pr-4 pl-4"
    >
      <div className="flex min-w-0 items-center gap-2 rounded-xl bg-droid-elevated/60 pl-2 pr-3 py-1.5">
        <GripVertical className="w-3.5 h-3.5 shrink-0 text-droid-text-muted/40" />
        <span className={`truncate text-[13px] font-medium max-w-[240px] ${live ? 'shimmer-text' : 'text-droid-text'}`}>{title}</span>
      </div>
    </div>
  );
}

function SubAgentBanner({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <div className="shrink-0 mx-auto mt-2 flex w-full max-w-2xl items-center justify-between px-6">
      <span className="flex items-center gap-2 rounded-lg bg-droid-accent/10 px-2.5 py-1 text-[12px] text-droid-accent">
        <CornerDownRight className="h-3.5 w-3.5" />
        Viewing {label}
      </span>
      <button
        onClick={onBack}
        className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-droid-text-muted transition-colors hover:bg-droid-elevated/60 hover:text-droid-text"
      >
        <X className="h-3 w-3" />
        Back to chat
      </button>
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
  const subLabel = workerIndex >= 0 ? missionWorkers[workerIndex].label ?? `Sub-agent ${workerIndex + 1}` : 'Sub-agent';

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

  // The real deliverable in spec mode is a markdown file written to disk
  // (e.g. ~/.factory/specs/<date>-<slug>.md). Detect that path anywhere in the
  // transcript (assistant prose or the write tool's args) and load the file.
  const specPath = useMemo(() => {
    if (!isSpec) return null;
    const re = /(\/[^\s'"`)]*specs\/[^\s'"`)]+\.md)/;
    for (let i = allTranscript.length - 1; i >= 0; i--) {
      const t = allTranscript[i];
      const hay = `${t.text ?? ''} ${t.toolArgs ? JSON.stringify(t.toolArgs) : ''}`;
      const m = hay.match(re);
      if (m) return m[1];
    }
    return null;
  }, [isSpec, allTranscript]);

  const [fileSpec, setFileSpec] = useState<{ path: string; content: string } | null>(null);
  useEffect(() => {
    if (!specPath) return;
    let cancelled = false;
    readFile(specPath).then((content) => {
      if (!cancelled && content) setFileSpec({ path: specPath, content });
    });
    return () => {
      cancelled = true;
    };
  }, [specPath]);

  const hasFileSpec = !!fileSpec && fileSpec.path === specPath;
  // A spec is "ready" once it exists as a saved file or has been submitted via
  // ExitSpecMode. Until then we're still drafting and show prose inline.
  const specReady = isSpec && (hasFileSpec || !!capturedPlan);

  const specContent = useMemo(() => {
    if (!isSpec) return '';
    // 1) The saved spec file (full doc with diagrams/tables) is the best source.
    if (hasFileSpec) return fileSpec!.content;
    // 2) The plan the agent submitted via ExitSpecMode.
    if (capturedPlan) return capturedPlan;
    // 3) Fallback: the single largest assistant text block while drafting.
    const texts = allTranscript
      .filter((t) => t.author !== 'user' && t.kind === 'text')
      .map((m) => m.text ?? '')
      .filter(Boolean);
    return texts.reduce((best, t) => (t.length > best.length ? t : best), '');
  }, [isSpec, hasFileSpec, fileSpec, capturedPlan, allTranscript]);

  return (
    <div className="flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden">
      {activeMission && (
        <ChatHeader title={activeMission.title} live={live} />
      )}
      {viewingSub && <SubAgentBanner label={subLabel} onBack={() => dispatch({ type: 'SELECT_AGENT', id: null })} />}
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
              isSpec={isSpec}
              specContent={specContent}
              specReady={specReady}
            />
          </div>
        ) : activeMission && viewingSub ? (
          <div className="flex h-full items-center justify-center px-8 text-center text-[13px] text-droid-text-muted">
            Waiting for {subLabel} activity…
          </div>
        ) : (
          <EmptyState folder={draftFolder} />
        )}
      </div>
    </div>
  );
}
