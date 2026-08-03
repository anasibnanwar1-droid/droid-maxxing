import { useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Settings2 } from 'lucide-react';
import { Popover } from '../environment/Popover';
import { useStudioCanvas, type StudioSettings } from './StudioCanvasContext';

/** Studio configuration — a gear in the top bar. Small, extensible list of
 *  toggles; the first is double-click-to-interact. */
export default function StudioSettingsMenu() {
  const { studio, studioDispatch } = useStudioCanvas();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const set = (key: keyof StudioSettings, value: boolean) => {
    studioDispatch({ type: 'SET_SETTING', key, value });
  };

  return (
    <>
      <button
        ref={triggerRef}
        onClick={() => {
          setOpen((value) => {
            const next = !value;
            if (next) studioDispatch({ type: 'SET_INTERACTING', id: null });
            return next;
          });
        }}
        title="Studio settings"
        aria-expanded={open}
        className="no-drag flex h-8 w-8 items-center justify-center rounded-lg text-droid-text-muted transition-colors hover:bg-droid-elevated hover:text-droid-text"
      >
        <Settings2 className="h-4 w-4" strokeWidth={1.75} />
      </button>
      <Popover
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        anchorRef={triggerRef}
        label="Studio settings"
        align="right"
        width={264}
        className="studio-popover no-drag"
      >
        <div data-studio-dismissable-layer className="p-1.5">
          <div className="px-2 pb-1.5 pt-1 text-[11.5px] font-medium text-droid-text-secondary">
            Settings
          </div>
          <Toggle
            label="Double-click to interact"
            hint="Double-click a frame to scroll and click the live app inside it."
            value={studio.settings.interactOnDoubleClick}
            onChange={(v) => {
              set('interactOnDoubleClick', v);
            }}
          />
        </div>
      </Popover>
    </>
  );
}

function Toggle({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      onClick={() => {
        onChange(!value);
      }}
      className="flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left transition-colors hover:bg-droid-active/60"
    >
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] text-droid-text">{label}</div>
        <div className="mt-0.5 text-[11px] leading-snug text-droid-text-muted">{hint}</div>
      </div>
      <span
        className={`mt-0.5 flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors ${
          value ? 'bg-droid-accent' : 'bg-droid-active'
        }`}
      >
        <motion.span
          layout
          transition={{ type: 'spring', stiffness: 500, damping: 32 }}
          className="h-4 w-4 rounded-full bg-droid-bg shadow-sm"
          style={{ marginLeft: value ? 'auto' : 0 }}
        />
      </span>
    </button>
  );
}
