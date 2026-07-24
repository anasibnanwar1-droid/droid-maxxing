import { createTerminal, killTerminal, listTerminals, type TerminalSessionInfo } from './desktop';

const terminalsByTab = new Map<string, Promise<TerminalSessionInfo>>();

export function ensureTerminalForTab(
  tabId: string,
  existingId: string | undefined,
  options: { missionId: string; cwd: string; cols: number; rows: number },
): Promise<TerminalSessionInfo> {
  const pending = terminalsByTab.get(tabId);
  if (pending) return pending;
  const promise = existingId
    ? listTerminals(options.missionId).then((terminals) => {
        const terminal = terminals.find((candidate) => candidate.id === existingId);
        return terminal ?? createTerminal(options);
      })
    : createTerminal(options);
  terminalsByTab.set(tabId, promise);
  const release = () => {
    if (terminalsByTab.get(tabId) === promise) terminalsByTab.delete(tabId);
  };
  void promise.then(release, release);
  return promise;
}

export async function closeTerminalForTab(tabId: string, terminalId?: string): Promise<void> {
  const pending = terminalsByTab.get(tabId);
  terminalsByTab.delete(tabId);
  const id = terminalId ?? (await pending?.catch(() => undefined))?.id;
  if (id) await killTerminal(id);
}
