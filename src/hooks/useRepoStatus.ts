import { useEffect, useState } from 'react';
import { getRepoStatus } from '../lib/desktop';
import type { RepoStatus } from '../lib/repoEnvironment';

export function useRepoStatus(cwd: string): RepoStatus | null | undefined {
  const [status, setStatus] = useState<RepoStatus | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void getRepoStatus(cwd).then((next) => {
        if (!cancelled) setStatus(next);
      });
    };

    setStatus(undefined);
    if (!cwd) {
      setStatus(null);
      return;
    }
    refresh();
    const interval = window.setInterval(refresh, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [cwd]);

  return status;
}
