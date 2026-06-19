// A snapshot of the app shell's layout/navigation state, captured on change so
// the error boundary and main-process crash handlers can report what the UI was
// doing when it blanked (issue #38).
export interface ShellDiagnostics {
  activeMissionId: string | null;
  view: 'mission' | 'chat' | 'none';
  sidebarCollapsed: boolean;
  rightPanelOpen: boolean;
  browserOpen: boolean;
  browserPaneWidth: number;
  selectedAgentSessionId: string | null;
}

let current: ShellDiagnostics | null = null;

export function recordShellDiagnostics(snapshot: ShellDiagnostics): void {
  current = snapshot;
}

export function readShellDiagnostics(): ShellDiagnostics | null {
  return current;
}
