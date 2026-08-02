import { ArrowLeft, Check, Loader2, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';

// Shared furniture for the first-run wizard, built entirely from the app's own
// design system: droid-* theme tokens and the droid-button/droid-input classes
// in index.css. Nothing here invents a palette, so the tour matches the active
// theme exactly like every other screen.

export const EASE: [number, number, number, number] = [0.16, 1, 0.3, 1];

/** Quiet section label, matching the settings group headers. */
export function StepLabel({ children }: { children: ReactNode }) {
  return (
    <div className="text-[11px] font-medium text-droid-text-muted uppercase tracking-wider mb-2">
      {children}
    </div>
  );
}

export function StepTitle({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="mb-6">
      <h2 className="text-[18px] font-semibold tracking-tight text-droid-text">{title}</h2>
      {sub && <p className="mt-2 text-[13px] leading-relaxed text-droid-text-secondary">{sub}</p>}
    </div>
  );
}

/** Bordered surface for grouped rows (settings-panel style). */
export function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-xl border border-droid-border bg-droid-surface divide-y divide-droid-border overflow-hidden ${className}`}
    >
      {children}
    </div>
  );
}

interface BtnProps {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  autoFocus?: boolean;
}

const btnLayout =
  'w-full h-10 flex items-center justify-center gap-2 text-[13px] disabled:opacity-40 disabled:pointer-events-none';

export function PrimaryButton({ children, onClick, disabled, autoFocus }: BtnProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      autoFocus={autoFocus}
      className={`droid-button-primary ${btnLayout}`}
    >
      {children}
    </button>
  );
}

export function GhostButton({ children, onClick, disabled, autoFocus }: BtnProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      autoFocus={autoFocus}
      className={`droid-button ${btnLayout}`}
    >
      {children}
    </button>
  );
}

export function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="px-3 h-10 inline-flex items-center gap-1.5 text-[12.5px] text-droid-text-muted hover:text-droid-text transition-colors shrink-0"
    >
      <ArrowLeft className="w-3.5 h-3.5" /> Back
    </button>
  );
}

export function RescanButton({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className={`droid-button ${btnLayout}`}>
      <RefreshCw className="w-4 h-4" /> Re-scan
    </button>
  );
}

export function StatusDot({ status }: { status: 'pending' | 'ok' | 'missing' }) {
  return (
    <span className="w-5 h-5 flex items-center justify-center shrink-0">
      {status === 'pending' && (
        <Loader2 className="w-3.5 h-3.5 animate-spin text-droid-text-muted" />
      )}
      {status === 'ok' && <Check className="w-4 h-4 text-droid-green" strokeWidth={3} />}
      {status === 'missing' && <span className="w-1.5 h-1.5 rounded-full bg-droid-text-muted" />}
    </span>
  );
}

/** Row with the same switch control the settings panel uses. */
export function ToggleRow({
  label,
  sub,
  checked,
  onChange,
}: {
  label: string;
  sub?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between px-4 py-3.5">
      <div className="pr-4">
        <div className="text-[13.5px] text-droid-text">{label}</div>
        {sub && <div className="text-[11.5px] text-droid-text-muted mt-0.5">{sub}</div>}
      </div>
      <button
        onClick={() => {
          onChange(!checked);
        }}
        className={`w-10 h-6 rounded-full transition-colors shrink-0 flex items-center p-0.5 ${checked ? 'bg-droid-accent' : 'bg-droid-border'}`}
      >
        <span
          className={`w-5 h-5 rounded-full shadow-sm transition-transform ${checked ? 'bg-droid-bg translate-x-4' : 'bg-droid-text-secondary translate-x-0'}`}
        />
      </button>
    </div>
  );
}
