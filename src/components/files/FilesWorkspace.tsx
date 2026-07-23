import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  ChevronDown,
  ChevronRight,
  File,
  FileText,
  Folder,
  FolderOpen,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { listDirectory, type FilesEntry, type FilesListing } from '../../lib/desktop';
import { classifyByName } from '../../lib/filePreview';
import { FilePreviewPane } from './FilePreviewPane';

interface VisibleEntry extends FilesEntry {
  relative: string;
  depth: number;
}

function normalizeRelative(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function joinRelative(parent: string, name: string): string {
  return normalizeRelative(parent ? `${parent}/${name}` : name);
}

export function FilesWorkspace({
  root,
  selectedPath,
  onSelectPath,
}: {
  root: string;
  selectedPath?: string;
  onSelectPath: (relative: string) => void;
}) {
  const [listings, setListings] = useState<Partial<Record<string, FilesListing>>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['']));
  const [loading, setLoading] = useState<Set<string>>(() => new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const rootVersionRef = useRef(0);

  useLayoutEffect(() => {
    rootVersionRef.current += 1;
  }, [root]);

  const load = useCallback(
    async (relative: string, force = false) => {
      const key = normalizeRelative(relative);
      if (!force && key in listings) return;
      const requestVersion = rootVersionRef.current;
      setLoading((current) => new Set(current).add(key));
      setErrors((current) =>
        Object.fromEntries(Object.entries(current).filter(([k]) => k !== key)),
      );
      try {
        const listing = await listDirectory(root, key);
        if (rootVersionRef.current !== requestVersion) return;
        setListings((current) => ({ ...current, [key]: listing }));
      } catch (reason) {
        if (rootVersionRef.current !== requestVersion) return;
        setErrors((current) => ({
          ...current,
          [key]: reason instanceof Error ? reason.message : String(reason),
        }));
      } finally {
        if (rootVersionRef.current === requestVersion) {
          setLoading((current) => {
            const next = new Set(current);
            next.delete(key);
            return next;
          });
        }
      }
    },
    [listings, root],
  );

  useEffect(() => {
    let cancelled = false;
    setListings({});
    setExpanded(new Set(['']));
    setLoading(new Set());
    setErrors({});
    void listDirectory(root, '')
      .then((listing) => {
        if (!cancelled) setListings({ '': listing });
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setErrors({ '': reason instanceof Error ? reason.message : String(reason) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [root]);

  const visible = useMemo(() => {
    const rows: VisibleEntry[] = [];
    const visit = (parent: string, depth: number) => {
      for (const entry of listings[parent]?.entries ?? []) {
        const relative = joinRelative(parent, entry.name);
        rows.push({ ...entry, relative, depth });
        if (entry.kind === 'directory' && expanded.has(relative)) {
          visit(relative, depth + 1);
        }
      }
    };
    visit('', 0);
    return rows;
  }, [expanded, listings]);

  const toggleDirectory = (relative: string) => {
    const willExpand = !expanded.has(relative);
    setExpanded((current) => {
      const next = new Set(current);
      if (willExpand) next.add(relative);
      else next.delete(relative);
      return next;
    });
    if (willExpand) void load(relative);
  };

  const rootListing = listings[''];

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(150px,34%)_minmax(0,1fr)] bg-droid-bg">
      <section className="flex min-h-0 flex-col border-r border-droid-border bg-droid-surface/25">
        <header className="flex h-10 shrink-0 items-center gap-2 border-b border-droid-border px-3">
          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-droid-accent" />
          <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-droid-text-muted">
            {root}
          </span>
          <button
            type="button"
            title="Refresh files"
            onClick={() => void load('', true)}
            className="flex h-7 w-7 items-center justify-center rounded-md text-droid-text-muted hover:bg-droid-elevated hover:text-droid-text"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto py-1" role="tree" aria-label="Session files">
          {!rootListing && !errors[''] && (
            <div className="flex items-center gap-2 px-3 py-3 text-xs text-droid-text-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading files…
            </div>
          )}
          {errors[''] && (
            <p className="px-3 py-3 text-xs leading-relaxed text-red-300">{errors['']}</p>
          )}
          {visible.map((entry) => (
            <FileTreeRow
              key={entry.relative}
              entry={entry}
              selected={entry.relative === selectedPath}
              expanded={expanded.has(entry.relative)}
              loading={loading.has(entry.relative)}
              error={errors[entry.relative]}
              onClick={() => {
                if (entry.kind === 'directory') toggleDirectory(entry.relative);
                else onSelectPath(entry.relative);
              }}
            />
          ))}
          {rootListing?.capped && (
            <p className="px-3 py-2 text-[10.5px] text-amber-300">
              Showing {rootListing.entries.length} of {rootListing.totalSeen} entries.
            </p>
          )}
        </div>
      </section>
      <FilePreviewPane
        root={root}
        relative={selectedPath ?? ''}
        onClear={() => {
          onSelectPath('');
        }}
      />
    </div>
  );
}

function FileTreeRow({
  entry,
  selected,
  expanded,
  loading,
  error,
  onClick,
}: {
  entry: VisibleEntry;
  selected: boolean;
  expanded: boolean;
  loading: boolean;
  error?: string;
  onClick: () => void;
}) {
  const category = entry.kind === 'file' ? classifyByName(entry.name) : null;
  let ItemIcon: typeof File;
  if (entry.kind === 'directory') {
    ItemIcon = expanded ? FolderOpen : Folder;
  } else {
    ItemIcon = category === 'text' ? FileText : File;
  }
  let chevron: ReactNode = null;
  if (entry.kind === 'directory') {
    if (loading) chevron = <Loader2 className="h-3 w-3 animate-spin" />;
    else if (expanded) chevron = <ChevronDown className="h-3 w-3" />;
    else chevron = <ChevronRight className="h-3 w-3" />;
  }
  return (
    <>
      <button
        type="button"
        role="treeitem"
        aria-selected={selected}
        aria-expanded={entry.kind === 'directory' ? expanded : undefined}
        onClick={onClick}
        title={entry.relative}
        className={`flex h-7 w-full items-center gap-1.5 pr-2 text-left text-[11.5px] transition-colors ${
          selected
            ? 'bg-droid-accent/12 text-droid-text'
            : 'text-droid-text-secondary hover:bg-droid-elevated/70 hover:text-droid-text'
        }`}
        style={{ paddingLeft: `${String(6 + entry.depth * 14)}px` }}
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center">{chevron}</span>
        <ItemIcon
          className={`h-3.5 w-3.5 shrink-0 ${
            entry.kind === 'directory' ? 'text-droid-accent' : 'text-droid-text-muted'
          }`}
        />
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
      </button>
      {error && (
        <p
          className="truncate py-1 pr-2 text-[10px] text-red-300"
          style={{ paddingLeft: `${String(26 + entry.depth * 14)}px` }}
          title={error}
        >
          {error}
        </p>
      )}
    </>
  );
}
