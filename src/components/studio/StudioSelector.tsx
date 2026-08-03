import { useRef } from 'react';
import { ChevronDown } from 'lucide-react';
import { Popover } from '../environment/Popover';

export default function StudioSelector({
  open,
  setOpen,
  value,
  onPick,
  options,
  width = 128,
  icon,
  hint,
}: {
  open: boolean;
  setOpen: (value: boolean) => void;
  value: string;
  onPick: (value: string) => void;
  options: string[];
  width?: number;
  icon?: React.ReactNode;
  hint?: string;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <div className="shrink-0">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
        }}
        className="flex items-center gap-1.5 rounded-lg border border-droid-border bg-droid-surface px-2 py-1.5 text-[11.5px] text-droid-text-secondary transition-colors hover:border-droid-border-hover hover:text-droid-text"
      >
        {icon}
        {value}
        <ChevronDown className="h-3 w-3 opacity-60" />
      </button>
      <Popover
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        anchorRef={triggerRef}
        label={hint ?? 'Select an option'}
        align="left"
        width={width}
        className="studio-popover"
      >
        <div data-studio-dismissable-layer className="p-1">
          {hint && (
            <div className="mb-1 border-b border-droid-border px-2 pb-1.5 pt-0.5 text-[10.5px] text-droid-text-muted">
              {hint}
            </div>
          )}
          {options.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => {
                onPick(option);
                setOpen(false);
              }}
              className={`flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-[12px] transition-colors ${
                option === value
                  ? 'bg-droid-accent/10 text-droid-accent'
                  : 'text-droid-text-secondary hover:bg-droid-active/70'
              }`}
            >
              {option}
            </button>
          ))}
        </div>
      </Popover>
    </div>
  );
}
