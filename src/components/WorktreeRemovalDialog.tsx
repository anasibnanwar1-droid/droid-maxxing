import { motion } from 'framer-motion';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { worktreeName } from '../lib/git';
import type { GitWorktree } from '../types/vcs';

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface WorktreeRemovalDialogProps {
  worktree: GitWorktree;
  changedFileCount: number | null;
  linkedSessionCount: number;
  isMerged: boolean;
  isChecking: boolean;
  isRemoving: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

function removalTitle(isChecking: boolean, hasUnsavedChanges: boolean): string {
  if (isChecking || !hasUnsavedChanges) return 'Delete this worktree?';
  return 'Delete worktree and discard changes?';
}

function removalActionLabel(isChecking: boolean, hasUnsavedChanges: boolean): string {
  if (isChecking) return 'Checking…';
  if (hasUnsavedChanges) return 'Delete anyway';
  return 'Delete worktree';
}

function RemovalStatus({
  changedFileCount,
  isChecking,
}: {
  changedFileCount: number | null;
  isChecking: boolean;
}) {
  if (isChecking) {
    return (
      <div className="flex items-center gap-2.5 text-[12px] text-droid-text-secondary">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-droid-text-muted" />
        Checking for unsaved changes…
      </div>
    );
  }
  if (changedFileCount && changedFileCount > 0) {
    return (
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
        <div>
          <p className="text-[12.5px] font-medium text-red-300">
            {String(changedFileCount)} changed {changedFileCount === 1 ? 'file will' : 'files will'}{' '}
            be permanently discarded.
          </p>
          <p className="mt-1 text-[11.5px] leading-5 text-droid-text-secondary">
            This includes modified and untracked files. This action cannot be undone.
          </p>
        </div>
      </div>
    );
  }
  return (
    <p className="text-[12px] leading-5 text-droid-text-secondary">
      The worktree directory will be removed from this Mac.
    </p>
  );
}

export function WorktreeRemovalDialog(props: WorktreeRemovalDialogProps) {
  return createPortal(<WorktreeRemovalDialogContent {...props} />, document.body);
}

export function WorktreeRemovalDialogContent({
  worktree,
  changedFileCount,
  linkedSessionCount,
  isMerged,
  isChecking,
  isRemoving,
  onCancel,
  onConfirm,
}: WorktreeRemovalDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const hasUnsavedChanges = (changedFileCount ?? 0) > 0;

  useEffect(() => {
    const opener = document.activeElement;
    cancelRef.current?.focus();
    return () => {
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, []);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isRemoving) onCancel();
    };
    window.addEventListener('keydown', handleEscape);
    return () => {
      window.removeEventListener('keydown', handleEscape);
    };
  }, [isRemoving, onCancel]);

  const trapTab = (event: ReactKeyboardEvent) => {
    if (event.key !== 'Tab') return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusables = dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === dialog || !dialog.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (
      !event.shiftKey &&
      (active === last || active === dialog || !dialog.contains(active))
    ) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.12 }}
      className="fixed inset-0 z-[1250] flex items-center justify-center bg-black/65 p-5 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !isRemoving) onCancel();
      }}
    >
      <motion.div
        ref={dialogRef}
        role={hasUnsavedChanges ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-labelledby="worktree-removal-title"
        aria-describedby="worktree-removal-description"
        aria-busy={isChecking || isRemoving}
        tabIndex={-1}
        onKeyDown={trapTab}
        initial={{ y: 10, scale: 0.985, opacity: 0 }}
        animate={{ y: 0, scale: 1, opacity: 1 }}
        exit={{ y: 6, scale: 0.99, opacity: 0 }}
        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
        className="w-full max-w-[440px] overflow-hidden rounded-2xl border border-droid-border bg-droid-surface shadow-[0_28px_90px_rgba(0,0,0,0.58)]"
      >
        <div className="px-6 pb-5 pt-6">
          <h2
            id="worktree-removal-title"
            className="text-[17px] font-semibold tracking-[-0.015em] text-droid-text"
          >
            {removalTitle(isChecking, hasUnsavedChanges)}
          </h2>
          <p className="mt-1 text-[13px] font-medium text-droid-text-secondary">
            {worktreeName(worktree)}
          </p>
          <p
            className="mt-0.5 truncate text-[11px] text-droid-text-muted"
            title={worktree.path ?? undefined}
          >
            {worktree.path}
          </p>

          <div
            id="worktree-removal-description"
            className={`mt-5 rounded-xl border p-4 ${
              hasUnsavedChanges
                ? 'border-red-500/25 bg-red-500/[0.07]'
                : 'border-droid-border bg-droid-bg/45'
            }`}
          >
            <RemovalStatus changedFileCount={changedFileCount} isChecking={isChecking} />
          </div>

          <ul className="mt-4 space-y-2 text-[11.5px] leading-5 text-droid-text-muted">
            {linkedSessionCount > 0 && (
              <li>
                {String(linkedSessionCount)} idle{' '}
                {linkedSessionCount === 1 ? 'conversation' : 'conversations'} will move to the main
                checkout.
              </li>
            )}
            <li>
              {isMerged
                ? 'Git will also delete the merged local branch.'
                : 'The local branch will stay unless Git confirms it is merged.'}
            </li>
          </ul>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-droid-border bg-droid-bg/30 px-6 py-4">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={isRemoving}
            className="rounded-lg px-3.5 py-2 text-[12px] font-medium text-droid-text-secondary transition-all duration-150 hover:bg-droid-elevated/70 hover:text-droid-text active:scale-[0.97] disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isChecking || isRemoving}
            className="flex min-w-[118px] items-center justify-center gap-2 rounded-lg bg-red-500/15 px-3.5 py-2 text-[12px] font-semibold text-red-300 transition-all duration-150 hover:bg-red-500/25 active:scale-[0.97] disabled:opacity-50"
          >
            {(isChecking || isRemoving) && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {removalActionLabel(isChecking, hasUnsavedChanges)}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
