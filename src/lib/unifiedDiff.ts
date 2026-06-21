// Parse a `git diff` unified patch into structured hunks/lines so the Review
// tab can render both unified and split views without re-parsing per frame.

type DiffLineType = 'add' | 'del' | 'ctx' | 'meta';

export interface DiffLine {
  type: DiffLineType;
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface ParsedDiff {
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface SplitRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parseUnifiedDiff(diff: string): ParsedDiff {
  const hunks: DiffHunk[] = [];
  let additions = 0;
  let deletions = 0;
  let binary = false;
  let current: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const raw of String(diff || '').split('\n')) {
    if (raw.startsWith('Binary files ')) {
      binary = true;
      continue;
    }
    const hunkMatch = HUNK_RE.exec(raw);
    if (hunkMatch) {
      oldLine = Number.parseInt(hunkMatch[1], 10);
      newLine = Number.parseInt(hunkMatch[2], 10);
      current = { header: raw, lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue; // file headers before the first hunk
    // A trailing newline makes split('\n') yield a final '' that is not a diff
    // line (real blank context lines arrive as a single space); skip it so the
    // last hunk does not gain a phantom blank context row.
    if (raw === '') continue;
    if (raw.startsWith('\\')) {
      current.lines.push({ type: 'meta', text: raw.slice(1).trim(), oldLine: null, newLine: null });
      continue;
    }
    const marker = raw[0];
    const text = raw.slice(1);
    if (marker === '+') {
      current.lines.push({ type: 'add', text, oldLine: null, newLine });
      newLine += 1;
      additions += 1;
    } else if (marker === '-') {
      current.lines.push({ type: 'del', text, oldLine, newLine: null });
      oldLine += 1;
      deletions += 1;
    } else {
      current.lines.push({ type: 'ctx', text, oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    }
  }

  return { hunks, additions, deletions, binary };
}

// Pair deletion/addition runs side-by-side for the split view.
export function toSplitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.type === 'ctx') {
      rows.push({ left: line, right: line });
      i += 1;
      continue;
    }
    if (line.type === 'meta') {
      // Keep meta markers (e.g. "\ No newline at end of file") so split view
      // renders them full-width instead of silently dropping them.
      rows.push({ left: line, right: null });
      i += 1;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i].type === 'del') dels.push(lines[i++]);
    while (i < lines.length && lines[i].type === 'add') adds.push(lines[i++]);
    const rowCount = Math.max(dels.length, adds.length);
    for (let k = 0; k < rowCount; k++) {
      rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
    }
  }
  return rows;
}
