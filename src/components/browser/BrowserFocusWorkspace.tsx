import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useStore } from '../../hooks/useStore';
import { useMissionLive } from '../../hooks/useMissionLive';
import type { TranscriptEvent } from '../../types/bridge';
import PromptInput from '../PromptInput';
import BrowserWorkspace from './BrowserWorkspace';

const RECENT_ACTIVITY_LIMIT = 3;

export function BrowserFocusWorkspace({
  expanded,
  externalObscured = false,
  onToggleExpanded,
}: {
  expanded: boolean;
  externalObscured?: boolean;
  onToggleExpanded: () => void;
}) {
  const { state } = useStore();
  const [activityOpen, setActivityOpen] = useState(false);
  const [promptOverlayOpen, setPromptOverlayOpen] = useState(false);
  const activeMission = state.activeMissionId ? state.missions[state.activeMissionId] : null;
  const live = useMissionLive(activeMission?.id ?? null);
  const recent = useMemo(() => {
    if (!activeMission) return [];
    const transcript = state.transcripts[activeMission.id] ?? [];
    return transcript
      .filter(
        (event) =>
          event.role === 'orchestrator' ||
          (event.author === 'user' && event.agentSessionId === 'user'),
      )
      .slice(-RECENT_ACTIVITY_LIMIT);
  }, [activeMission, state.transcripts]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-droid-bg">
      <div className="min-h-0 flex-1">
        <BrowserWorkspace
          expanded={expanded}
          externalObscured={externalObscured || promptOverlayOpen}
          onToggleExpanded={onToggleExpanded}
        />
      </div>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.section
            key="browser-focus-controls"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
            className="relative z-10 shrink-0 overflow-hidden bg-gradient-to-t from-droid-bg via-droid-bg/98 to-droid-bg/92 pt-2"
          >
            <div className="px-3">
              <div className="mx-auto max-w-4xl overflow-hidden rounded-xl border border-droid-border bg-droid-elevated/95 shadow-[0_-12px_36px_rgba(0,0,0,0.24)] backdrop-blur">
                <button
                  type="button"
                  aria-expanded={activityOpen}
                  onClick={() => {
                    setActivityOpen((open) => !open);
                  }}
                  className="flex h-9 w-full items-center gap-2 px-3 text-[11px] font-medium text-droid-text-muted transition-colors hover:bg-droid-surface/40 hover:text-droid-text"
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${live ? 'bg-emerald-400' : 'bg-droid-text-muted/40'}`}
                  />
                  <span className="flex-1 text-left">Recent activity</span>
                  <span className="text-[10px] font-normal tabular-nums text-droid-text-muted/60">
                    {live ? 'Working' : `${recent.length} recent`}
                  </span>
                  {activityOpen ? (
                    <ChevronDown className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronUp className="h-3.5 w-3.5" />
                  )}
                </button>
                <AnimatePresence initial={false}>
                  {activityOpen && (
                    <motion.div
                      key="recent-activity"
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                      className="overflow-hidden"
                    >
                      <div className="border-t border-droid-border/70 px-2 py-1">
                        {recent.length > 0 ? (
                          recent.map((event) => (
                            <div
                              key={event.id}
                              className="flex h-7 min-w-0 items-center gap-2 rounded-lg px-2 text-[11px] hover:bg-droid-surface/35"
                            >
                              <span className="w-12 shrink-0 text-[10px] font-medium text-droid-text-muted/60">
                                {activityAuthor(event)}
                              </span>
                              <span className="truncate text-droid-text-muted">
                                {activityText(event)}
                              </span>
                            </div>
                          ))
                        ) : (
                          <div className="flex h-7 items-center px-2 text-[11px] text-droid-text-muted/60">
                            Activity will appear here while Droid works.
                          </div>
                        )}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>
            <PromptInput compact onOverlayChange={setPromptOverlayOpen} />
          </motion.section>
        )}
      </AnimatePresence>
    </div>
  );
}

function activityAuthor(event: TranscriptEvent): string {
  if (event.author === 'user') return 'You';
  if (event.kind === 'thinking') return 'Thought';
  if (event.kind === 'tool_call' || event.kind === 'tool_result') return 'Tool';
  if (event.kind === 'error') return 'Error';
  return 'Droid';
}

function activityText(event: TranscriptEvent): string {
  const text = event.text?.replace(/\s+/g, ' ').trim();
  if (text) return text;
  if (event.toolName) {
    return event.kind === 'tool_result'
      ? `${event.toolName} finished`
      : `Running ${event.toolName}`;
  }
  if (event.kind === 'thinking') return 'Thinking through the next step';
  if (event.kind === 'status') return 'Session status updated';
  return 'Activity updated';
}
