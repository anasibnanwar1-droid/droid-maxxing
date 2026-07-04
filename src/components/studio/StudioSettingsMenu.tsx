import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Settings2 } from 'lucide-react';
import { useStudioCanvas, type StudioSettings } from './StudioCanvasContext';

/** Studio configuration — a gear in the top bar. Small, extensible list of
 *  toggles; the first is double-click-to-interact. */
export default function StudioSettingsMenu() {
  const { studio, studioDispatch } = useStudioCanvas();
  const [open, setOpen] = useState(false);
  const set = (key: keyof StudioSettings, value: boolean) =>
    studioDispatch({ type: 'SET_SETTING', key, value });

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title="Studio settings"
        className="no-drag flex h-7 w-7 items-center justify-center rounded-md text-white/45 transition-colors hover:bg-white/10 hover:text-white"
      >
        <Settings2 className="h-4 w-4" />
      </button>
      <AnimatePresence>
        {open && (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
            <motion.div
              initial={{ opacity: 0, y: 6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.98 }}
              transition={{ type: 'spring', damping: 24, stiffness: 340 }}
              className="no-drag absolute right-0 top-full z-40 mt-1.5 w-64 rounded-xl border border-white/10 bg-[#1a1a1a] p-1.5 shadow-2xl"
            >
              <div className="px-2 pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-white/35">
                Settings
              </div>
              <Toggle
                label="Double-click to interact"
                hint="Double-click a frame to scroll and click the live app inside it."
                value={studio.settings.interactOnDoubleClick}
                onChange={(v) => set('interactOnDoubleClick', v)}
              />
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
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
      onClick={() => onChange(!value)}
      className="flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left transition-colors hover:bg-white/[0.04]"
    >
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] text-white/85">{label}</div>
        <div className="mt-0.5 text-[11px] leading-snug text-white/40">{hint}</div>
      </div>
      <span
        className="mt-0.5 flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors"
        style={{ backgroundColor: value ? '#ee6018' : 'rgba(255,255,255,0.12)' }}
      >
        <motion.span
          layout
          transition={{ type: 'spring', stiffness: 500, damping: 32 }}
          className="h-4 w-4 rounded-full bg-white shadow"
          style={{ marginLeft: value ? 'auto' : 0 }}
        />
      </span>
    </button>
  );
}
