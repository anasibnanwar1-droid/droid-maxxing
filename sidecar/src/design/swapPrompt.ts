import { sanitizeInline } from '../browser/designPromptPacks.js';
import type { ComponentRegistryEntry, DesignLibraryItem } from './types.js';

const SWAP_PROMPT_HEADER = 'Design swap request:';

interface SwapTarget {
  label: string;
  selector?: string;
  file?: string;
  line?: number;
  component?: string;
}

export type SwapReplacement =
  | { kind: 'component'; entry: ComponentRegistryEntry }
  | { kind: 'reference'; item: DesignLibraryItem };

type SwapStrategy = 'preserve-api' | 'exact-copy';

export interface SwapPromptInput {
  target: SwapTarget;
  replacement: SwapReplacement;
  strategy: SwapStrategy;
  note?: string;
}

export function formatSwapPrompt(input: SwapPromptInput): string {
  const { target, replacement, strategy } = input;
  const lines: string[] = [SWAP_PROMPT_HEADER];

  lines.push(`- Target: ${sanitizeInline(target.label)}`);
  if (target.selector) lines.push(`- Target selector: ${sanitizeInline(target.selector)}`);
  if (target.component) lines.push(`- Target component: ${sanitizeInline(target.component)}`);
  if (target.file) {
    lines.push(
      `- Target source: ${sanitizeInline(target.file)}${target.line ? `:${target.line}` : ''}`,
    );
  }

  if (replacement.kind === 'component') {
    const entry = replacement.entry;
    lines.push(`- Replacement component: ${sanitizeInline(entry.name)}`);
    lines.push(`- Replacement source: ${sanitizeInline(entry.file)}:${entry.line}`);
    if (entry.props) lines.push(`- Replacement signature: ${sanitizeInline(entry.props)}`);
  } else {
    const item = replacement.item;
    lines.push(
      `- Replacement reference: ${sanitizeInline(item.name)} (from ${sanitizeInline(item.url)})`,
    );
    if (item.screenshotPath)
      lines.push(`- Reference screenshot: ${sanitizeInline(item.screenshotPath)}`);
    if (item.styles && Object.keys(item.styles).length > 0) {
      const styles = Object.entries(item.styles)
        .map(([key, value]) => `${key}=${value}`)
        .join('; ');
      lines.push(`- Reference styles: ${sanitizeInline(styles, 800)}`);
    }
    if (item.html)
      lines.push(
        `- Reference markup is captured in the library item; recreate its look, not its exact DOM.`,
      );
  }

  lines.push('');
  lines.push('Contract:');
  if (strategy === 'preserve-api') {
    lines.push(
      "- Preserve the target's public API exactly: props, emitted events, accessibility roles, and data hooks (data-testid, aria-*).",
    );
    lines.push('- Only the visual presentation may change. Callers must not need edits.');
  } else {
    lines.push("- Recreate the replacement's look as closely as possible at the target location.");
    lines.push(
      '- Keep existing behavior wired up: handlers, links, and form semantics stay intact.',
    );
  }
  lines.push(
    '- Change only the target and the styles it owns. Do not restyle unrelated components.',
  );
  lines.push(
    "- After the swap, run the app mentally through the target's states: default, hover, focus, disabled, loading.",
  );

  if (input.note?.trim()) {
    lines.push('');
    lines.push('User note:');
    lines.push(input.note.trim());
  }
  return lines.join('\n');
}
