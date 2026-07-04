import { useState } from 'react';
import { motion } from 'framer-motion';
import { Laptop, Monitor, Ruler, Smartphone, Tablet } from 'lucide-react';
import type { BrowserViewportMode } from '../../types/bridge';
import { normalizeUrl } from '../browser/browserViewport';
import { useStudioCanvas } from './StudioCanvasContext';

const VIEWPORTS: { mode: BrowserViewportMode; icon: typeof Monitor; label: string }[] = [
  { mode: 'desktop', icon: Monitor, label: 'Desktop' },
  { mode: 'laptop', icon: Laptop, label: 'Laptop' },
  { mode: 'tablet', icon: Tablet, label: 'Tablet' },
  { mode: 'mobile', icon: Smartphone, label: 'Mobile' },
  { mode: 'custom', icon: Ruler, label: 'Custom' },
];

const QUICK_PORTS = ['localhost:5173', 'localhost:3000', 'localhost:8080'];

/** Minimal, focused dialog for pointing a new frame at a running route. */
export default function AddFrameDialog({ onClose }: { onClose: () => void }) {
  const { studio, studioDispatch } = useStudioCanvas();
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [mode, setMode] = useState<BrowserViewportMode>(studio.defaultMode);
  const [w, setW] = useState(1024);
  const [h, setH] = useState(720);

  const submit = () => {
    const normalized = normalizeUrl(url || QUICK_PORTS[0]);
    const custom = mode === 'custom';
    studioDispatch({
      type: 'ADD_FRAME',
      frame: {
        name: name.trim() || deriveName(normalized),
        url: normalized,
        mode,
        kind: 'route',
        width: custom ? clampSize(w) : undefined,
        height: custom ? clampSize(h) : undefined,
      },
    });
    onClose();
  };

  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-black/40 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.97, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
        onClick={(e) => { e.stopPropagation(); }}
        className="w-[420px] overflow-hidden rounded-2xl border border-white/10 bg-[#141414] shadow-2xl"
      >
        <div className="px-5 pb-1 pt-5">
          <h2 className="text-[15px] font-medium tracking-tight text-white/90">Add a live frame</h2>
          <p className="mt-1 text-[12px] text-white/45">
            Point it at a route on your running dev server. It renders live and hot-reloads.
          </p>
        </div>

        <div className="space-y-4 px-5 py-4">
          <div>
            <Label>URL</Label>
            <input
              autoFocus
              value={url}
              onChange={(e) => { setUrl(e.target.value); }}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              placeholder="localhost:5173/dashboard"
              className="w-full rounded-lg border border-white/10 bg-[#0d0d0d] px-3 py-2 font-mono text-[12.5px] text-white/90 placeholder:text-white/25 focus:border-[#ee6018]/50 focus:outline-none"
            />
            <div className="mt-2 flex gap-1.5">
              {QUICK_PORTS.map((p) => (
                <button
                  key={p}
                  onClick={() => { setUrl(p); }}
                  className="rounded-md border border-white/[0.08] px-2 py-1 font-mono text-[10.5px] text-white/45 transition-colors hover:border-white/20 hover:text-white/75"
                >
                  {p}
                </button>
              ))}
            </div>
          </div>

          <div>
            <Label>Name (optional)</Label>
            <input
              value={name}
              onChange={(e) => { setName(e.target.value); }}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              placeholder="Dashboard"
              className="w-full rounded-lg border border-white/10 bg-[#0d0d0d] px-3 py-2 text-[12.5px] text-white/90 placeholder:text-white/25 focus:border-[#ee6018]/50 focus:outline-none"
            />
          </div>

          <div>
            <Label>Viewport</Label>
            <div className="flex gap-1.5">
              {VIEWPORTS.map((v) => (
                <button
                  key={v.mode}
                  onClick={() => { setMode(v.mode); }}
                  className={`flex flex-1 flex-col items-center gap-1 rounded-lg border py-2 text-[11px] transition-colors ${
                    mode === v.mode
                      ? 'border-[#ee6018]/50 bg-[#ee6018]/10 text-white'
                      : 'border-white/[0.08] text-white/45 hover:border-white/15 hover:text-white/75'
                  }`}
                >
                  <v.icon className="h-4 w-4" />
                  {v.label}
                </button>
              ))}
            </div>
            {mode === 'custom' && (
              <div className="mt-2 flex items-center gap-2">
                <SizeInput label="W" value={w} onChange={setW} />
                <span className="text-white/30">×</span>
                <SizeInput label="H" value={h} onChange={setH} />
                <span className="font-mono text-[10.5px] text-white/30">px</span>
              </div>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-white/[0.06] px-5 py-3">
          <button
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-[12.5px] text-white/55 transition-colors hover:text-white/85"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            className="rounded-lg bg-[#ee6018] px-3.5 py-1.5 text-[12.5px] font-medium text-black transition-colors hover:bg-[#ff6a1e]"
          >
            Add frame
          </button>
        </div>
      </motion.div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="pb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-white/40">
      {children}
    </div>
  );
}

function SizeInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="flex flex-1 items-center gap-1.5 rounded-lg border border-white/10 bg-[#0d0d0d] px-2.5 py-1.5 focus-within:border-[#ee6018]/50">
      <span className="font-mono text-[10.5px] text-white/35">{label}</span>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full bg-transparent font-mono text-[12.5px] text-white/90 focus:outline-none"
      />
    </div>
  );
}

function clampSize(n: number): number {
  if (!Number.isFinite(n)) return 400;
  return Math.min(4096, Math.max(200, Math.round(n)));
}

function deriveName(url: string): string {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean).pop();
    if (seg) return seg.charAt(0).toUpperCase() + seg.slice(1);
    return u.host.replace(/^www\./, '');
  } catch {
    return 'Frame';
  }
}
