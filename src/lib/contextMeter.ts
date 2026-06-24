// The daemon auto-compacts before the model context window fills. The context
// meter surfaces that trigger as a "Compacts at" marker: a per-model override
// wins over the global default, capped to the window.
//
// A mission reset to Default exposes no `missionModelId`, but its SDK session
// still runs the resolved orchestrator default model, whose per-model trigger
// the daemon honors. Resolving that default here keeps the marker aligned with
// the active model instead of dropping to the global default (or hiding it).
export function compactsAtMarker(
  missionModelId: string | undefined,
  defaultModelId: string | undefined,
  perModel: Record<string, number>,
  global: number | undefined,
  modelWindow: number | undefined,
): number | undefined {
  const modelId = missionModelId ?? defaultModelId;
  const override = modelId ? perModel[modelId] : undefined;
  const limit = override ?? global;
  if (!limit || limit <= 0) return undefined;
  return modelWindow && modelWindow > 0 ? Math.min(limit, modelWindow) : limit;
}
