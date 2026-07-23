import {
  Eye,
  FilePlus,
  FilePen,
  Terminal,
  FileText,
  Search,
  Globe,
  Boxes,
  Bot,
} from 'lucide-react';

export type ToolCat =
  | 'read'
  | 'create'
  | 'edit'
  | 'exec'
  | 'search'
  | 'web'
  | 'skill'
  | 'task'
  | 'other';

export const CAT_ICON: Record<ToolCat, React.ElementType> = {
  read: Eye,
  create: FilePlus,
  edit: FilePen,
  exec: Terminal,
  search: Search,
  web: Globe,
  skill: Boxes,
  task: Bot,
  other: FileText,
};

export const CAT_LABEL: Record<ToolCat, string> = {
  read: 'Read',
  create: 'Create',
  edit: 'Edit',
  exec: 'Execute',
  search: 'Search',
  web: 'Fetch',
  skill: 'Skill',
  task: 'Subagent',
  other: 'Tool',
};

export function toolMeta(name?: string, args?: unknown): { cat: ToolCat; detail: string } {
  const n = (name ?? '').toLowerCase();
  const a = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  const s = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : undefined);
  const file = s('file_path') ?? s('path') ?? s('filename') ?? s('target_file');
  const cmd = s('command') ?? s('cmd') ?? s('script');
  const pattern = s('pattern') ?? s('query');
  const url = s('url');
  const subagent = s('subagent_type') ?? s('subagentType') ?? s('description');
  const skill = s('skill');

  let cat: ToolCat = 'other';
  if (/create|write|new/.test(n)) cat = 'create';
  else if (/edit|patch|replace|modify|update|insert/.test(n)) cat = 'edit';
  else if (/exec|run|bash|shell|command|terminal/.test(n)) cat = 'exec';
  else if (/grep|search|glob|find/.test(n)) cat = 'search';
  else if (/fetch|web|url|http/.test(n)) cat = 'web';
  else if (/task|subagent|delegate/.test(n) || subagent) cat = 'task';
  else if (/skill/.test(n)) cat = 'skill';
  else if (/read|cat|view|open|list|ls/.test(n)) cat = 'read';

  return { cat, detail: file ?? cmd ?? pattern ?? url ?? subagent ?? skill ?? '' };
}

export type TodoStatus = 'completed' | 'in_progress' | 'pending';
export type TodoItem = { text: string; status: TodoStatus };

// Parse the model's TodoWrite payload. The `todos` field is a numbered,
// multi-line string where each line carries a status marker, e.g.
//   "1. [in_progress] Wire up the parser".
export function parseTodos(args: unknown): TodoItem[] {
  const a = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  const raw = typeof a.todos === 'string' ? a.todos : undefined;
  if (!raw) return [];
  const items: TodoItem[] = [];
  for (const line of raw.split('\n')) {
    const m = line.match(/\[(completed|in_progress|pending)\]\s*(.+?)\s*$/i);
    if (!m) continue;
    items.push({ status: m[1].toLowerCase() as TodoStatus, text: m[2].trim() });
  }
  return items;
}

export function isTodoTool(name?: string): boolean {
  return /todo/i.test(name ?? '');
}

// A real TodoWrite update carries the full list in its `todos` string (even when
// that list is empty); a partial/streaming tool_call lacks the field entirely.
// Lets callers honor an emptied list instead of falling back to a stale one.
export function hasTodoPayload(args: unknown): boolean {
  const a = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  return typeof a.todos === 'string';
}

// A Task/subagent spawn is identified by the tool name or a `subagent_type` arg.
export function isSubagentTool(name?: string, args?: unknown): boolean {
  // Whole-word match so unrelated tools (e.g. `create_task`) aren't mistaken
  // for a subagent spawn; the strong signal is the `subagent_type` arg.
  if (/\b(task|subagent|delegate)\b/i.test(name ?? '')) return true;
  const a = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  return typeof a.subagent_type === 'string' || typeof a.subagentType === 'string';
}

// The droid name and short description carried by a Task spawn's arguments.
export function subagentInfo(args: unknown): { label?: string; description?: string } {
  const a = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  const s = (k: string) =>
    typeof a[k] === 'string' ? (a[k] as string).trim() || undefined : undefined;
  return { label: s('subagent_type') ?? s('subagentType'), description: s('description') };
}

// Remove terminal ANSI/VT escape sequences from captured command output.
const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /[\u001b\u009b][[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007|(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~])/g;

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(ANSI_PATTERN, '').replace(/\u001b[=>]/g, '');
}

export function safeJson(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return '<1s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}

// The history reader appends a "[truncated N chars]" sentinel when a single
// message exceeds its per-event cap. Strip that tail so the body renders as
// normal prose and the raw sentinel never shows in the message.
const TRUNCATION_RE = /\n*\[truncated (\d+) chars\]\s*$/;

export function parseTruncatedTail(text: string): { body: string; truncatedChars: number | null } {
  const m = TRUNCATION_RE.exec(text);
  if (!m) return { body: text, truncatedChars: null };
  return { body: text.slice(0, m.index).trimEnd(), truncatedChars: Number(m[1]) };
}

// A WebSearch tool call (as opposed to a plain URL fetch), identified by name.
export function isWebSearchTool(name?: string): boolean {
  return /web.?search/i.test(name ?? '');
}

export type WebSearchResult = { title: string; url: string; snippet: string };

// Parse the WebSearch tool result text. Each result is a block separated by a
// "---" line:
//   Web Search Results for: "<query>"
//
//   **<Title>**
//      URL: https://…
//
//      <snippet, possibly ending with …>
//   ---
//   Found N results
export function parseWebSearch(text: string): {
  query?: string;
  count?: number;
  results: WebSearchResult[];
} {
  const results: WebSearchResult[] = [];
  const clean = (text ?? '').replace(/\r\n/g, '\n');
  const query = clean.match(/Web Search Results for:\s*"([\s\S]*?)"\s*\n/)?.[1]?.trim();
  const countMatch = clean.match(/Found\s+(\d+)\s+results?/i);
  const re =
    /\*\*(.+?)\*\*[ \t]*\n[ \t]*URL:[ \t]*(\S+)([\s\S]*?)(?=\n[ \t]*-{3,}[ \t]*\n|\nFound \d+ results?|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) !== null) {
    const snippet = m[3]
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .join(' ')
      .trim();
    results.push({ title: m[1].trim(), url: m[2].trim(), snippet });
  }
  const count = countMatch ? Number(countMatch[1]) : results.length || undefined;
  return { query, count, results };
}

// Human-friendly source label from a URL: the registrable name, capitalized
// (e.g. https://www.theregister.com/… → "Theregister"). Falls back to the URL.
export function webSourceName(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const parts = host.split('.');
    const label = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
    return label.charAt(0).toUpperCase() + label.slice(1);
  } catch {
    return url;
  }
}

// A small favicon URL for a result's domain, or undefined if the URL is unusable.
export function faviconUrl(url: string): string | undefined {
  try {
    const host = new URL(url).hostname;
    return `https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(host)}`;
  } catch {
    return undefined;
  }
}

export function toolArgStringArray(args: unknown, key: string): string[] {
  const a = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  const v = a[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
