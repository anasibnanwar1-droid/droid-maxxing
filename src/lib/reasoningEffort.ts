import type { ModelInfo, ReasoningEffort } from '../types/bridge';

// Shared rule for the reasoning effort shown next to a model (composer badge
// and context-panel pill): the session's pinned effort wins, the global
// default is the fallback, and a model known to support no reasoning efforts
// hides the indicator entirely. An unknown model (list still loading) keeps
// showing the effort so the indicator does not flicker out and back in.
export function resolveReasoningEffortDisplay(
  sessionEffort: ReasoningEffort | undefined,
  globalDefault: ReasoningEffort | undefined,
  model: Pick<ModelInfo, 'supportedReasoningEfforts'> | undefined,
): ReasoningEffort | undefined {
  const effort = sessionEffort ?? globalDefault;
  if (effort === undefined) return undefined;
  if (model && (model.supportedReasoningEfforts?.length ?? 0) === 0) return undefined;
  return effort;
}
