import { AnimatePresence, motion } from 'framer-motion';
import { Check, FileText, Hexagon, Terminal } from 'lucide-react';
import { Fragment, type MouseEvent } from 'react';

import type { SkillInfo, SkillLocation } from '../types/bridge';

const ACCENT = 'var(--droid-accent)';

export interface SlashCommand {
  cmd: string;
  desc: string;
  run: () => void;
}

export type MenuItem =
  | { type: 'command'; command: SlashCommand }
  | { type: 'skill'; skill: SkillInfo }
  | { type: 'file'; path: string };

const LOCATION_LABEL: Record<SkillLocation, string> = {
  project: 'Project',
  personal: 'Personal',
  builtin: 'Built-in',
};

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

// Slash-menu section for a row: the first command and first skill each open
// their labeled group. findIndex returns -1 for a missing group, which no row
// index can match.
function menuSection(
  kind: 'slash' | 'file' | null,
  index: number,
  firstCommandIndex: number,
  firstSkillIndex: number,
): 'Commands' | 'Skills' | null {
  if (kind !== 'slash') return null;
  if (index === firstCommandIndex) return 'Commands';
  if (index === firstSkillIndex) return 'Skills';
  return null;
}

interface ComposerMenuProps {
  open: boolean;
  triggerKind: 'slash' | 'file' | null;
  filesLoading: boolean;
  items: MenuItem[];
  activeIndex: number;
  activeSkills: SkillInfo[];
  attachedFiles: string[];
  onHoverItem: (index: number) => void;
  onRunItem: (item: MenuItem) => void;
}

// The composer's / and @ autocomplete dropdown: slash commands, skills, and
// files in one keyboard-navigable list. Rendering only — trigger detection,
// item filtering, and keyboard handling stay in PromptInput.
export default function ComposerMenu({
  open,
  triggerKind,
  filesLoading,
  items,
  activeIndex,
  activeSkills,
  attachedFiles,
  onHoverItem,
  onRunItem,
}: ComposerMenuProps) {
  const firstCommandIndex = items.findIndex((item) => item.type === 'command');
  const firstSkillIndex = items.findIndex((item) => item.type === 'skill');
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 6 }}
          transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
          className="absolute bottom-full left-0 right-0 mb-2 z-50 rounded-xl border border-droid-border bg-droid-elevated shadow-2xl shadow-black/40 overflow-hidden py-1 max-h-72 overflow-y-auto"
        >
          {triggerKind === 'file' && (
            <div className="flex items-center gap-1.5 px-3 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-droid-text-muted/60">
              <FileText className="w-3 h-3" /> Files{filesLoading ? ' — loading…' : ''}
            </div>
          )}
          {items.map((item, i) => {
            const on = i === Math.min(activeIndex, items.length - 1);
            const base = `w-full flex items-center gap-3 px-3 py-2 text-left transition-colors ${on ? 'bg-droid-surface' : 'hover:bg-droid-surface/50'}`;
            const section = menuSection(triggerKind, i, firstCommandIndex, firstSkillIndex);
            // Mouse users run the row on mousedown (preventDefault keeps focus
            // in the textarea). Keyboard and assistive-technology activation
            // fire click with detail 0 and no preceding mousedown, so run the
            // row there too without double-firing for mouse users.
            const runOnKeyboardClick = (e: MouseEvent<HTMLButtonElement>) => {
              if (e.detail === 0) onRunItem(item);
            };
            const sectionHeader = section ? (
              <div
                className={`px-3 pb-1 text-[10px] font-medium uppercase tracking-wide text-droid-text-muted/50 ${i === 0 ? 'pt-1.5' : 'pt-2.5'}`}
              >
                {section}
              </div>
            ) : null;
            if (item.type === 'command') {
              return (
                <Fragment key={`cmd-${item.command.cmd}`}>
                  {sectionHeader}
                  <button
                    onMouseEnter={() => {
                      onHoverItem(i);
                    }}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      onRunItem(item);
                    }}
                    onClick={runOnKeyboardClick}
                    className={base}
                  >
                    <Terminal className="w-4 h-4 shrink-0 text-droid-text-muted/70" />
                    <span className="shrink-0 text-[12.5px] font-medium text-droid-text">
                      {item.command.cmd}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[11.5px] text-droid-text-muted">
                      {item.command.desc}
                    </span>
                  </button>
                </Fragment>
              );
            }
            if (item.type === 'skill') {
              const added = activeSkills.some((s) => s.filePath === item.skill.filePath);
              return (
                <Fragment key={`skill-${item.skill.filePath}`}>
                  {sectionHeader}
                  <button
                    onMouseEnter={() => {
                      onHoverItem(i);
                    }}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      onRunItem(item);
                    }}
                    onClick={runOnKeyboardClick}
                    className={base}
                  >
                    <Hexagon className="w-4 h-4 shrink-0 text-droid-text-muted/70" />
                    <span className="shrink-0 text-[12.5px] font-medium text-droid-text">
                      {item.skill.name}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[11.5px] text-droid-text-muted">
                      {item.skill.description}
                    </span>
                    {added && (
                      <>
                        <Check
                          className="w-3.5 h-3.5 shrink-0"
                          style={{ color: ACCENT }}
                          aria-hidden="true"
                        />
                        <span className="sr-only">added</span>
                      </>
                    )}
                    <span className="shrink-0 text-[10.5px] text-droid-text-muted/60">
                      {LOCATION_LABEL[item.skill.location]}
                    </span>
                  </button>
                </Fragment>
              );
            }
            return (
              <button
                key={`file-${item.path}`}
                onMouseEnter={() => {
                  onHoverItem(i);
                }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onRunItem(item);
                }}
                onClick={runOnKeyboardClick}
                className={base}
              >
                <FileText className="w-3.5 h-3.5 shrink-0 text-droid-text-muted" />
                <span className="shrink-0 text-[12px] font-medium text-droid-text">
                  {basename(item.path)}
                </span>
                <span className="min-w-0 flex-1 truncate text-[11.5px] text-droid-text-muted/70">
                  {item.path}
                </span>
                {attachedFiles.includes(item.path) && (
                  <>
                    <Check
                      className="w-3 h-3 shrink-0"
                      style={{ color: ACCENT }}
                      aria-hidden="true"
                    />
                    <span className="sr-only">attached</span>
                  </>
                )}
              </button>
            );
          })}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
