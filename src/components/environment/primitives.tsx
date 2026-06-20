// Shared Context-panel primitives used by RightPanel and the environment/VCS
// components so the rows, headers, and dividers stay visually identical.
import type { ReactNode } from 'react';

export function SectionHeader({ label, trailing }: { label: string; trailing?: ReactNode }) {
  return (
    <div className="flex items-center justify-between px-3 pt-4 pb-1.5">
      <span className="text-[12.5px] font-medium text-droid-text-muted">{label}</span>
      {trailing}
    </div>
  );
}

export function Divider() {
  return <div className="mx-3 my-1.5 h-px bg-droid-border/70" />;
}

export function Row({
  icon,
  label,
  meta,
  onClick,
  active,
  trailing,
  title,
}: {
  icon: ReactNode;
  label: string;
  meta?: string;
  onClick?: () => void;
  active?: boolean;
  trailing?: ReactNode;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`group flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors ${
        active ? 'bg-droid-elevated' : 'hover:bg-droid-elevated/50'
      }`}
    >
      <span className="shrink-0 text-droid-text-muted transition-colors group-hover:text-droid-text-secondary">
        {icon}
      </span>
      <span className="min-w-0 flex-1 text-[13px] leading-snug text-droid-text">{label}</span>
      {meta && <span className="shrink-0 font-mono text-[11px] text-droid-text-muted">{meta}</span>}
      {trailing}
    </button>
  );
}
