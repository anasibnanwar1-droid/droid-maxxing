import { useEffect, useRef, useState } from 'react';
import { getRepoStatus } from '../lib/desktop';
import type { RepoStatus } from '../lib/repoEnvironment';

export function isCurrentRepoStatusRequest(requestId: number, latestRequestId: number): boolean {
  return requestId === latestRequestId;
}

export function useRepoStatus(cwd: string): RepoStatus | null | undefined {
  const [status, setStatus] = useState<RepoStatus | null | undefined>(undefined);
  const requestRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      const requestId = ++requestRef.current;
      void getRepoStatus(cwd).then((next) => {
        if (!cancelled && isCurrentRepoStatusRequest(requestId, requestRef.current)) setStatus(next);
      });
    };

    setStatus(undefined);
    if (!cwd) {
      requestRef.current += 1;
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
