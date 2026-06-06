import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ClipboardCheck, X, Check, XCircle } from 'lucide-react';
import { useStore } from '../hooks/useStore';
import { respondPermission, setMissionAutonomy } from '../lib/commands';
import { Markdown } from './Markdown';
import type { PermissionOutcome, Autonomy } from '../types/bridge';

const EASE = [0.16, 1, 0.3, 1] as const;
const ACCENT = 'var(--droid-accent)';

const AUTONOMY_OPTIONS: { value: Autonomy; label: string; hint: string }[] = [
  { value: 'low', label: 'Low', hint: 'Ask before every action' },
  { value: 'medium', label: 'Medium', hint: 'Ask for risky actions' },
  { value: 'high', label: 'High', hint: 'Run autonomously' },
];

export default function PermissionModal() {
  const { state, dispatch } = useStore();
  const req = state.pendingPermission;
  const [autonomy, setAutonomy] = useState<Autonomy>('medium');
  // Only spec plans use this full-height review modal; all other permission
  // prompts render inline above the chat box via <PermissionInline />.
  if (!req || req.kind !== 'spec') return null;

  const respond = (outcome: PermissionOutcome) => {
    respondPermission(req.missionId, req.requestId, outcome);
    dispatch({ type: 'CLEAR_PERMISSION' });
  };

  // Approving a spec means: exit spec mode, set the chosen autonomy, and start
  // implementing. Optimistically flip the session to a normal chat so the spec
  // toggle turns off the moment coding begins.
  const approveAndBuild = () => {
    setMissionAutonomy(req.missionId, autonomy);
    dispatch({ type: 'MISSION_SET_KIND', missionId: req.missionId, kind: 'chat' });
    respond('proceed_once');
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18 }}
        className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 sm:p-6"
        onClick={() => respond('cancel')}
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.96, y: 12 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96, y: 12 }}
          transition={{ duration: 0.28, ease: EASE }}
          onClick={(e) => e.stopPropagation()}
          className="w-full max-w-[760px] h-[85vh] flex flex-col rounded-2xl border border-droid-border bg-droid-surface shadow-2xl shadow-black/60 overflow-hidden"
        >
          {/* Header */}
          <div className="shrink-0 flex items-center justify-between px-5 h-12 border-b border-droid-border/50">
            <div className="flex items-center gap-2.5 min-w-0">
              <ClipboardCheck className="w-4 h-4 shrink-0" style={{ color: ACCENT }} />
              <span className="text-[13px] font-medium text-droid-text truncate">{req.title || 'Review specification'}</span>
            </div>
            <button
              onClick={() => respond('cancel')}
              title="Dismiss"
              className="p-1.5 rounded-md text-droid-text-muted hover:text-droid-text hover:bg-droid-elevated transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto px-5 py-4 min-h-0">
            <div className="max-w-3xl mx-auto">
              <Markdown specMode>{req.plan || req.detail || '*No plan content.*'}</Markdown>
            </div>
          </div>

          {/* Autonomy picker — how much freedom the model gets while implementing */}
          <div className="shrink-0 px-5 pt-3 pb-2 border-t border-droid-border/50">
            <div className="text-[11px] font-medium uppercase tracking-wide text-droid-text-muted mb-2">
              Implementation autonomy
            </div>
            <div className="grid grid-cols-3 gap-2">
              {AUTONOMY_OPTIONS.map((opt) => {
                const active = autonomy === opt.value;
                return (
                  <button
                    key={opt.value}
                    onClick={() => setAutonomy(opt.value)}
                    className={`flex flex-col items-start rounded-lg border px-3 py-2 text-left transition-colors ${
                      active
                        ? 'border-transparent bg-droid-elevated'
                        : 'border-droid-border hover:bg-droid-elevated/50'
                    }`}
                    style={active ? { boxShadow: `inset 0 0 0 1px ${ACCENT}` } : undefined}
                  >
                    <span className="text-[12.5px] font-medium text-droid-text">{opt.label}</span>
                    <span className="text-[11px] text-droid-text-muted">{opt.hint}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Footer */}
          <div className="shrink-0 flex items-center justify-end gap-2 px-5 h-14 border-t border-droid-border/50">
            <button
              onClick={() => respond('cancel')}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12.5px] text-droid-text-secondary hover:bg-droid-elevated/60 transition-colors"
            >
              <XCircle className="w-3.5 h-3.5" />
              <span>Keep planning</span>
            </button>
            <button
              onClick={approveAndBuild}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12.5px] font-medium text-droid-bg transition-opacity hover:opacity-90"
              style={{ background: ACCENT }}
            >
              <Check className="w-3.5 h-3.5" />
              <span>Approve &amp; build</span>
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
