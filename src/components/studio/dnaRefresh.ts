export function recordSessionStreamingState(
  previousBySession: Map<string, boolean>,
  sessionId: string | null,
  streaming: boolean,
): boolean {
  if (!sessionId) return false;
  const previous = previousBySession.get(sessionId);
  previousBySession.set(sessionId, streaming);
  return previous === true && !streaming;
}
