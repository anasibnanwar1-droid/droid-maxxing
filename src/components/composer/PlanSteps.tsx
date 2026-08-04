import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, ChevronDown } from 'lucide-react';
import { useStore } from '../../hooks/useStore';
import { useSessionLive } from '../../hooks/useSessionLive';
import {
  activeTodoIndex,
  latestTodoSnapshot,
  type TodoItem,
  type TodoStatus,
} from '../../lib/tools';
import { scopeTranscriptToAgent } from '../../lib/transcript';
import { visibleSessionTarget } from '../../lib/childSessions';

const EASE = [0.16, 1, 0.3, 1] as const;

function stepTone(item: TodoItem, isActive: boolean): string {
  if (isActive) return 'text-droid-text font-medium';
  if (item.status === 'completed') return 'text-droid-text-secondary';
  return 'text-droid-text-muted';
}

// Per-step status glyph: a filled ring once done, an empty ring for upcoming
// steps, and the empty ring with a spinning arc only while the model is working.
function StepRing({
  status,
  active,
  spinning,
}: {
  status: TodoStatus;
  active: boolean;
  spinning: boolean;
}) {
  if (status === 'completed') {
    return (
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-droid-accent">
        <Check className="h-2 w-2 text-droid-bg" strokeWidth={3} />
      </span>
    );
  }
  return (
    <span
      className={`h-3.5 w-3.5 shrink-0 rounded-full border-[1.5px] border-droid-text-muted/30 ${
        active && spinning ? 'border-t-droid-text' : ''
      } ${active && spinning ? 'animate-spin' : ''}`}
      style={active && spinning ? { animationDuration: '1.4s' } : undefined}
    />
  );
}

// The model's plan for the active session, tucked behind the composer. Mission
// control owns its own feature progress, so this stays out of those sessions.
export default function PlanSteps() {
  const { state } = useStore();
  const activeSession = state.activeAppSessionId ? state.sessions[state.activeAppSessionId] : null;
  const appSessionId = activeSession?.appSessionId ?? null;
  const isMissionControl = activeSession?.sessionPurpose === 'mission-control';
  const transcripts = state.transcripts;
  const visibleTarget = visibleSessionTarget(
    activeSession?.appSessionId,
    state.selectedChild,
    state.childSessions,
    state.childAccess,
  );
  const selectedAgent = visibleTarget.kind === 'child' ? visibleTarget.childSessionId : null;
  const isLive = useSessionLive(appSessionId);

  const steps = useMemo(() => {
    if (!appSessionId || isMissionControl) return [];
    const transcript = transcripts[appSessionId] ?? [];
    return latestTodoSnapshot(scopeTranscriptToAgent(transcript, selectedAgent)).todos;
  }, [appSessionId, isMissionControl, transcripts, selectedAgent]);

  return (
    <PlanStepsPanel
      steps={steps}
      isRunning={isLive}
      resetKey={`${appSessionId ?? ''}:${selectedAgent ?? ''}`}
    />
  );
}

// One line for the step the plan is on, expandable into the whole list.
export function PlanStepsPanel({
  steps,
  isRunning,
  resetKey,
}: {
  steps: TodoItem[];
  isRunning: boolean;
  resetKey: string;
}) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    setExpanded(false);
  }, [resetKey]);

  const activeIndex = activeTodoIndex(steps);
  const current = activeIndex >= 0 ? steps[activeIndex] : undefined;
  const allDone = steps.length > 0 && steps.every((s) => s.status === 'completed');

  return (
    <AnimatePresence initial={false}>
      {current && (
        <motion.div
          key="plan-steps"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 10 }}
          transition={{ duration: 0.22, ease: EASE }}
          className="relative z-0 mx-[6%] -mb-3 min-w-0 overflow-hidden rounded-t-2xl border border-droid-border bg-droid-surface pb-4"
        >
          <button
            type="button"
            onClick={() => {
              setExpanded((v) => !v);
            }}
            aria-expanded={expanded}
            aria-controls="plan-steps-list"
            className="flex w-full min-w-0 items-center gap-2.5 px-4 py-2.5 text-left transition-colors hover:bg-droid-active/40"
          >
            <StepRing
              status={allDone ? 'completed' : current.status}
              active={!allDone}
              spinning={isRunning}
            />
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-droid-text">
              {current.text}
            </span>
            <ChevronDown
              className={`h-3.5 w-3.5 shrink-0 text-droid-text-muted transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
            />
          </button>

          <motion.div
            id="plan-steps-list"
            initial={false}
            animate={{ height: expanded ? 'auto' : 0 }}
            transition={{ duration: 0.24, ease: EASE }}
            className="overflow-hidden"
          >
            {steps.map((step, i) => (
              <div
                key={`${String(i)}-${step.text}`}
                className={`flex min-w-0 items-center gap-2.5 px-4 py-1.5 ${
                  i === activeIndex && !allDone ? 'bg-droid-active/50' : ''
                }`}
              >
                <StepRing
                  status={step.status}
                  active={i === activeIndex && !allDone}
                  spinning={isRunning}
                />
                <span
                  className={`min-w-0 flex-1 truncate text-[12px] ${stepTone(step, i === activeIndex)}`}
                >
                  {step.text}
                </span>
              </div>
            ))}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
