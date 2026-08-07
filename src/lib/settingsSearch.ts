// Searchable catalog of settings: tab titles plus the labels/keywords users
// actually type ("play sound", "theme", "autonomy"). Used by the settings shell
// to filter the nav, jump to the right screen, and list matching controls.

import {
  FINISH_NOTIFICATION_TEST_ACTION,
  FINISH_NOTIFICATION_TOGGLES,
} from './finishNotificationControls';

export interface SettingsSearchEntry {
  /** Settings nav tab to open. */
  tab: string;
  /** Human label shown in search hits (usually the control name). */
  label: string;
  /** Extra tokens matched case-insensitively. */
  keywords?: string[];
}

function e(tab: string, label: string, keywords: string[] = []): SettingsSearchEntry {
  return { tab, label, keywords };
}

/**
 * Indexed settings content for every shipped tab. Placeholder tabs are indexed
 * by name/aliases so search still navigates even before those screens exist.
 */
export const SETTINGS_SEARCH_ENTRIES: readonly SettingsSearchEntry[] = [
  // ── Notifications (shared control definitions) ───────────────────────────
  ...FINISH_NOTIFICATION_TOGGLES.map((row) => e('Notifications', row.label, [...row.keywords])),
  e('Notifications', FINISH_NOTIFICATION_TEST_ACTION.label, [
    ...FINISH_NOTIFICATION_TEST_ACTION.keywords,
  ]),

  // ── Appearance ───────────────────────────────────────────────────────────
  e('Appearance', 'Theme', ['light', 'dark', 'system', 'look', 'mode', 'appearance']),
  e('Appearance', 'App icon', ['icon', 'dock', 'light icon', 'dark icon']),
  e('Appearance', 'Presets', ['preset theme', 'palette', 'preset']),
  e('Appearance', 'Accent', ['color', 'colour', 'accent color']),
  e('Appearance', 'App background', ['background color', 'bg']),
  e('Appearance', 'Text color', ['foreground', 'font color']),
  e('Appearance', 'Panel background', ['surface', 'card']),
  e('Appearance', 'Borders', ['border color', 'divider']),
  e('Appearance', 'UI font', ['font family', 'typeface', 'typography']),
  e('Appearance', 'UI font size', ['font size', 'text size', 'zoom']),
  e('Appearance', 'Code font size', ['monospace', 'code size', 'editor font']),
  e('Appearance', 'Contrast', ['high contrast']),
  e('Appearance', 'Translucent sidebar', ['blur', 'frosted', 'glass', 'transparency', 'vibrancy']),

  // ── General ──────────────────────────────────────────────────────────────
  e('General', 'Enter while working', [
    'queue',
    'interrupt',
    'send now',
    'composer',
    'enter key',
    'live enter',
  ]),
  e('General', 'Image paste quality', [
    'paste',
    'jpeg',
    'png',
    'image',
    'drop image',
    'attachment quality',
    'compact image',
  ]),
  e('General', 'Diff view', ['unified', 'split', 'side by side', 'diff layout']),
  e('General', 'Diff theme', ['soft', 'focused', 'diff contrast', 'diff colors']),
  e('General', 'Compaction model', ['compact', 'summarize', 'compaction']),
  e('General', 'Token limit', ['context limit', 'compaction limit', 'tokens']),
  e('General', 'Per-model token limits', [
    'model override',
    'per model',
    'token override',
    'context per model',
  ]),

  // ── Setup & updates ──────────────────────────────────────────────────────
  e('Setup & updates', 'CLI status', ['droid cli', 'install', 'cli path', 'cli version']),
  e('Setup & updates', 'Keep the CLI up to date', [
    'auto update cli',
    'cli update',
    'silent update',
  ]),
  e('Setup & updates', 'Sign-in', ['login', 'auth', 'account', 'factory', 'signed in']),
  e('Setup & updates', 'Current version', ['app version', 'installed version']),
  e('Setup & updates', 'Check for updates', ['check for updates', 'update check']),
  e('Setup & updates', 'Check for DROIDEX updates', [
    'app update',
    'auto update',
    'download update',
    'version',
  ]),
  e('Setup & updates', 'Run setup again', ['onboarding', 'first run', 'setup tour', 'wizard']),

  // ── Configuration ────────────────────────────────────────────────────────
  e('Configuration', 'Default autonomy', [
    'autonomy',
    'permissions',
    'off',
    'low',
    'medium',
    'high',
    'default autonomy',
  ]),
  e('Configuration', 'Sessions', ['session defaults']),

  // ── Worktrees ────────────────────────────────────────────────────────────
  e('Worktrees', 'Worktrees', [
    'git worktree',
    'linked checkout',
    'remove worktree',
    'branch worktree',
  ]),
  e('Worktrees', 'Refresh', ['scan worktrees', 'reload worktrees']),
  e('Worktrees', 'Remove worktree', ['delete worktree', 'clean worktree']),

  // ── Privacy & diagnostics ────────────────────────────────────────────────
  e('Privacy & diagnostics', 'Crash reports and Release Health', [
    'sentry',
    'diagnostics',
    'privacy',
    'telemetry',
    'crash',
    'release health',
    'automatic diagnostics',
  ]),
  e('Privacy & diagnostics', 'Automatic diagnostics', [
    'crash reports',
    'minidump',
    'profile id',
    'ops data',
  ]),

  // ── Placeholder tabs (name + common aliases until those screens ship) ────
  e('Profile', 'Profile', ['account', 'user', 'avatar', 'identity']),
  e('Personalization', 'Personalization', [
    'persona',
    'instructions',
    'custom instructions',
    'memory',
    'preferences',
  ]),
  e('Keyboard shortcuts', 'Keyboard shortcuts', [
    'hotkeys',
    'keymap',
    'bindings',
    'shortcuts',
    'cmd',
  ]),
  e('Usage & billing', 'Usage & billing', ['billing', 'usage', 'quota', 'invoice', 'plan', 'cost']),
  e('Snapshots', 'Snapshots', ['snapshot', 'checkpoint', 'restore']),
  e('MCP servers', 'MCP servers', ['mcp', 'tools server', 'model context protocol']),
  e('Browser', 'Browser', ['native browser', 'web browser', 'browser pane']),
  e('Hooks', 'Hooks', ['lifecycle hooks', 'script hooks']),
  e('Connections', 'Connections', ['integrations', 'connected apps']),
  e('Git', 'Git', ['github', 'vcs', 'version control', 'commit', 'branch']),
  e('Environments', 'Environments', ['env', 'environment variables', 'runtime']),
  e('Archived chats', 'Archived chats', ['archive', 'archived', 'hidden chats']),
];

export interface SettingsSearchHit {
  tab: string;
  label: string;
  score: number;
}

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, ' ');
}

function entryHaystack(entry: SettingsSearchEntry): string {
  return [entry.tab, entry.label, ...(entry.keywords ?? [])].join(' ').toLowerCase();
}

/** True if this tab should stay visible for the current query. */
export function tabMatchesQuery(tab: string, query: string): boolean {
  const q = normalizeQuery(query);
  if (!q) return true;
  if (tab.toLowerCase().includes(q)) return true;
  return SETTINGS_SEARCH_ENTRIES.some(
    (entry) => entry.tab === tab && entryHaystack(entry).includes(q),
  );
}

function scoreEntry(entry: SettingsSearchEntry, q: string): number {
  const label = entry.label.toLowerCase();
  const tab = entry.tab.toLowerCase();
  const keywords = entry.keywords ?? [];
  if (label === q || tab === q) return 100;
  if (label.startsWith(q) || tab.startsWith(q)) return 80;
  if (keywords.some((k) => k.toLowerCase() === q)) return 70;
  if (label.includes(q)) return 60;
  if (keywords.some((k) => k.toLowerCase().includes(q))) return 50;
  if (tab.includes(q)) return 40;
  if (entryHaystack(entry).includes(q)) return 30;
  return 0;
}

/**
 * Ranked setting hits for the query. Empty query → no hits (caller shows normal
 * browsing). Scores prefer label prefix/containment over keyword-only matches.
 */
export function searchSettings(query: string, limit = 16): SettingsSearchHit[] {
  const q = normalizeQuery(query);
  if (!q) return [];

  const hits: SettingsSearchHit[] = [];
  for (const entry of SETTINGS_SEARCH_ENTRIES) {
    const score = scoreEntry(entry, q);
    if (score > 0) hits.push({ tab: entry.tab, label: entry.label, score });
  }

  hits.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  const seen = new Set<string>();
  const unique: SettingsSearchHit[] = [];
  for (const hit of hits) {
    const key = `${hit.tab}::${hit.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(hit);
    if (unique.length >= limit) break;
  }
  return unique;
}

/** Best tab to open for a query, or null when nothing matches. */
export function bestTabForQuery(query: string): string | null {
  const hits = searchSettings(query, 1);
  return hits[0]?.tab ?? null;
}
