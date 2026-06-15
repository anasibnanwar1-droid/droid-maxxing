import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { FileText, ChevronRight } from 'lucide-react';
import { useStore } from '../hooks/useStore';
import { respondPermission, sendToMission, sendToMissionNow } from '../lib/commands';
import type { Autonomy, PermissionOutcome } from '../types/bridge';

const EASE = [0.16, 1, 0.3, 1] as const;
const ACCENT = 'var(--droid-accent)';

const AUTONOMY: { value: Autonomy; label: string; outcome: PermissionOutcome }[] = [
  { value: 'low', label: 'Low', outcome: 'proceed_auto_run_low' },
  { value: 'medium', label: 'Medium', outcome: 'proceed_auto_run_medium' },
  { value: 'high', label: 'High', outcome: 'proceed_auto_run_high' },
];

// Bottom approval bar shown when a spec (exit_spec_mode) or mission plan
// (propose_mission) is ready. Replaces the old full-screen popover: the plan
// itself lives in the inline chat card / wiki reader, this only drives the
// decision (implement vs keep iterating) plus an optional steered comment.
export default function PlanApprovalInline() {
  const { state, dispatch } = useStore();
  const req = state.pendingPermission;
  const [autonomy, setAutonomy] = useState<Autonomy>('high');
  const [comment, setComment] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const requestId = req?.requestId;
  useEffect(() => {
    setComment('');
  }, [requestId]);

  if (!req || (req.kind !== 'spec' && req.kind !== 'mission_plan')) return null;

  const isSpec = req.kind === 'spec';
  const text = comment.trim();

  const finish = () => dispatch({ type: 'CLEAR_PERMISSION' });

  // Implement: approve at the chosen autonomy (spec) or proceed once (mission),
  // then steer the comment into the turn the model is about to start.
  const implement = () => {
    const outcome: PermissionOutcome = isSpec
      ? AUTONOMY.find((a) => a.value === autonomy)!.outcome
      : 'proceed_once';
    respondPermission(req.missionId, req.requestId, outcome);
    if (isSpec) dispatch({ type: 'MISSION_SET_KIND', missionId: req.missionId, kind: 'chat' });
    if (text) sendToMissionNow(req.missionId, text);
    finish();
  };

  // Keep iterating: reject the plan and (optionally) hand the comment back as a
  // normal message so planning continues with the feedback.
  const iterate = () => {
    respondPermission(req.missionId, req.requestId, 'cancel');
    if (text) sendToMission(req.missionId, text);
    finish();
  };

  const openWiki = () => dispatch({ type: 'SPEC_OPEN_WIKI', missionId: req.missionId });

  return (
    <AnimatePresence>
      <motion.div
        key={req.requestId}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 8 }}
        transition={{ duration: 0.22, ease: EASE }}
        className="mb-2.5 overflow-hidden rounded-2xl border bg-droid-elevated"
        style={{ borderColor: 'color-mix(in srgb, var(--droid-accent) 35%, var(--droid-border))' }}
      >
        <div className="flex items-center gap-2 px-3.5 pt-3 pb-2">
          <FileText className="w-4 h-4 shrink-0" style={{ color: ACCENT }} />
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-droid-text">
            {isSpec ? 'Specification ready' : 'Mission plan proposed'}
          </span>
          <button
            onClick={openWiki}
            className="shrink-0 flex items-center gap-1 rounded-lg border border-droid-border px-2.5 py-1 text-[11px] text-droid-text-secondary transition-colors hover:bg-droid-surface/70 hover:text-droid-text"
          >
            {isSpec ? 'Read spec' : 'Read plan'}
            <ChevronRight className="h-3 w-3" />
          </button>
        </div>

        <div className="px-3.5 pb-2.5">
          <textarea
            ref={inputRef}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            onKeyDown={(e) => {
              // During IME composition Enter confirms the composed text;
              // only trigger implement once composition has ended.
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                implement();
              }
            }}
            rows={1}
            placeholder={
              isSpec
                ? 'Add a comment to guide implementation (optional)…'
                : 'Add a comment (optional)…'
            }
            className="w-full resize-none rounded-lg border border-droid-border bg-droid-bg/60 px-2.5 py-2 text-[12.5px] leading-snug text-droid-text placeholder:text-droid-text-muted/60 outline-none focus:border-droid-border-hover"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-droid-border px-3 py-2">
          {isSpec && (
            <div className="flex items-center gap-1 rounded-lg border border-droid-border p-0.5">
              {AUTONOMY.map((a) => {
                const active = autonomy === a.value;
                return (
                  <button
                    key={a.value}
                    onClick={() => setAutonomy(a.value)}
                    title={`Implement with ${a.label.toLowerCase()} autonomy`}
                    className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                      active ? 'text-droid-bg' : 'text-droid-text-secondary hover:text-droid-text'
                    }`}
                    style={active ? { background: ACCENT } : undefined}
                  >
                    {a.label}
                  </button>
                );
              })}
            </div>
          )}
          <div className="flex-1" />
          <button
            onClick={iterate}
            className="rounded-lg px-2.5 py-1.5 text-[12px] text-droid-text-secondary transition-colors hover:bg-droid-surface/70"
          >
            Keep iterating
          </button>
          <button
            onClick={implement}
            className="rounded-lg px-3 py-1.5 text-[12px] font-medium text-droid-bg transition-opacity hover:opacity-90"
            style={{ background: ACCENT }}
          >
            {text ? 'Implement with comment' : 'Implement'}
          </button>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
