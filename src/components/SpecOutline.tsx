import { useRef, useEffect, useMemo } from 'react';
import { Search, X } from 'lucide-react';

export interface OutlineHeading {
  level: number;
  text: string;
  id: string;
  content: string;
}

function extractOutline(markdown: string): OutlineHeading[] {
  const headings: OutlineHeading[] = [];
  const lines = markdown.split('\n');
  let currentHeading: { level: number; text: string; id: string; lines: string[] } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^(#{1,3})\s+(.+)$/);
    if (match) {
      if (currentHeading) {
        headings.push({
          level: currentHeading.level,
          text: currentHeading.text,
          id: currentHeading.id,
          content: currentHeading.lines.join('\n').trim().slice(0, 400),
        });
      }
      const text = match[2].trim();
      const id = text
        .toLowerCase()
        .replace(/[^\w\s-]/g, '')
        .replace(/[\s_-]+/g, '-')
        .replace(/^-+|-+$/g, '');
      currentHeading = { level: match[1].length, text, id, lines: [] };
    } else if (currentHeading) {
      currentHeading.lines.push(line);
    }
  }
  if (currentHeading) {
    headings.push({
      level: currentHeading.level,
      text: currentHeading.text,
      id: currentHeading.id,
      content: currentHeading.lines.join('\n').trim().slice(0, 400),
    });
  }
  return headings;
}

export function useSpecOutline(markdown: string) {
  return useMemo(() => extractOutline(markdown), [markdown]);
}

export function SpecOutline({
  headings,
  activeId,
  onSelect,
  searchQuery,
  onSearchChange,
}: {
  headings: OutlineHeading[];
  activeId: string | null;
  onSelect: (id: string) => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
}) {
  const searchRef = useRef<HTMLInputElement>(null);

  const q = searchQuery.trim().toLowerCase();
  const filtered = q ? headings.filter((h) => h.text.toLowerCase().includes(q)) : headings;

  // Cmd/Ctrl+F focuses the outline search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const highlight = (text: string) => {
    if (!q) return text;
    const idx = text.toLowerCase().indexOf(q);
    if (idx < 0) return text;
    return (
      <>
        {text.slice(0, idx)}
        <mark className="bg-transparent text-droid-accent font-medium">
          {text.slice(idx, idx + q.length)}
        </mark>
        {text.slice(idx + q.length)}
      </>
    );
  };

  return (
    <aside className="w-60 shrink-0 flex flex-col border-l border-droid-border bg-droid-surface/20 select-none">
      {/* Search */}
      <div className="shrink-0 px-3 py-2.5 border-b border-droid-border">
        <div className="flex items-center gap-2 h-8 px-2.5 rounded-lg bg-droid-bg/50 border border-droid-border focus-within:border-droid-border-hover transition-colors">
          <Search className="w-3.5 h-3.5 shrink-0 text-droid-text-muted/60" />
          <input
            ref={searchRef}
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Find in outline…"
            className="flex-1 min-w-0 bg-transparent text-[12px] text-droid-text placeholder-droid-text-muted/50 focus:outline-none"
          />
          {searchQuery && (
            <button
              onClick={() => onSearchChange('')}
              className="p-0.5 rounded text-droid-text-muted/60 hover:text-droid-text transition-colors"
              title="Clear"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>

      {/* Heading list */}
      <nav className="flex-1 overflow-y-auto py-2 px-2">
        {filtered.length === 0 ? (
          <div className="px-2 py-6 text-center text-[11px] text-droid-text-muted/60">
            {q ? 'No matching sections' : 'No sections'}
          </div>
        ) : (
          filtered.map((h) => {
            const isActive = activeId === h.id;
            return (
              <button
                key={h.id}
                onClick={() => onSelect(h.id)}
                style={{ paddingLeft: `${(h.level - 1) * 12 + 10}px` }}
                className={`group w-full flex items-center gap-2 pr-2 py-1.5 rounded-md text-left transition-colors ${
                  isActive ? 'bg-droid-elevated/60' : 'hover:bg-droid-elevated/30'
                }`}
              >
                <span
                  className="shrink-0 w-[3px] h-3.5 rounded-full transition-colors"
                  style={{ background: isActive ? 'var(--droid-accent)' : 'transparent' }}
                />
                <span
                  className={`truncate ${
                    h.level === 1 ? 'text-[12.5px]' : 'text-[12px]'
                  } ${isActive ? 'text-droid-text font-medium' : 'text-droid-text-secondary group-hover:text-droid-text'}`}
                >
                  {highlight(h.text)}
                </span>
              </button>
            );
          })
        )}
      </nav>

      {/* Footer count */}
      <div className="shrink-0 h-8 border-t border-droid-border flex items-center justify-center">
        <span className="text-[10px] font-mono text-droid-text-muted/50">
          {q ? `${filtered.length}/${headings.length}` : `${headings.length} sections`}
        </span>
      </div>
    </aside>
  );
}
