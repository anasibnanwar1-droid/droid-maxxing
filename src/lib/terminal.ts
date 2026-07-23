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
        if (!terminal) throw new Error('This terminal process is no longer available.');
        return terminal;
      })
    : createTerminal(options);
  terminalsByTab.set(tabId, promise);
  promise.catch(() => terminalsByTab.delete(tabId));
  return promise;
}

export async function closeTerminalForTab(tabId: string, terminalId?: string): Promise<void> {
  const pending = terminalsByTab.get(tabId);
  terminalsByTab.delete(tabId);
  const id = terminalId ?? (await pending?.catch(() => undefined))?.id;
  if (id) await killTerminal(id);
}
