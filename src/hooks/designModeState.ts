export type DesignModes = Record<string, boolean>;

export function isDesignModeOpen(designModes: DesignModes, sessionId?: string): boolean {
  return sessionId ? (designModes[sessionId] ?? false) : false;
}

export function toggleDesignMode(designModes: DesignModes, sessionId: string): DesignModes {
  return { ...designModes, [sessionId]: !isDesignModeOpen(designModes, sessionId) };
}

export function setDesignMode(
  designModes: DesignModes,
  sessionId: string,
  open: boolean,
): DesignModes {
  return { ...designModes, [sessionId]: open };
}

export function clearDesignMode(designModes: DesignModes, sessionId: string): DesignModes {
  if (!(sessionId in designModes)) return designModes;
  const { [sessionId]: _removed, ...next } = designModes;
  return next;
}
