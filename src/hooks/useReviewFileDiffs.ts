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

// Lazily loads and caches the diff for each expanded file section in the Review
// tab. A hard context change (cwd/scope/whitespace) clears the cache; a soft
// change (the file-list signature after an edit) only allows a refetch while
// keeping the last diff on screen, so an idle poll never blanks an open
// section. Stale in-flight responses are dropped by comparing generations.
export function useReviewFileDiffs(
  cwd: string,
  scope: DiffScope,
  ignoreWhitespace: boolean,
  signature: string,
): ReviewFileDiffs {
  const [entries, setEntries] = useState<Record<string, FileDiffEntry>>({});
  const status = useRef<Record<string, 'loading' | 'loaded'>>({});
  const gen = useRef(0);

  const hardKey = `${cwd}\u0000${scope}\u0000${ignoreWhitespace}`;
  const hardRef = useRef(hardKey);
  const sigRef = useRef(signature);

  // Adjust cache state during render (the supported React pattern for resetting
  // when inputs change) so a fresh generation is in effect before any effect
  // calls ensure() this commit.
  if (hardRef.current !== hardKey) {
    hardRef.current = hardKey;
    sigRef.current = signature;
    status.current = {};
    gen.current += 1;
    setEntries({});
  } else if (sigRef.current !== signature) {
    sigRef.current = signature;
    status.current = {};
    gen.current += 1;
    // Keep existing entries visible; ensure() refetches and overwrites in place.
  }

  const ensure = useCallback(
    (path: string) => {
      if (status.current[path]) return;
      status.current[path] = 'loading';
      const requestGen = gen.current;
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
      getGitFileDiff(cwd, scope, path, ignoreWhitespace)
        .then((res) => {
          if (gen.current !== requestGen) return;
          status.current[path] = 'loaded';
          setEntries((cur) => ({
            ...cur,
            [path]: { diff: res.diff, binary: res.binary, loading: false, loaded: true },
          }));
        })
        .catch(() => {
          if (gen.current !== requestGen) return;
          status.current[path] = 'loaded';
          setEntries((cur) => ({
            ...cur,
            [path]: { diff: '', binary: false, loading: false, loaded: true },
          }));
        });
    },
    [cwd, scope, ignoreWhitespace],
  );

  return { entries, ensure };
}
