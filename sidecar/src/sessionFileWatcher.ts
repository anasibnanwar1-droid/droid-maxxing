/**
 * Live watch over ~/.factory/sessions so sessions created, updated, or
 * deleted outside this app instance (Droid CLI runs, a parallel app
 * instance) are republished to the sidebar without a restart.
 *
 * The watcher only decides WHEN and WHAT changed; the session list itself is
 * served from the sqlite session file cache, which reconciles exactly the
 * reported files (or runs a full diff when events are unexplained), so this
 * module holds no session state and can never serve stale rows.
 */
import { watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { errMsg } from './sessionHelpers.js';

export interface SessionFileWatcher {
  close(): void;
}

export interface SessionFileChange {
  providerSessionId: string;
  // Absolute path of the session (.jsonl) file; it may no longer exist.
  path: string;
}

export interface SessionFileWatcherOptions {
  // Watched directory; defaults to ~/.factory/sessions. Injectable for tests.
  root?: string;
  // Trailing debounce: the callback fires once after writes settle. There is
  // deliberately no maximum wait, so a continuously streaming session never
  // triggers a mid-stream reconcile of the sessions tree.
  debounceMs?: number;
  // Live in-app sessions already push their updates through the session
  // registry, so writes to their files must not trigger a reconcile.
  isLiveSession?: (providerSessionId: string) => boolean;
  // Fires with the changed session files when every event in the batch is
  // explained by them, or with null when unexplained events (a removed
  // directory tree, foreign files) require a full reconcile.
  onExternalChange: (changes: SessionFileChange[] | null) => void;
}

const SESSION_FILE_SUFFIX = '.jsonl';
const SESSION_SETTINGS_SUFFIX = '.settings.json';

// Session files are named <providerSessionId>.jsonl inside per-cwd
// directories. Anything else (directory events, unknown names) returns
// undefined and is treated as an external change.
export function sessionIdFromSessionFileName(filename: string | null): string | undefined {
  if (!filename) return undefined;
  const base = filename.split(/[\\/]/).pop() ?? '';
  if (!base.endsWith(SESSION_FILE_SUFFIX)) return undefined;
  return base.slice(0, -SESSION_FILE_SUFFIX.length);
}

// Maps a watch event name to the session it affects: a <id>.settings.json
// sidecar event maps to its <id>.jsonl session file so the reconcile
// re-reads the session with its new settings. Undefined for foreign names.
function sessionTargetFromFileName(
  filename: string | null,
): { id: string; sessionFile: string } | undefined {
  if (!filename) return undefined;
  if (filename.endsWith(SESSION_SETTINGS_SUFFIX)) {
    const sessionFile = `${filename.slice(0, -SESSION_SETTINGS_SUFFIX.length)}${SESSION_FILE_SUFFIX}`;
    const id = sessionIdFromSessionFileName(sessionFile);
    return id ? { id, sessionFile } : undefined;
  }
  const id = sessionIdFromSessionFileName(filename);
  return id ? { id, sessionFile: filename } : undefined;
}

// Returns null when the directory cannot be watched (missing root, or a
// platform without recursive fs.watch such as Linux). Live republish then
// degrades gracefully: the cache is still reconciled on the next boot.
export function startSessionFileWatcher(
  options: SessionFileWatcherOptions,
): SessionFileWatcher | null {
  const root = options.root ?? join(homedir(), '.factory', 'sessions');
  const debounceMs = options.debounceMs ?? 1500;
  // FSEvents reports a change to the watched root itself under the root's own
  // name (or '.'), not as a path inside the tree.
  const rootName = root.split(/[\\/]/).pop() ?? '';
  let timer: NodeJS.Timeout | undefined;
  // State for the batch of events inside one debounce window. Changed
  // session files are tracked individually so the callback reconciles
  // exactly those files instead of rescanning the whole sessions tree.
  // Creating a file also fires an event for its parent directory, so a
  // directory event only justifies a full reconcile when no changed file in
  // the same batch explains it.
  let pendingPaths = new Map<string, string>();
  let pendingLiveFiles: string[] = [];
  let pendingUnknown: string[] = [];
  let pendingUnexplainable = false;
  let closed = false;

  let watcher: FSWatcher;
  try {
    watcher = watch(root, { recursive: true }, (_eventType, filename) => {
      // An fs callback can race close(); never arm a new timer afterwards.
      if (closed) return;
      const target = sessionTargetFromFileName(filename);
      if (target) {
        if (options.isLiveSession?.(target.id)) pendingLiveFiles.push(target.sessionFile);
        else pendingPaths.set(target.id, target.sessionFile);
      } else if (filename) {
        pendingUnknown.push(filename);
      } else {
        pendingUnexplainable = true;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        const paths = pendingPaths;
        const unknown = pendingUnknown;
        const live = pendingLiveFiles;
        const unexplainable = pendingUnexplainable;
        pendingPaths = new Map();
        pendingUnknown = [];
        pendingLiveFiles = [];
        pendingUnexplainable = false;
        if (closed) return;
        const explains = (name: string): boolean => {
          // A change to the root itself (a per-cwd directory created or
          // removed directly under it) is explained by any changed file in
          // the batch; alone, it means a whole tree vanished and only a full
          // reconcile restores freshness.
          if (name === rootName || name === '.' || name === root) {
            return paths.size > 0 || live.length > 0;
          }
          const prefixes = [`${name}/`, `${name}\\`];
          const inside = (file: string) => prefixes.some((prefix) => file.startsWith(prefix));
          return [...paths.values()].some(inside) || live.some(inside);
        };
        // Unexplained events (a removed tree, foreign files, a lost event
        // stream) fall back to a full reconcile; anything else reconciles
        // exactly the changed files.
        if (unexplainable || unknown.some((name) => !explains(name))) {
          options.onExternalChange(null);
        } else if (paths.size > 0) {
          options.onExternalChange(
            [...paths].map(([providerSessionId, file]) => ({
              providerSessionId,
              path: join(root, file),
            })),
          );
        }
      }, debounceMs);
    });
  } catch {
    return null;
  }
  // A watcher error must never take the sidecar down; the next boot
  // reconcile still picks up every change.
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
