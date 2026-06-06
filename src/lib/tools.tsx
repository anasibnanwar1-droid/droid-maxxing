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
