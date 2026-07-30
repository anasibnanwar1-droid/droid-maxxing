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
import type { TranscriptEvent } from '../types/bridge';

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
  const s = (k: string) => (typeof a[k] === 'string' ? a[k] : undefined);
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
  else if (n.includes('skill')) cat = 'skill';
  else if (/read|cat|view|open|list|ls/.test(n)) cat = 'read';

  return { cat, detail: file ?? cmd ?? pattern ?? url ?? childSessionDetail ?? skill ?? '' };
}

export type TodoStatus = 'completed' | 'in_progress' | 'pending';
export interface TodoItem {
  text: string;
  status: TodoStatus;
}

// Parse the model's TodoWrite payload. The `todos` field is a numbered,
// multi-line string where each line carries a status marker, e.g.
//   "1. [in_progress] Wire up the parser".
export function parseTodos(args: unknown): TodoItem[] {
  const a = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  const raw = typeof a.todos === 'string' ? a.todos : undefined;
  if (!raw) return [];
  const items: TodoItem[] = [];
  for (const line of raw.split('\n')) {
    const m = /\[(completed|in_progress|pending)\]\s*(.+?)\s*$/i.exec(line);
    if (!m) continue;
    items.push({ status: m[1].toLowerCase() as TodoStatus, text: m[2].trim() });
  }
  return items;
}

export function isTodoTool(name?: string): boolean {
  return /todo/i.test(name ?? '');
}

export interface TodoSnapshot {
  todos: TodoItem[];
  foundPayload: boolean;
}

// The model's current plan: the latest real Todo update wins, even if it emptied
// the list; partial/streaming calls without a `todos` payload are skipped so a
// half-arrived update never replaces the plan on screen.
export function latestTodoSnapshot(events: readonly TranscriptEvent[]): TodoSnapshot {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === 'tool_call' && isTodoTool(e.toolName) && hasTodoPayload(e.toolArgs)) {
      return { todos: parseTodos(e.toolArgs), foundPayload: true };
    }
  }
  return { todos: [], foundPayload: false };
}

// The step a plan is currently on: the running one, else the next unstarted one,
// else the final step once everything is done.
export function activeTodoIndex(todos: readonly TodoItem[]): number {
  const running = todos.findIndex((t) => t.status === 'in_progress');
  if (running >= 0) return running;
  const next = todos.findIndex((t) => t.status === 'pending');
  if (next >= 0) return next;
  return todos.length - 1;
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
  const s = (k: string) => (typeof a[k] === 'string' ? a[k].trim() || undefined : undefined);
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
    return Object.prototype.toString.call(value);
  }
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return '<1s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${String(s)}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${String(m)}m ${String(rem)}s` : `${String(m)}m`;
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

// MCP-style tool names carry a server prefix (`server___tool`, `mcp__server__tool`).
// Match on the bare tool name so a namespaced fetch/search still routes correctly.
function bareToolName(name: string): string {
  const tri = name.lastIndexOf('___');
  if (tri >= 0 && tri + 3 < name.length) return name.slice(tri + 3);
  const mcp = /^mcp__[^_]+__(.+)$/i.exec(name);
  if (mcp) return mcp[1];
  return name;
}

// Lowercase word tokens of a tool name: `_`/`-`/`.`/space separators and
// camelCase boundaries all split ("FetchUrl" → ["fetch", "url"]). Word tokens
// keep "browser" distinct from "browse", so browser-automation tools never
// match the fetch patterns.
function toolNameTokens(name?: string): string[] {
  const bare = bareToolName((name ?? '').trim());
  return bare
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const WEB_WORDS = new Set(['web', 'internet', 'online']);
const SEARCH_ENGINES = new Set([
  'google',
  'bing',
  'brave',
  'tavily',
  'exa',
  'perplexity',
  'duckduckgo',
  'kagi',
  'serp',
  'serpapi',
]);

// A WebSearch tool call (as opposed to a plain URL fetch), identified by name.
// Matches web-flavoured search names across conventions (WebSearch, web_search,
// brave-web-search, mcp__tavily__tavily-search, …). A plain local "Search" or
// "Grep" tool stays false — a web/engine signal is required.
export function isWebSearchTool(name?: string): boolean {
  const tokens = toolNameTokens(name);
  if (tokens.length === 0) return false;
  if (tokens.some((t) => t === 'websearch' || t === 'searchweb')) return true;
  if (tokens.some((t) => SEARCH_ENGINES.has(t))) return true;
  const hasSearch = tokens.some((t) => t === 'search' || t === 'query');
  return hasSearch && tokens.some((t) => WEB_WORDS.has(t));
}

const FETCH_WORDS = ['fetch', 'scrape', 'crawl', 'browse'];
const FETCH_VERBS = new Set([
  'open',
  'get',
  'load',
  'read',
  'visit',
  'download',
  'request',
  'goto',
]);
const URL_WORDS = new Set([
  'url',
  'uri',
  'link',
  'page',
  'site',
  'web',
  'webpage',
  'http',
  'https',
  'html',
]);

// A page-fetch tool (FetchUrl, WebFetch, open_url, mcp__fetch__fetch, …) — not
// a multi-result web search. Prefer this over cat === 'web' when the tool name
// is known; cat still works as a fallback for unnamed MCP/url tools that only
// carry a `url` arg. Browser-automation tools (browser_open, browser_navigate)
// are excluded: they drive a live page rather than fetch readable content.
export function isWebFetchTool(name?: string): boolean {
  if (isWebSearchTool(name)) return false;
  const tokens = toolNameTokens(name);
  if (tokens.length === 0 || tokens.includes('browser')) return false;
  const joined = tokens.join(' ');
  if (FETCH_WORDS.some((w) => joined.includes(w))) return true;
  if (tokens.some((t) => t === 'http' || t === 'https' || t === 'webpage')) return true;
  if (tokens.includes('web') && tokens.includes('page')) return true;
  const hasVerb = tokens.some((t) => FETCH_VERBS.has(t));
  const hasUrl = tokens.some((t) => URL_WORDS.has(t));
  return hasVerb && hasUrl;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

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
  const clean = text.replace(/\r\n/g, '\n');
  const query = /Web Search Results for:\s*"([\s\S]*?)"\s*\n/.exec(clean)?.[1]?.trim();
  const countMatch = /Found\s+(\d+)\s+results?/i.exec(clean);
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

// Fetch results prepend a small metadata preamble (`Title: …`, `URL: …`) before
// the page body, so only the opening lines are metadata candidates. Matching
// document-wide would strip genuine body lines that begin with "Title:"/"URL:".
const FETCH_META_PREAMBLE_LINES = 5;

function stripFetchMeta(
  clean: string,
  opts: { h1?: string; titleMeta?: string; urlLine?: string; firstLineTitle?: boolean },
): string {
  let preview = clean;
  if (opts.titleMeta) preview = preview.replace(/^Title:\s*.+$/im, '');
  if (opts.urlLine) preview = preview.replace(/^URL:\s*\S+$/im, '');
  if (opts.h1) preview = preview.replace(/^#\s+.+$/m, '');
  // A title inferred from the first body line would otherwise repeat as the
  // body's opening line; drop it so the card's title and preview stay distinct.
  // Safe after the removals above: in the fallback case the first line is never
  // a Title:/URL:/# line, so those removals cannot change which line leads.
  if (opts.firstLineTitle) preview = preview.replace(/^[^\n]*(?:\n|$)/, '');
  preview = preview.replace(/^\n+/, '').trim();
  return preview.length > 0 ? preview : clean;
}

// Pull a title + clean body out of a FetchUrl-style tool result so the UI can
// render a source card instead of a mono dump. Title sources (first match wins):
//   1. markdown `# heading`
//   2. `Title: …` metadata line (preamble only — see FETCH_META_PREAMBLE_LINES)
//   3. first short non-URL line (stripped from the body so it isn't duplicated)
// The URL prefers the tool arg; a `URL: …` preamble line is the fallback.
export function parseWebFetch(text: string, urlFromArgs?: string): WebFetchPage {
  const { body: stripped, truncatedChars } = parseTruncatedTail(text);
  const clean = stripped.replace(/\r\n/g, '\n').trim();
  const preamble = clean.split('\n').slice(0, FETCH_META_PREAMBLE_LINES).join('\n');
  const urlLine = /^URL:\s*(\S+)/im.exec(preamble)?.[1]?.trim();
  const argUrl = urlFromArgs?.trim();
  const url = argUrl && argUrl.length > 0 ? argUrl : urlLine;

  const h1 = /^#\s+(.+)$/m.exec(clean)?.[1]?.trim();
  const titleMeta = /^Title:\s*(.+)$/im.exec(preamble)?.[1]?.trim();
  const title = inferFetchTitle(clean, h1, titleMeta);
  const firstLineTitle = title !== undefined && h1 === undefined && titleMeta === undefined;
  const body = stripFetchMeta(clean, {
    h1: title ? h1 : undefined,
    titleMeta,
    urlLine,
    firstLineTitle,
  });

  return { url, title, body, chars: body.length, truncatedChars };
}

// A fetch body that is raw HTML (doctype / dense tag soup) reads worse as
// rendered markdown than as a mono block, so the card keeps it in a <pre>.
export function looksLikeHtml(text: string): boolean {
  const t = text.trimStart();
  if (/^<!doctype\s+html/i.test(t) || /^<html[\s>]/i.test(t)) return true;
  const sample = t.slice(0, 2000);
  const tags = sample.match(/<\/?[a-z][a-z0-9]*(\s[^>\n]*)?>/gi)?.length ?? 0;
  return tags >= 8;
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
