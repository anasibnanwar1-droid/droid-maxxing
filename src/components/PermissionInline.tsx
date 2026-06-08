import { motion, AnimatePresence } from 'framer-motion';
import { useStore } from '../hooks/useStore';
import { respondPermission } from '../lib/commands';
import type { PermissionOutcome, PermissionKind } from '../types/bridge';

const EASE = [0.16, 1, 0.3, 1] as const;
const ACCENT = 'var(--droid-accent)';

// A plain-language explanation of what Droid is asking to do, so the prompt
// is never just a bare "Permission required".
const KIND_PROMPT: Record<PermissionKind, string> = {
  exec: 'Droid wants to run a terminal command',
  edit: 'Droid wants to edit a file',
  create: 'Droid wants to create a file',
  apply_patch: 'Droid wants to apply a code patch',
  mcp: 'Droid wants to use an MCP tool',
  spec: 'Droid wants to finish planning',
  other: 'Droid is requesting permission to proceed',
};

function cleanDetail(detail: string | undefined): string {
  const t = (detail ?? '').trim();
  if (!t || t === '{}' || t === '[]' || t === 'null' || t === 'undefined') return '';
  return t;
}

export default function PermissionInline() {
  const { state, dispatch } = useStore();
  const req = state.pendingPermission;

  // Spec plans keep the dedicated full-height review modal.
  if (!req || req.kind === 'spec') return null;

  const detail = cleanDetail(req.detail);
  // Always lead with a plain-language reason so the user knows *why* Droid is
  // asking. A meaningful backend title (e.g. "MCP tool: search") is shown as a
  // secondary label when it adds information beyond the generic reason.
  const reason = KIND_PROMPT[req.kind];
  const subtitle =
    req.title && req.title !== 'Permission required' && req.title !== reason
      ? req.title
      : '';

  const respond = (outcome: PermissionOutcome) => {
    respondPermission(req.missionId, req.requestId, outcome);
    dispatch({ type: 'CLEAR_PERMISSION' });
  };

  return (
    <AnimatePresence>
      <motion.div
        key={req.requestId}
        initial={{ opacity: 0, y: 8, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8, scale: 0.985 }}
        transition={{ duration: 0.22, ease: EASE }}
        className="mb-2.5 overflow-hidden rounded-2xl border bg-droid-elevated"
        style={{ borderColor: 'color-mix(in srgb, var(--droid-accent) 35%, var(--droid-border))' }}
      >
        <div className="flex items-start gap-2 px-3.5 pt-3 pb-2">
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-medium leading-snug text-droid-text [overflow-wrap:anywhere]">{reason}</div>
            {subtitle && (
              <div className="mt-0.5 truncate text-[11px] text-droid-text-muted">{subtitle}</div>
            )}
          </div>
          <span className="shrink-0 text-[10px] uppercase tracking-wide text-droid-text-muted/70">Permission</span>
        </div>

        {detail && (
          <div className="px-3.5 pb-2.5">
            <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap [overflow-wrap:anywhere] rounded-lg border border-droid-border bg-droid-bg/60 px-2.5 py-2 font-mono text-[11.5px] leading-[1.55] text-droid-text-secondary">
              {detail}
            </pre>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-end gap-1.5 border-t border-droid-border px-3 py-2">
          <button
            onClick={() => respond('cancel')}
            className="rounded-lg px-2.5 py-1.5 text-[12px] text-droid-text-secondary transition-colors hover:bg-droid-surface/70"
          >
            Deny
          </button>
          <button
            onClick={() => respond('proceed_always')}
            className="rounded-lg px-2.5 py-1.5 text-[12px] text-droid-text-secondary transition-colors hover:bg-droid-surface/70"
          >
            Always allow
          </button>
          <button
            onClick={() => respond('proceed_once')}
            className="rounded-lg px-3 py-1.5 text-[12px] font-medium text-droid-bg transition-opacity hover:opacity-90"
            style={{ background: ACCENT }}
          >
            Allow once
          </button>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
