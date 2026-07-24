export type UtilityTool = 'review' | 'terminal' | 'browser' | 'files';

export interface UtilityTab {
  id: string;
  tool: UtilityTool;
  label: string;
  terminalId?: string;
  filePath?: string;
}

export interface UtilityPanelState {
  open: boolean;
  tabs: UtilityTab[];
  activeTabId: string | null;
}

export const CLOSED_UTILITY_PANEL: UtilityPanelState = {
  open: false,
  tabs: [],
  activeTabId: null,
};

const SINGLETON_TOOLS = new Set<UtilityTool>(['review', 'browser', 'files']);

export function utilityPanelForMission(
  panels: Record<string, UtilityPanelState>,
  missionId: string | null | undefined,
): UtilityPanelState {
  if (!missionId) return CLOSED_UTILITY_PANEL;
  return missionId in panels ? panels[missionId] : CLOSED_UTILITY_PANEL;
}

export function openUtilityTool(
  panel: UtilityPanelState | undefined,
  tool: UtilityTool,
  createId: () => string,
  details: Partial<Pick<UtilityTab, 'terminalId' | 'filePath'>> = {},
): UtilityPanelState {
  const current = panel ?? CLOSED_UTILITY_PANEL;
  const existing = SINGLETON_TOOLS.has(tool)
    ? current.tabs.find((tab) => tab.tool === tool)
    : undefined;
  if (existing) {
    return current.open && current.activeTabId === existing.id
      ? current
      : { ...current, open: true, activeTabId: existing.id };
  }
  const tab: UtilityTab = {
    id: createId(),
    tool,
    label: utilityToolLabel(tool, current.tabs),
    ...details,
  };
  return {
    open: true,
    tabs: [...current.tabs, tab],
    activeTabId: tab.id,
  };
}

export function closeUtilityTab(
  panel: UtilityPanelState | undefined,
  tabId: string,
): UtilityPanelState {
  const current = panel ?? CLOSED_UTILITY_PANEL;
  const index = current.tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) return current;
  const tabs = current.tabs.filter((tab) => tab.id !== tabId);
  if (current.activeTabId !== tabId) return { ...current, tabs };
  const fallback = tabs.length > 0 ? tabs[Math.min(index, tabs.length - 1)] : null;
  return {
    open: tabs.length > 0 && current.open,
    tabs,
    activeTabId: fallback?.id ?? null,
  };
}

export function activateUtilityTab(
  panel: UtilityPanelState | undefined,
  tabId: string,
): UtilityPanelState {
  const current = panel ?? CLOSED_UTILITY_PANEL;
  if (!current.tabs.some((tab) => tab.id === tabId)) return current;
  if (current.open && current.activeTabId === tabId) return current;
  return { ...current, open: true, activeTabId: tabId };
}

export function updateUtilityTab(
  panel: UtilityPanelState | undefined,
  tabId: string,
  details: Partial<Pick<UtilityTab, 'terminalId' | 'filePath' | 'label'>>,
): UtilityPanelState {
  const current = panel ?? CLOSED_UTILITY_PANEL;
  const index = current.tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) return current;
  const tabs = [...current.tabs];
  const nextDetails = Object.fromEntries(
    Object.entries(details as Record<string, unknown>).filter(([, value]) => value !== undefined),
  ) as Partial<UtilityTab>;
  tabs[index] = { ...tabs[index], ...nextDetails };
  return { ...current, tabs };
}

export function setUtilityPanelOpen(
  panel: UtilityPanelState | undefined,
  open: boolean,
): UtilityPanelState {
  const current = panel ?? CLOSED_UTILITY_PANEL;
  if (!open) return current.open ? { ...current, open: false } : current;
  return {
    ...current,
    open: true,
    activeTabId: current.activeTabId ?? current.tabs.at(0)?.id ?? null,
  };
}

export function removeUtilityTool(
  panel: UtilityPanelState | undefined,
  tool: UtilityTool,
): UtilityPanelState {
  const current = panel ?? CLOSED_UTILITY_PANEL;
  const tab = current.tabs.find((candidate) => candidate.tool === tool);
  return tab ? closeUtilityTab(current, tab.id) : current;
}

export function sanitizeUtilityPanels(value: unknown): Record<string, UtilityPanelState> {
  if (!isRecord(value)) return {};
  const panels: Record<string, UtilityPanelState> = {};
  for (const [missionId, rawPanel] of Object.entries(value)) {
    if (!missionId || !isRecord(rawPanel) || !Array.isArray(rawPanel.tabs)) continue;
    const seenIds = new Set<string>();
    const singletonTools = new Set<UtilityTool>();
    const tabs: UtilityTab[] = [];
    for (const rawTab of rawPanel.tabs.slice(0, 16)) {
      if (!isRecord(rawTab)) continue;
      const id = typeof rawTab.id === 'string' ? rawTab.id : '';
      const tool = isUtilityTool(rawTab.tool) ? rawTab.tool : null;
      if (!id || !tool || seenIds.has(id)) continue;
      if (tool === 'terminal') continue;
      if (SINGLETON_TOOLS.has(tool) && singletonTools.has(tool)) continue;
      seenIds.add(id);
      singletonTools.add(tool);
      const tab: UtilityTab = {
        id,
        tool,
        label:
          typeof rawTab.label === 'string' && rawTab.label.trim()
            ? rawTab.label.slice(0, 80)
            : utilityToolLabel(tool, tabs),
      };
      if (typeof rawTab.terminalId === 'string') tab.terminalId = rawTab.terminalId;
      if (typeof rawTab.filePath === 'string') tab.filePath = rawTab.filePath;
      tabs.push(tab);
    }
    const activeTabId =
      typeof rawPanel.activeTabId === 'string' &&
      tabs.some((tab) => tab.id === rawPanel.activeTabId)
        ? rawPanel.activeTabId
        : (tabs[0]?.id ?? null);
    panels[missionId] = {
      open: rawPanel.open === true && tabs.length > 0,
      tabs,
      activeTabId,
    };
  }
  return panels;
}

export function persistUtilityPanels(
  panels: Record<string, UtilityPanelState>,
): Record<string, UtilityPanelState> {
  return Object.fromEntries(
    Object.entries(panels).map(([missionId, panel]) => {
      const tabs = panel.tabs.filter((tab) => tab.tool !== 'terminal');
      const activeTabId = tabs.some((tab) => tab.id === panel.activeTabId)
        ? panel.activeTabId
        : (tabs[0]?.id ?? null);
      return [
        missionId,
        {
          open: panel.open && tabs.length > 0,
          tabs,
          activeTabId,
        },
      ];
    }),
  );
}

export function utilityTerminalCwds(
  panels: Record<string, UtilityPanelState>,
  missionCwds: Record<string, string | undefined>,
): string[] {
  return Object.entries(panels)
    .filter(([, panel]) => panel.tabs.some((tab) => tab.tool === 'terminal'))
    .map(([missionId]) => missionCwds[missionId])
    .filter((cwd): cwd is string => Boolean(cwd));
}

function utilityToolLabel(tool: UtilityTool, tabs: UtilityTab[]): string {
  if (tool !== 'terminal') return tool[0].toUpperCase() + tool.slice(1);
  const count = tabs.filter((tab) => tab.tool === 'terminal').length;
  return count === 0 ? 'Terminal' : `Terminal ${String(count + 1)}`;
}

function isUtilityTool(value: unknown): value is UtilityTool {
  return value === 'review' || value === 'terminal' || value === 'browser' || value === 'files';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
