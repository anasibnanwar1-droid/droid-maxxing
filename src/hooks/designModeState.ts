export type DesignModes = Record<string, boolean>;

export function isDesignModeOpen(designModes: DesignModes, missionId?: string): boolean {
  return missionId ? designModes[missionId] ?? false : false;
}

export function toggleDesignMode(designModes: DesignModes, missionId: string): DesignModes {
  return { ...designModes, [missionId]: !isDesignModeOpen(designModes, missionId) };
}

export function setDesignMode(designModes: DesignModes, missionId: string, open: boolean): DesignModes {
  return { ...designModes, [missionId]: open };
}

export function clearDesignMode(designModes: DesignModes, missionId: string): DesignModes {
  if (!(missionId in designModes)) return designModes;
  const { [missionId]: _removed, ...next } = designModes;
  return next;
}
