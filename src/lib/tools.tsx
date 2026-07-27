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
  task: 'Child session',
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
  const childSessionDetail = s('subagent_type') ?? s('subagentType') ?? s('description');
  const skill = s('skill');

  let cat: ToolCat = 'other';
  if (/create|write|new/.test(n)) cat = 'create';
  else if (/edit|patch|replace|modify|update|insert/.test(n)) cat = 'edit';
  else if (/exec|run|bash|shell|command|terminal/.test(n)) cat = 'exec';
  else if (/grep|search|glob|find/.test(n)) cat = 'search';
  else if (/fetch|web|url|http/.test(n)) cat = 'web';
  else if (/task|subagent|delegate/.test(n) || childSessionDetail) cat = 'task';
  else if (/skill/.test(n)) cat = 'skill';
  else if (/read|cat|view|open|list|ls/.test(n)) cat = 'read';

  return { cat, detail: file ?? cmd ?? pattern ?? url ?? childSessionDetail ?? skill ?? '' };
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

// Factory Task/subagent metadata identifies a child-session spawn.
export function isChildSessionTool(name?: string, args?: unknown): boolean {
  // Whole-word match so unrelated tools (e.g. `create_task`) aren't mistaken
  // for a child spawn; the strong Factory signal is the `subagent_type` arg.
  if (/\b(task|subagent|delegate)\b/i.test(name ?? '')) return true;
  const a = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  return typeof a.subagent_type === 'string' || typeof a.subagentType === 'string';
}

// The droid name and short description carried by a Task spawn's arguments.
export function childSessionInfo(args: unknown): { label?: string; description?: string } {
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

// A page-fetch tool (FetchUrl, WebFetch, …) — not a multi-result web search.
// Prefer this over cat === 'web' when the tool name is known; cat still works
// as a fallback for unnamed MCP/url tools that only carry a `url` arg.
export function isWebFetchTool(name?: string): boolean {
  if (isWebSearchTool(name)) return false;
  return /fetch|browse|open.?url|get.?url|web.?page|read.?url|scrape|http/i.test(name ?? '');
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

export interface WebFetchPage {
  url?: string;
  title?: string;
  /** Readable page body with the history truncation sentinel stripped. */
  body: string;
  /** Character count of the cleaned body (for a compact badge). */
  chars: number;
  truncatedChars: number | null;
}

function firstNonEmptyLine(text: string): string | undefined {
  return text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
}

function inferFetchTitle(clean: string, h1?: string, titleMeta?: string): string | undefined {
  if (h1) return h1;
  if (titleMeta) return titleMeta;
  const first = firstNonEmptyLine(clean);
  if (!first || first.length > 120) return undefined;
  if (/^https?:\/\//i.test(first) || /^URL:/i.test(first)) return undefined;
  const stripped = first
    .replace(/^#+\s*/, '')
    .replace(/^\*+|\*+$/g, '')
    .trim();
  return stripped.length > 0 ? stripped : undefined;
}

function stripFetchMeta(clean: string, opts: { h1?: string; titleMeta?: string; urlLine?: string }): string {
  let preview = clean;
  if (opts.titleMeta) preview = preview.replace(/^Title:\s*.+$/im, '');
  if (opts.urlLine) preview = preview.replace(/^URL:\s*\S+$/im, '');
  if (opts.h1) preview = preview.replace(/^#\s+.+$/m, '');
  preview = preview.replace(/^\n+/, '').trim();
  return preview.length > 0 ? preview : clean;
}

// Pull a title + clean body out of a FetchUrl-style tool result so the UI can
// render a source card instead of a mono dump. Title sources (first match wins):
//   1. markdown `# heading`
//   2. `Title: …` metadata line
//   3. first short non-URL line
// The URL prefers the tool arg; a `URL: …` body line is the fallback.
export function parseWebFetch(text: string, urlFromArgs?: string): WebFetchPage {
  const { body: stripped, truncatedChars } = parseTruncatedTail(text);
  const clean = stripped.replace(/\r\n/g, '\n').trim();
  const urlLine = /^URL:\s*(\S+)/im.exec(clean)?.[1]?.trim();
  const argUrl = urlFromArgs?.trim();
  const url = argUrl && argUrl.length > 0 ? argUrl : urlLine;

  const h1 = /^#\s+(.+)$/m.exec(clean)?.[1]?.trim();
  const titleMeta = /^Title:\s*(.+)$/im.exec(clean)?.[1]?.trim();
  const title = inferFetchTitle(clean, h1, titleMeta);
  const body = stripFetchMeta(clean, { h1: title ? h1 : undefined, titleMeta, urlLine });

  return { url, title, body, chars: body.length, truncatedChars };
}

// Compact badge label for a character count (e.g. 1240 → "1.2k").
export function formatCharCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) {
    const v = Math.round(n / 100) / 10;
    const label = v % 1 === 0 ? v.toFixed(0) : v.toFixed(1);
    return `${label}k`;
  }
  return `${String(Math.round(n / 1000))}k`;
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
