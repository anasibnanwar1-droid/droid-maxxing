import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronRight } from 'lucide-react';
import type { FileChange, DiffOp } from '../lib/diff';

const ADD_BG = 'rgba(74, 158, 122, 0.14)';
const DEL_BG = 'rgba(255, 93, 46, 0.13)';
const ADD_FG = '#5cc89a';
const DEL_FG = '#ff7a5c';

function DiffLines({ ops }: { ops: DiffOp[] }) {
  return (
    <div className="font-mono text-[11.5px] leading-[1.65] overflow-x-auto">
      {ops.map((o, i) => (
        <div
          key={i}
          className="flex"
          style={{ background: o.type === 'add' ? ADD_BG : o.type === 'del' ? DEL_BG : 'transparent' }}
        >
          <span
            className="w-5 shrink-0 text-center select-none"
            style={{ color: o.type === 'add' ? ADD_FG : o.type === 'del' ? DEL_FG : 'var(--droid-text-muted)' }}
          >
            {o.type === 'add' ? '+' : o.type === 'del' ? '−' : ''}
          </span>
          <span className="whitespace-pre flex-1 px-1 text-droid-text-secondary">{o.text || ' '}</span>
        </div>
      ))}
    </div>
  );
}

const VERB_LABEL: Record<FileChange['verb'], string> = { edit: 'Edit', create: 'Create', patch: 'Patch' };

function DiffHeader({ change }: { change: FileChange }) {
  return (
    <div className="flex items-center gap-2 px-3 h-9 border-b border-droid-border/50 bg-droid-bg/40 shrink-0">
      <span className="text-[12px] font-medium text-droid-text-secondary shrink-0">{VERB_LABEL[change.verb]}</span>
      <span className="text-[12px] font-mono text-droid-text-muted truncate flex-1">{change.path}</span>
      <span className="text-[11px] font-mono" style={{ color: ADD_FG }}>+{change.added}</span>
      <span className="text-[11px] font-mono" style={{ color: DEL_FG }}>−{change.removed}</span>
    </div>
  );
}

export function DiffCard({ change, onOpen }: { change: FileChange; onOpen?: () => void }) {
  const [open, setOpen] = useState(false);
  const preview = change.ops.slice(0, 14);
  const more = change.ops.length - preview.length;

  return (
    <div>
      <button onClick={() => setOpen((o) => !o)} className="group flex w-full min-w-0 items-center gap-1.5 text-left">
        <ChevronRight className={`w-3 h-3 shrink-0 text-droid-text-muted/50 transition-transform duration-200 group-hover:text-droid-text-muted ${open ? 'rotate-90' : ''}`} />
        <span className="text-[13px] font-medium shrink-0 text-droid-text-muted group-hover:text-droid-text-secondary">{VERB_LABEL[change.verb]}</span>
        <span className="min-w-0 truncate font-mono text-[12px] text-droid-text-muted">{change.path}</span>
        <span className="ml-auto text-[11px] font-mono shrink-0" style={{ color: ADD_FG }}>+{change.added}</span>
        <span className="text-[11px] font-mono shrink-0" style={{ color: DEL_FG }}>−{change.removed}</span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            <div className="mt-2 rounded-lg bg-droid-bg/40 py-1">
              <DiffLines ops={preview} />
              {(more > 0 || onOpen) && (
                <button onClick={onOpen} className="block w-full text-left px-3 py-1.5 text-[11px] text-droid-text-muted hover:text-droid-text transition-colors">
                  {more > 0 ? `+${more} more lines · open full diff` : 'Open full diff'}
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function DiffFull({ change }: { change: FileChange }) {
  return (
    <div className="flex flex-col h-full">
      <DiffHeader change={change} />
      <div className="flex-1 min-h-0 overflow-auto py-1">
        <DiffLines ops={change.ops} />
      </div>
    </div>
  );
}
