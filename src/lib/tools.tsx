import { Eye, FilePlus, FilePen, Terminal, FileText, Search, Globe, Boxes, Bot } from 'lucide-react';

export type ToolCat = 'read' | 'create' | 'edit' | 'exec' | 'search' | 'web' | 'skill' | 'task' | 'other';

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

// A Task/subagent spawn is identified by the tool name or a `subagent_type` arg.
export function isSubagentTool(name?: string, args?: unknown): boolean {
  if (/task|subagent|delegate/i.test(name ?? '')) return true;
  const a = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  return typeof a.subagent_type === 'string' || typeof a.subagentType === 'string';
}

// The droid name and short description carried by a Task spawn's arguments.
export function subagentInfo(args: unknown): { label?: string; description?: string } {
  const a = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  const s = (k: string) => (typeof a[k] === 'string' ? (a[k] as string).trim() || undefined : undefined);
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
