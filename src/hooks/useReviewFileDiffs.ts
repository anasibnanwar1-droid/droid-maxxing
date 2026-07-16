import { useCallback, useRef, useState } from 'react';
import { getGitFileDiff } from '../lib/git';
import type { DiffScope } from '../types/vcs';

export interface FileDiffEntry {
  diff: string;
  binary: boolean;
  loading: boolean;
  loaded: boolean;
}

export interface ReviewFileDiffs {
  entries: Record<string, FileDiffEntry>;
  ensure: (path: string) => void;
}

// Split the list signature (one `path:status:additions:deletions` line per
// file, as built by useReviewDiff) into a per-file map so a soft change can
// invalidate only the files that actually changed. The status/adds/dels tail
// never contains ":", so the greedy path group tolerates ":" in paths.
function parseSignature(signature: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of signature.split('\n')) {
    if (!line) continue;
    const m = /^(.*):([^:]*:\d+:\d+)$/.exec(line);
    if (m) map.set(m[1], m[2]);
    else map.set(line, '');
  }
  return map;
}

// Lazily loads and caches the diff for each expanded file section in the Review
// tab. A cwd change clears the cache outright; a scope/whitespace change
// invalidates every file but keeps the last diffs on screen while ensure()
// refetches, so toggling scope doesn't blank the expanded sections; a soft
// change (the file-list signature after an edit) invalidates only the files
// whose own signature line changed, so one edited file does not refetch every
// expanded section. Stale in-flight responses are dropped by comparing
// generations (global for resets, per-file for soft ones).
export function useReviewFileDiffs(
  cwd: string,
  scope: DiffScope,
  ignoreWhitespace: boolean,
  signature: string,
  sessionId?: string,
): ReviewFileDiffs {
  const [entries, setEntries] = useState<Record<string, FileDiffEntry>>({});
  // A Map avoids the Object.prototype lookup collision that lets a file path
  // like `__proto__` or `constructor` bypass the cache check
  // (`status.current['__proto__']` returns the prototype, which is truthy),
  // causing expanded sections to refetch their diff on every render.
  const status = useRef<Map<string, 'loading' | 'loaded'>>(new Map());
  const gen = useRef(0);
  const fileGen = useRef<Map<string, number>>(new Map());

  const hardKey = `${cwd}\u0000${scope}\u0000${ignoreWhitespace}`;
  const hardRef = useRef(hardKey);
  const cwdRef = useRef(cwd);
  const sigRef = useRef(signature);

  // Adjust cache state during render (the supported React pattern for resetting
  // when inputs change) so a fresh generation is in effect before any effect
  // calls ensure() this commit.
  if (hardRef.current !== hardKey) {
    const cwdChanged = cwdRef.current !== cwd;
    hardRef.current = hardKey;
    cwdRef.current = cwd;
    sigRef.current = signature;
    status.current.clear();
    fileGen.current.clear();
    gen.current += 1;
    // Another repo's diffs must never linger; within the same repo, keep the
    // stale diffs visible while ensure() refetches under the new scope or
    // whitespace setting.
    if (cwdChanged) setEntries({});
  } else if (sigRef.current !== signature) {
    const prev = parseSignature(sigRef.current);
    const next = parseSignature(signature);
    sigRef.current = signature;
    // Keep existing entries visible; ensure() refetches and overwrites in
    // place. Files whose line vanished also drop their status so a later
    // reappearance refetches instead of serving the stale diff.
    for (const path of status.current.keys()) {
      if (next.get(path) !== prev.get(path)) {
        status.current.delete(path);
        fileGen.current.set(path, (fileGen.current.get(path) ?? 0) + 1);
      }
    }
  }

  const ensure = useCallback(
    (path: string) => {
      if (status.current.get(path)) return;
      status.current.set(path, 'loading');
      const requestGen = gen.current;
      const requestFileGen = fileGen.current.get(path) ?? 0;
      const stale = () =>
        gen.current !== requestGen || (fileGen.current.get(path) ?? 0) !== requestFileGen;
      setEntries((cur) => {
        const prev = cur[path];
        return {
          ...cur,
          [path]: {
            diff: prev?.diff ?? '',
            binary: prev?.binary ?? false,
            loading: true,
            loaded: prev?.loaded ?? false,
          },
        };
      });
      getGitFileDiff(cwd, scope, path, ignoreWhitespace, sessionId)
        .then((res) => {
          if (stale()) return;
          status.current.set(path, 'loaded');
          setEntries((cur) => ({
            ...cur,
            [path]: { diff: res.diff, binary: res.binary, loading: false, loaded: true },
          }));
        })
        .catch(() => {
          // getGitFileDiff catches internally and never rejects, but guard
          // against a future contract change so an open section doesn't hang.
          if (stale()) return;
          status.current.set(path, 'loaded');
          setEntries((cur) => ({
            ...cur,
            [path]: { diff: '', binary: false, loading: false, loaded: true },
          }));
        });
    },
    [cwd, scope, ignoreWhitespace, sessionId],
  );

  return { entries, ensure };
}
