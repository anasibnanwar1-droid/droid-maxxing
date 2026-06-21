// Builds the prompt text actually sent to a mission from the raw user input plus
// the selected skills and @file mentions. Shared so the optimistic echo dedup
// can reconstruct the same composed string that gets persisted to history.
export function composePrompt(text: string, skillNames: string[], files: string[]): string {
  const parts: string[] = [];
  if (skillNames.length === 1) parts.push(`Use the "${skillNames[0]}" skill.`);
  else if (skillNames.length > 1)
    parts.push(`Use these skills: ${skillNames.map((s) => `"${s}"`).join(', ')}.`);
  if (text) parts.push(text);
  let composed = parts.join('\n\n');
  if (files.length) {
    const mentions = files.map((f) => `@${f}`).join(' ');
    composed = composed ? `${composed}\n\n${mentions}` : mentions;
  }
  return composed;
}
