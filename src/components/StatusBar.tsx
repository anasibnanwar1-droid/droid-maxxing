import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useStore } from '../hooks/useStore';
import { useMissionLive } from '../hooks/useMissionLive';
import { ModelIcon } from './ModelIcon';
import ContextMeter from './ContextMeter';

const EASE = [0.16, 1, 0.3, 1] as const;

/* dot-matrix / LED-board text: a dot grid clipped to the letterforms */
function DotMatrix({ text }: { text: string }) {
  return (
    <span
      className="font-mono font-black uppercase leading-none"
      style={{
        fontSize: '17px',
        letterSpacing: '0.42em',
        paddingLeft: '0.42em',
        backgroundImage: 'radial-gradient(var(--droid-accent) 44%, transparent 48%)',
        backgroundSize: '3px 3px',
        WebkitBackgroundClip: 'text',
        backgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
        color: 'transparent',
      }}
    >
      {text}
    </span>
  );
}

/* Blocky pixel-fragment sweep that flies across once, left → right */
function PixelSweep({ trigger }: { trigger: number }) {
  return (
    <motion.div
      key={trigger}
      className="pointer-events-none absolute inset-0 overflow-hidden"
      initial={{ opacity: 1 }}
      animate={{ opacity: 1 }}
    >
      {/* soft accent wash */}
      <motion.div
        className="absolute inset-y-0 w-1/3"
        initial={{ x: '-120%' }}
        animate={{ x: '360%' }}
        transition={{ duration: 0.85, ease: EASE }}
        style={{
          background:
            'linear-gradient(90deg, transparent, color-mix(in srgb, var(--droid-accent) 38%, transparent), transparent)',
        }}
      />
      {/* white pixel fragments riding the leading edge */}
      <motion.div
        className="absolute inset-y-0 flex items-center gap-[3px]"
        initial={{ x: '-40%' }}
        animate={{ x: '108%' }}
        transition={{ duration: 0.85, ease: EASE }}
      >
        {Array.from({ length: 7 }).map((_, i) => (
          <motion.span
            key={i}
            className="block rounded-[1px] bg-white"
            style={{ width: 3 + (i % 3), height: 3 + (i % 3) }}
            initial={{ opacity: 0.9, y: (i % 2 ? -1 : 1) * (4 + i) }}
            animate={{ opacity: 0, y: 0 }}
            transition={{ duration: 0.5, delay: 0.05 * i, ease: 'easeOut' }}
          />
        ))}
      </motion.div>
    </motion.div>
  );
}

export default function StatusBar() {
  const { state } = useStore();
  const mission = state.activeMissionId ? state.missions[state.activeMissionId] : null;
  const live = useMissionLive(state.activeMissionId);
  const contextSessionId =
    state.selectedAgentSessionId && state.selectedAgentSessionId !== 'orchestrator'
      ? state.selectedAgentSessionId
      : mission?.id;
  const contextStats = contextSessionId ? state.contextStats[contextSessionId] : undefined;
  const contextMission =
    mission && contextSessionId !== mission.id && !contextStats
      ? {
          ...mission,
          contextTokens: 0,
          contextRemainingTokens: undefined,
          contextAccuracy: undefined,
          contextUpdatedAt: undefined,
          maxContextTokens: undefined,
        }
      : mission;
  const isMission = (mission?.features?.length ?? 0) > 0;
  // Show the moment Mission mode is entered (/mission), or whenever an orchestrated mission is running.
  const on = state.missionMode || (!!mission && live && isMission);
  const [hoverKey, setHoverKey] = useState(0);

  return (
    <div className="relative h-8 bg-droid-surface border-t border-droid-border shrink-0 select-none overflow-hidden">
      <AnimatePresence>
        {on && (
          <motion.div
            key="mc"
            className="absolute inset-0 flex items-center justify-center gap-3"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            onHoverStart={() => setHoverKey((k) => k + 1)}
          >
            <PixelSweep trigger={hoverKey} />
            <motion.span
              className="flex"
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ duration: 0.5, ease: EASE }}
            >
              <span className="flex animate-[spin_9s_linear_infinite]">
                <ModelIcon provider="factory" size={15} />
              </span>
            </motion.span>
            <motion.div
              initial={{ clipPath: 'inset(0 100% 0 0)' }}
              animate={{ clipPath: 'inset(0 0% 0 0)' }}
              transition={{ duration: 0.7, ease: EASE, delay: 0.08 }}
            >
              <DotMatrix text="MISSION CONTROL" />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="absolute right-3 top-0 bottom-0 flex items-center">
        {mission?.queuedSends ? (
          <span className="mr-2 rounded-md border border-droid-border bg-droid-elevated/70 px-1.5 py-0.5 font-mono text-[10px] text-droid-text-secondary">
            {mission.queuedSends} queued
          </span>
        ) : null}
        {mission?.compactedFromSessionIds?.length ? (
          <span
            className="mr-2 rounded-md border border-droid-border bg-droid-elevated/70 px-1.5 py-0.5 font-mono text-[10px] text-droid-text-secondary"
            title="Times this session has been compacted"
          >
            {mission.compactedFromSessionIds.length} compaction{mission.compactedFromSessionIds.length === 1 ? '' : 's'}
          </span>
        ) : null}
        {contextMission && <ContextMeter mission={contextMission} stats={contextStats} />}
      </div>
    </div>
  );
}
