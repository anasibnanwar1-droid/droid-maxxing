import { AlertTriangle, ArrowUpCircle, X } from 'lucide-react';

export type SetupBannerKind = 'blocker' | 'update';

export default function SetupBanner({
  kind,
  message,
  actionLabel,
  onAction,
  onDismiss,
}: {
  kind: SetupBannerKind;
  message: string;
  actionLabel: string;
  onAction: () => void;
  onDismiss?: () => void;
}) {
  const Icon = kind === 'blocker' ? AlertTriangle : ArrowUpCircle;
  const accent = kind === 'blocker' ? 'text-droid-orange' : 'text-droid-accent';
  return (
    <div className="shrink-0 flex items-center gap-2 px-4 h-9 border-b border-droid-border bg-droid-elevated/60 text-[12px]">
      <Icon className={`w-3.5 h-3.5 ${accent}`} />
      <span className="text-droid-text">{message}</span>
      <button
        onClick={onAction}
        className="ml-1 px-2 py-0.5 rounded-md bg-droid-accent text-white text-[11px] font-medium hover:opacity-90 transition-opacity"
      >
        {actionLabel}
      </button>
      <div className="flex-1" />
      {onDismiss && (
        <button onClick={onDismiss} className="text-droid-text-muted hover:text-droid-text transition-colors">
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}
