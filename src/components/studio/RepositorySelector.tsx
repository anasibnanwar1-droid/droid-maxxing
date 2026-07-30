import { useRef, useState } from 'react';
import { Check, ChevronDown, FolderGit2, FolderPlus } from 'lucide-react';
import { workspaceName } from '../../lib/workspaces';
import { Popover } from '../environment/Popover';

export default function RepositorySelector({
  repositoryCwds,
  selectedCwd,
  onSelect,
  onAdd,
  onOpen,
}: {
  repositoryCwds: string[];
  selectedCwd: string;
  onSelect: (cwd: string) => void;
  onAdd: () => Promise<void>;
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const repositories = [selectedCwd, ...repositoryCwds].filter(
    (candidate, index, all) => candidate !== '' && all.indexOf(candidate) === index,
  );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        title={selectedCwd}
        aria-label={`Repository: ${workspaceName(selectedCwd)}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => {
          setOpen((value) => {
            const next = !value;
            if (next) onOpen?.();
            return next;
          });
        }}
        className={`no-drag flex min-w-0 max-w-[190px] items-center gap-1.5 rounded-lg px-2 py-1 text-[12px] transition-colors ${
          open
            ? 'bg-droid-active text-droid-text'
            : 'text-droid-text-secondary hover:bg-droid-elevated hover:text-droid-text'
        }`}
      >
        <FolderGit2 className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
        <span className="truncate">{workspaceName(selectedCwd)}</span>
        <ChevronDown
          className={`h-3 w-3 shrink-0 text-droid-text-muted transition-transform ${
            open ? 'rotate-180' : ''
          }`}
          strokeWidth={1.75}
        />
      </button>

      <Popover
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        anchorRef={triggerRef}
        label="Select repository"
        align="left"
        width={300}
        className="studio-popover"
      >
        <div data-studio-dismissable-layer className="min-h-0 overflow-y-auto p-1.5">
          <div className="px-2 pb-1.5 pt-1 text-[11px] font-medium text-droid-text-muted">
            Work in
          </div>
          {repositories.map((cwd) => {
            const selected = cwd === selectedCwd;
            return (
              <button
                key={cwd}
                type="button"
                aria-pressed={selected}
                onClick={() => {
                  onSelect(cwd);
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors ${
                  selected ? 'bg-droid-active' : 'hover:bg-droid-elevated'
                }`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] font-medium text-droid-text">
                    {workspaceName(cwd)}
                  </span>
                  <span className="mt-0.5 block truncate text-[10.5px] text-droid-text-muted">
                    {cwd}
                  </span>
                </span>
                {selected && (
                  <Check className="h-3.5 w-3.5 shrink-0 text-droid-accent" strokeWidth={2} />
                )}
              </button>
            );
          })}
        </div>
        <div className="border-t border-droid-border p-1.5">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              void onAdd();
            }}
            className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-[12.5px] text-droid-text-secondary transition-colors hover:bg-droid-elevated hover:text-droid-text"
          >
            <FolderPlus className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
            Add repository…
          </button>
        </div>
      </Popover>
    </>
  );
}
