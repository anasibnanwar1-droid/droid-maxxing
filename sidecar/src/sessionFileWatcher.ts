/**
 * Live watch over ~/.factory/sessions so sessions created, updated, or
 * deleted outside this app instance (Droid CLI runs, a parallel app
 * instance) are republished to the sidebar without a restart.
 *
 * The watcher only decides WHEN to republish; the session list itself is
 * always served from a fresh disk scan, so this module holds no session
 * state and can never serve stale rows.
 */
import { watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { errMsg } from './sessionHelpers.js';

export interface SessionFileWatcher {
  close(): void;
}

export interface SessionFileWatcherOptions {
  // Watched directory; defaults to ~/.factory/sessions. Injectable for tests.
  root?: string;
  // Trailing debounce: the callback fires once after writes settle. There is
  // deliberately no maximum wait, so a continuously streaming session never
  // triggers a mid-stream rescan of the whole sessions tree.
  debounceMs?: number;
  // Live in-app sessions already push their updates through the session
  // registry, so writes to their files must not trigger a rescan.
  isLiveSession?: (providerSessionId: string) => boolean;
  onExternalChange: () => void;
}

const SESSION_FILE_SUFFIX = '.jsonl';

// Session files are named <providerSessionId>.jsonl inside per-cwd
// directories. Anything else (directory events, unknown names) returns
// undefined and is treated as an external change.
export function sessionIdFromSessionFileName(filename: string | null): string | undefined {
  if (!filename) return undefined;
  const base = filename.split(/[\\/]/).pop() ?? '';
  if (!base.endsWith(SESSION_FILE_SUFFIX)) return undefined;
  return base.slice(0, -SESSION_FILE_SUFFIX.length);
}

// Returns null when the directory cannot be watched (missing root, or a
// platform without recursive fs.watch such as Linux). Live republish then
// degrades gracefully: sessions.list still scans the disk on every request.
export function startSessionFileWatcher(
  options: SessionFileWatcherOptions,
): SessionFileWatcher | null {
  const root = options.root ?? join(homedir(), '.factory', 'sessions');
  const debounceMs = options.debounceMs ?? 1500;
  let timer: NodeJS.Timeout | undefined;
  // State for the batch of events inside one debounce window. Creating a
  // file fires an event for the file AND one for its parent directory, so a
  // directory event only justifies a rescan when no live session file in the
  // same batch explains it.
  let pendingExternal = false;
  let pendingUnknown = false;
  let pendingLiveSeen = false;
  let closed = false;

  let watcher: FSWatcher;
  try {
    watcher = watch(root, { recursive: true }, (_eventType, filename) => {
      const id = sessionIdFromSessionFileName(filename);
      if (id) {
        if (options.isLiveSession?.(id)) pendingLiveSeen = true;
        else pendingExternal = true;
      } else {
        pendingUnknown = true;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        const shouldFire = pendingExternal || (pendingUnknown && !pendingLiveSeen);
        pendingExternal = false;
        pendingUnknown = false;
        pendingLiveSeen = false;
        if (!closed && shouldFire) options.onExternalChange();
      }, debounceMs);
    });
  } catch {
    return null;
  }
  // A watcher error must never take the sidecar down; the next sessions.list
  // still serves a fresh scan.
  watcher.on('error', (error) => {
    console.error(`Session file watcher failed; live republish disabled: ${errMsg(error)}`);
  });

  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      watcher.close();
    },
  };
}
