import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import { useStore } from '../hooks/useStore';
import { compactsAtMarker, orchestratorDefaultModelId } from '../lib/contextMeter';
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
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="var(--droid-border-hover)"
        strokeWidth={stroke}
      />
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

// Stabilize the displayed context usage so the meter doesn't flicker as the
// backend interleaves estimated (per-token) and exact (per-turn) readings.
// Exact readings are authoritative and snap; estimates only ratchet UP within a
// compaction generation, so transient estimate noise never jerks the bar
// backward mid-stream. A new session or a compaction (generation bump) resets
// the floor, since compaction legitimately drops the token count.
function useStableUsed(
  key: string,
  raw: number | undefined,
  isExact: boolean,
  generation: number,
): number | undefined {
  const ref = useRef<{ key: string; gen: number; value: number } | null>(null);
  const [displayed, setDisplayed] = useState<number | undefined>(raw);
  useEffect(() => {
    const prev = ref.current;
    // A new session or a compaction reset starts fresh: snap to the latest raw,
    // which may be undefined when the new session has no stats yet. Clearing it
    // here prevents the previous session's usage from lingering on the meter.
    if (!prev || prev.key !== key || generation !== prev.gen) {
      ref.current = raw === undefined ? null : { key, gen: generation, value: raw };
      setDisplayed(raw);
      return;
    }
    // Same session: a transient missing reading keeps the last value rather than
    // flickering to empty mid-stream.
    if (raw === undefined) return;
    const next = isExact ? raw : Math.max(prev.value, raw);
    if (next !== prev.value) {
      ref.current = { key, gen: generation, value: next };
      setDisplayed(next);
    }
  }, [key, raw, isExact, generation]);
  return displayed;
}

export default function ContextMeter({
  mission,
  stats,
  sessionKey,
}: {
  mission: MissionSummary;
  stats?: ContextStatsSnapshot;
  sessionKey?: string;
}) {
  const { state, dispatch } = useStore();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ right: number; bottom: number }>({ right: 0, bottom: 0 });

  const measured =
    stats ??
    (mission.contextUpdatedAt
      ? {
          used: mission.contextTokens,
          remaining: mission.contextRemainingTokens ?? 0,
          limit: mission.maxContextTokens ?? 0,
          accuracy: mission.contextAccuracy ?? 'estimated',
          updatedAt: mission.contextUpdatedAt,
        }
      : undefined);
  // When a worker is selected its stats flow in here, but `mission` is still the
  // orchestrator summary; a worker may run a different model, so derive the
  // window/marker/generation from the session actually shown rather than the
  // orchestrator's model.
  const isOrchestratorView = !sessionKey || sessionKey === mission.id;
  const catalogWindow =
    mission.maxContextTokens && mission.maxContextTokens > 0 ? mission.maxContextTokens : undefined;
  const statLimit = measured?.limit && measured.limit > 0 ? measured.limit : undefined;
  // Measure usage against the real model context window (the standard
  // denominator). The orchestrator catalog window is known before the first
  // stats arrive; a worker reports its own window via stats.limit.
  const modelWindow = isOrchestratorView ? (catalogWindow ?? statLimit) : statLimit;

  // The daemon auto-compacts before the window fills; surface that trigger as a
  // separate "Compacts at" marker. It uses the orchestrator's model, so it is
  // only meaningful for the orchestrator's own session; a reset-to-Default
  // session resolves to its mode's default (spec / mission orchestrator differ
  // from the chat default) so the marker still tracks the active model's
  // per-model trigger. A reset-to-Default chat tracks the Factory default
  // (defaultModelId) - the model the live session actually runs - not the
  // user's separate new-chat orchestrator override (agentConfig.orchestrator),
  // which only seeds models for chats created afterward.
  const effectiveCompaction = isOrchestratorView
    ? compactsAtMarker(
        mission.modelId,
        orchestratorDefaultModelId(mission.kind, {
          chat: state.defaultModelId,
          spec: state.specModelId,
          missionOrchestrator: state.missionOrchestratorModelId,
        }),
        state.compactionTokenLimitPerModel,
        state.compactionTokenLimit,
        modelWindow,
      )
    : undefined;
  const max = modelWindow ?? statLimit;

  const accuracy = measured?.accuracy;
  const isEstimating = (accuracy ?? 'estimated') !== 'exact';
  // Compaction count is the generation: the daemon compacts in place (same
  // session id), so a bump is the only signal that context dropped. It resets
  // the stabilized usage floor to the lower post-compaction reading. The
  // orchestrator uses its persisted summary count; a selected worker uses its
  // own per-session compaction generation, so a worker auto-compaction resets
  // the worker meter (without an orchestrator compaction ever resetting it).
  const workerGeneration = sessionKey ? state.compactionGenerations[sessionKey] : undefined;
  const generation = isOrchestratorView ? (mission.compactionCount ?? 0) : (workerGeneration ?? 0);
  const used = useStableUsed(sessionKey ?? mission.id, measured?.used, !isEstimating, generation);
  const remaining =
    used !== undefined && max !== undefined ? Math.max(0, max - used) : measured?.remaining;
  const categories = measured?.breakdown?.categories ?? [];
  const ready = used !== undefined && max !== undefined && max > 0;
  const pct = ready ? used / max : 0;
  const pctLabel = ready ? Math.min(100, Math.round(pct * 100)) : 0;

  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({ right: window.innerWidth - r.right, bottom: window.innerHeight - r.top + 8 });
  }, [open]);

  // Detach the native browser view while the popover is open so it renders
  // above the right pane and outside clicks reach this component's handler.
  useEffect(() => {
    dispatch({ type: 'SET_CONTEXT_METER_OPEN', open });
    return () => {
      if (open) dispatch({ type: 'SET_CONTEXT_METER_OPEN', open: false });
    };
  }, [open, dispatch]);

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
          {ready ? `${isEstimating ? '~' : ''}${fmt(used)} / ${fmt(max)}` : 'Context ...'}
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
                <button
                  onClick={() => setOpen(false)}
                  className="text-droid-text-muted transition-colors hover:text-droid-text"
                >
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
                      style={{
                        background: pct > 0.85 ? 'var(--droid-orange)' : 'var(--droid-accent)',
                      }}
                      animate={{ width: `${Math.min(100, pct * 100)}%` }}
                      transition={{ duration: 0.5, ease: EASE }}
                    />
                  </div>
                </>
              ) : (
                <div className="rounded-lg border border-droid-border bg-droid-bg/40 px-3 py-2 text-[12px] text-droid-text-muted">
                  Waiting for Droid context stats
                </div>
              )}

              <div className="mt-4 flex flex-col gap-2.5">
                {ready && <Row color="var(--droid-accent)" label="Window used" value={used} />}
                {remaining !== undefined && (
                  <Row color="var(--droid-text-muted)" label="Window free" value={remaining} />
                )}
                {effectiveCompaction !== undefined && (
                  <Row
                    color="var(--droid-orange)"
                    label="Compacts at"
                    value={effectiveCompaction}
                  />
                )}
                {modelWindow !== undefined && (
                  <Row color="var(--droid-text-muted)" label="Model window" value={modelWindow} />
                )}
                <Row
                  color="var(--droid-text-muted)"
                  label="Session input"
                  value={mission.tokensIn}
                />
                <Row color="var(--droid-green)" label="Session output" value={mission.tokensOut} />
              </div>

              {categories.length > 0 && (
                <div className="mt-3 border-t border-droid-border pt-3">
                  <div className="mb-2 text-[10px] uppercase tracking-wide text-droid-text-muted">
                    Breakdown
                  </div>
                  <div className="flex flex-col gap-2">
                    {categories.slice(0, 8).map((cat) => (
                      <Row
                        key={cat.name}
                        color={categoryColor(cat.colorKey)}
                        label={cat.name}
                        value={cat.tokens}
                      />
                    ))}
                  </div>
                </div>
              )}

              {accuracy && (
                <div className="mt-3 border-t border-droid-border pt-2 text-[10px] capitalize text-droid-text-muted">
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
