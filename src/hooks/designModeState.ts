export type DesignModes = Record<string, boolean>;

export function isDesignModeOpen(designModes: DesignModes, appSessionId?: string): boolean {
  return appSessionId ? (designModes[appSessionId] ?? false) : false;
}

export function toggleDesignMode(designModes: DesignModes, appSessionId: string): DesignModes {
  return { ...designModes, [appSessionId]: !isDesignModeOpen(designModes, appSessionId) };
}

export function setDesignMode(
  designModes: DesignModes,
  appSessionId: string,
  open: boolean,
): DesignModes {
  return { ...designModes, [appSessionId]: open };
}

export function clearDesignMode(designModes: DesignModes, appSessionId: string): DesignModes {
  if (!(appSessionId in designModes)) return designModes;
  const { [appSessionId]: _removed, ...next } = designModes;
  return next;
}
