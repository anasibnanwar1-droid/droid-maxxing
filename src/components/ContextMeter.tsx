import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import { useStore } from '../hooks/useStore';
import type { ContextStatsSnapshot, MissionSummary } from '../types/bridge';

const EASE = [0.16, 1, 0.3, 1] as const;

const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}K` : `${n}`);

function Ring({ pct, size = 16 }: { pct: number; size?: number }) {
  const stroke = 2.5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(pct, 1));
  const hot = clamped > 0.85;
  return (
    <svg width={size} height={size} className="-rotate-90 shrink-0">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--droid-border-hover)" strokeWidth={stroke} />
      <motion.circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={hot ? 'var(--droid-orange)' : 'var(--droid-accent)'}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={c}
        animate={{ strokeDashoffset: c * (1 - clamped) }}
        transition={{ duration: 0.5, ease: EASE }}
      />
    </svg>
  );
}

function Row({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <div className="flex items-center justify-between">
      <span className="flex items-center gap-2">
        <span className="h-2 w-2 rounded-sm" style={{ background: color }} />
        <span className="text-[12px] text-droid-text-secondary">{label}</span>
      </span>
      <span className="font-mono text-[12px] text-droid-text">{value.toLocaleString()}</span>
    </div>
  );
}

const CATEGORY_COLORS: Record<string, string> = {
  system: 'var(--droid-orange)',
  systemPrompt: 'var(--droid-orange)',
  systemTools: 'var(--droid-accent)',
  tools: 'var(--droid-accent)',
  skills: 'var(--droid-green)',
  agentsMd: 'var(--droid-green)',
  customAgents: 'var(--droid-green)',
  userInfo: 'var(--droid-text-muted)',
  mcp: 'var(--droid-accent)',
  messages: 'var(--droid-text-muted)',
};

function categoryColor(key?: string): string {
  if (!key) return 'var(--droid-text-muted)';
  return CATEGORY_COLORS[key] ?? 'var(--droid-text-muted)';
}

export default function ContextMeter({ mission, stats }: { mission: MissionSummary; stats?: ContextStatsSnapshot }) {
  const { state } = useStore();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ right: number; bottom: number }>({ right: 0, bottom: 0 });

  const measured = stats ?? (mission.contextUpdatedAt
    ? {
        used: mission.contextTokens,
        remaining: mission.contextRemainingTokens ?? 0,
        limit: mission.maxContextTokens ?? 0,
        accuracy: mission.contextAccuracy ?? 'estimated',
        updatedAt: mission.contextUpdatedAt,
      }
    : undefined);
  const modelWindow = mission.maxContextTokens && mission.maxContextTokens > 0 ? mission.maxContextTokens : undefined;
  const statLimit = measured?.limit && measured.limit > 0 ? measured.limit : modelWindow;

  // The conversation compacts once it passes the configured token limit, so the
  // meter measures usage against that threshold (per-model override → global
  // default), capped to the model window. Falls back to the model window when
  // no compaction limit is set.
  const compactionLimit =
    mission.modelId && state.compactionTokenLimitPerModel[mission.modelId] !== undefined
      ? state.compactionTokenLimitPerModel[mission.modelId]
      : state.compactionTokenLimit;
  const effectiveCompaction =
    compactionLimit && compactionLimit > 0
      ? modelWindow
        ? Math.min(compactionLimit, modelWindow)
        : compactionLimit
      : undefined;
  const max = effectiveCompaction ?? statLimit;

  const used = measured?.used;
  const remaining = used !== undefined && max !== undefined ? Math.max(0, max - used) : measured?.remaining;
  const accuracy = measured?.accuracy;
  const categories = measured?.breakdown?.categories ?? [];
  const ready = used !== undefined && max !== undefined && max > 0;
  const pct = ready ? used / max : 0;
  const pctLabel = ready ? Math.min(100, Math.round(pct * 100)) : 0;

  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({ right: window.innerWidth - r.right, bottom: window.innerHeight - r.top + 8 });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [open]);

  return (
    <div ref={ref} className="relative flex items-center">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-md px-1.5 py-0.5 transition-colors hover:bg-droid-elevated/60"
        title="Context usage"
      >
        <span className="font-mono text-[11px] text-droid-text-secondary">
          {ready ? `${fmt(used)} / ${fmt(max)}` : 'Context ...'}
        </span>
        <Ring pct={pct} />
      </button>

      {createPortal(
        <AnimatePresence>
          {open && (
            <motion.div
              ref={panelRef}
              initial={{ opacity: 0, y: 6, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.97 }}
              transition={{ duration: 0.18, ease: EASE }}
              style={{ position: 'fixed', right: pos.right, bottom: pos.bottom }}
              className="w-72 origin-bottom-right rounded-xl border border-droid-border bg-droid-elevated p-4 shadow-2xl shadow-black/50 z-[100]"
            >
            <div className="mb-3 flex items-center justify-between">
              <span className="text-[13px] font-medium text-droid-text">Context</span>
              <button onClick={() => setOpen(false)} className="text-droid-text-muted transition-colors hover:text-droid-text">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>

            {ready ? (
              <>
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[11px] text-droid-text-secondary">{pctLabel}% full</span>
                  <span className="font-mono text-[11px] text-droid-text-secondary">
                    {fmt(used)} / {fmt(max)} tokens
                  </span>
                </div>

                <div className="h-1.5 w-full overflow-hidden rounded-full bg-droid-border-hover">
                  <motion.div
                    className="h-full rounded-full"
                    style={{ background: pct > 0.85 ? 'var(--droid-orange)' : 'var(--droid-accent)' }}
                    animate={{ width: `${Math.min(100, pct * 100)}%` }}
                    transition={{ duration: 0.5, ease: EASE }}
                  />
                </div>
              </>
            ) : (
              <div className="rounded-lg border border-droid-border/50 bg-droid-bg/40 px-3 py-2 text-[12px] text-droid-text-muted">
                Waiting for Droid context stats
              </div>
            )}

            <div className="mt-4 flex flex-col gap-2.5">
              {ready && <Row color="var(--droid-accent)" label="Window used" value={used} />}
              {remaining !== undefined && <Row color="var(--droid-text-muted)" label="Window free" value={remaining} />}
              {effectiveCompaction !== undefined && <Row color="var(--droid-orange)" label="Compacts at" value={effectiveCompaction} />}
              {modelWindow !== undefined && <Row color="var(--droid-text-muted)" label="Model window" value={modelWindow} />}
              <Row color="var(--droid-text-muted)" label="Session input" value={mission.tokensIn} />
              <Row color="var(--droid-green)" label="Session output" value={mission.tokensOut} />
            </div>

            {categories.length > 0 && (
              <div className="mt-3 border-t border-droid-border/40 pt-3">
                <div className="mb-2 text-[10px] uppercase tracking-wide text-droid-text-muted">Breakdown</div>
                <div className="flex flex-col gap-2">
                  {categories.slice(0, 8).map((cat) => (
                    <Row key={cat.name} color={categoryColor(cat.colorKey)} label={cat.name} value={cat.tokens} />
                  ))}
                </div>
              </div>
            )}

            {accuracy && (
              <div className="mt-3 border-t border-droid-border/40 pt-2 text-[10px] capitalize text-droid-text-muted">
                {accuracy} context stats
              </div>
            )}
          </motion.div>
        )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );
}
