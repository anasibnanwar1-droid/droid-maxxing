import { useEffect, useRef } from 'react';
import { bridge } from '../lib/bridge';
import { listSessions } from '../lib/commands';
import { getApiKey } from '../lib/desktop';

export function useBridgeSessionBootstrap(embedded: boolean, workspaceCwds: string[]): void {
  const workspacesRef = useRef(workspaceCwds);
  workspacesRef.current = workspaceCwds;

  useEffect(() => {
    if (embedded) return;
    const unsubscribe = bridge.subscribeOpen(async () => {
      const key = await getApiKey();
      return [
        { type: 'connect', apiKey: key ?? '' },
        { type: 'settings.defaults' },
        {
          type: 'sessions.list',
          workspaceCwds: workspacesRef.current,
          includePlainChats: true,
        },
      ];
    });
    void bridge.start();
    return unsubscribe;
  }, [embedded]);

  useEffect(() => {
    if (embedded || !bridge.isOpen()) return;
    listSessions({ workspaceCwds, includePlainChats: true });
  }, [embedded, workspaceCwds]);
}
