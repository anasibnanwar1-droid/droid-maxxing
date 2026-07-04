import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown, Copy, ExternalLink, RotateCw, Trash2 } from 'lucide-react';
import { useStudioCanvas, sizeOf, type StudioFrame } from './StudioCanvasContext';

const STATUS_LABEL: Record<StudioFrame['status'], string> = {
  loading: 'connecting',
  building: 'building',
  ready: 'live',
  failed: 'failed',
};
const STATUS_TONE: Record<StudioFrame['status'], string> = {
  loading: 'text-white/50',
  building: 'text-[#ee6018]',
  ready: 'text-[#7aa37a]',
  failed: 'text-[#c0563a]',
};

/**
 * Right context panel — resolved detail for the current selection plus agent
 * actions. A context surface, not a property editor: values are read-only and
 * every mutation routes through the agent.
 */
export default function SelectionContextPanel() {
  const { studio, studioDispatch } = useStudioCanvas();
  // Collapsed by default so a selected frame's details never disturb the view.
  const [collapsed, setCollapsed] = useState(true);
  const frame =
    studio.selectedFrameIds.length === 1
      ? studio.frames.find((f) => f.id === studio.selectedFrameIds[0])
      : undefined;
  const elements = studio.selection.filter((s) => s.frameId);

  if (!frame && studio.selectedFrameIds.length !== 1 && elements.length === 0) return null;

  return (
    <motion.aside
      initial={{ opacity: 0, x: 16 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 16 }}
      transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
      className="pointer-events-auto absolute right-4 top-4 z-20 w-[264px] overflow-hidden rounded-2xl border border-white/[0.08] bg-[#111]/95 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.8)] backdrop-blur-xl"
    >
      {frame ? (
        <>
          <button
            onClick={() => setCollapsed((v) => !v)}
            className="flex w-full items-center gap-2 px-4 py-3 text-left"
          >
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-white/90">
              {frame.name}
            </span>
            <motion.span
              animate={frame.status === 'building' ? { opacity: [0.45, 1, 0.45] } : { opacity: 1 }}
              transition={
                frame.status === 'building'
                  ? { duration: 1.4, repeat: Infinity, ease: 'easeInOut' }
                  : { duration: 0 }
              }
              className={`text-[10.5px] ${STATUS_TONE[frame.status]}`}
            >
              {STATUS_LABEL[frame.status]}
            </motion.span>
            <ChevronDown
              className={`h-3.5 w-3.5 text-white/35 transition-transform ${
                collapsed ? '' : 'rotate-180'
              }`}
            />
          </button>
          <AnimatePresence initial={false}>
            {!collapsed && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                className="overflow-hidden"
              >
                <div className="space-y-2.5 border-t border-white/[0.06] px-4 py-3">
                  <DetailRow label="kind" value={frame.kind} />
                  <DetailRow
                    label="viewport"
                    value={`${sizeOf(frame).width}×${sizeOf(frame).height}`}
                  />
                  <DetailRow label="source" value={frame.url || '—'} mono wrap />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          <div className="flex items-center gap-1 border-t border-white/[0.06] px-3 py-2">
            <Action
              icon={<RotateCw className="h-3.5 w-3.5" />}
              label="Reload"
              onClick={() =>
                { studioDispatch({ type: 'UPDATE_FRAME', id: frame.id, patch: { status: 'loading' } }); }
              }
            />
            <Action
              icon={<Copy className="h-3.5 w-3.5" />}
              label="Duplicate"
              onClick={() =>
                { studioDispatch({
                  type: 'ADD_FRAME',
                  frame: { name: `${frame.name} copy`, url: frame.url, mode: frame.mode },
                }); }
              }
            />
            <Action
              icon={<ExternalLink className="h-3.5 w-3.5" />}
              label="Open"
              onClick={() => frame.url && window.open(frame.url, '_blank')}
            />
            <Action
              icon={<Trash2 className="h-3.5 w-3.5" />}
              label="Delete"
              danger
              onClick={() => { studioDispatch({ type: 'REMOVE_FRAME', id: frame.id }); }}
            />
          </div>
        </>
      ) : (
        <div className="px-4 py-3 text-[12px] text-white/55">
          {studio.selectedFrameIds.length} frames selected
        </div>
      )}

      {elements.length > 0 && (
        <div className="border-t border-white/[0.06] px-4 py-3">
          <div className="pb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-white/35">
            references
          </div>
          {elements.map((el) => (
            <div key={el.id} className="flex items-center gap-1.5 py-0.5">
              <span className="truncate text-[12px] text-white/70">{el.label}</span>
              {el.tag && <span className="font-mono text-[10px] text-white/35">{el.tag}</span>}
            </div>
          ))}
        </div>
      )}
    </motion.aside>
  );
}

function DetailRow({
  label,
  value,
  mono,
  wrap,
}: {
  label: string;
  value: string;
  mono?: boolean;
  wrap?: boolean;
}) {
  return (
    <div className="flex items-start gap-3">
      <span className="w-16 shrink-0 pt-px text-[10.5px] font-medium uppercase tracking-wide text-white/30">
        {label}
      </span>
      <span
        className={`min-w-0 flex-1 text-[12px] text-white/75 ${mono ? 'font-mono text-[11px]' : ''} ${
          wrap ? 'break-all' : 'truncate'
        }`}
      >
        {value}
      </span>
    </div>
  );
}

function Action({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      className={`flex flex-1 flex-col items-center gap-1 rounded-lg py-1.5 text-[10px] transition-colors ${
        danger
          ? 'text-white/45 hover:bg-[#c0563a]/15 hover:text-[#e0806a]'
          : 'text-white/55 hover:bg-white/[0.06] hover:text-white/90'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
