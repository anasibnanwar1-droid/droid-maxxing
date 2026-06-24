import { useEffect, useRef, useState } from 'react';
import { gitFetch } from '../lib/git';

// Best-effort `git fetch` when a branch picker opens so branches pushed from
// elsewhere appear without leaving the app. Fires once per open (not on every
// render or poll), ignores offline/auth failures, and reports in-flight state
// so the caller can show a spinner. The callback is read through a ref so an
// unstable `onFetched` identity never re-triggers the fetch.
export function useGitFetchOnOpen(open: boolean, cwd: string, onFetched: () => void): boolean {
  const [fetching, setFetching] = useState(false);
  const cbRef = useRef(onFetched);
  cbRef.current = onFetched;

  useEffect(() => {
    if (!open || !cwd) return;
    let cancelled = false;
    setFetching(true);
    void gitFetch(cwd).then((res) => {
      if (cancelled) return;
      setFetching(false);
      if (res.ok) cbRef.current();
    });
    return () => {
      cancelled = true;
    };
  }, [open, cwd]);

  return fetching;
}
