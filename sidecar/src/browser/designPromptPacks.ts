import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { browserDesignReferenceDir } from './browserPaths.js';
import type { DesignPromptPack, DesignReference } from './types.js';

export interface WriteDesignPromptPackOptions {
  missionId: string;
  browserSessionId: string;
  instruction: string;
  references: DesignReference[];
  baseDir?: string;
  now?: () => Date;
}

export async function writeDesignPromptPack(options: WriteDesignPromptPackOptions): Promise<{ pack: DesignPromptPack; path: string }> {
  const createdAt = (options.now?.() ?? new Date()).toISOString();
  const pack: DesignPromptPack = {
    missionId: options.missionId,
    browserSessionId: options.browserSessionId,
    createdAt,
    instruction: options.instruction,
    references: options.references,
  };
  const dir = browserDesignReferenceDir(options.missionId, options.baseDir);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `pack-${createdAt.replace(/[:.]/g, '-')}.json`);
  await writeFile(path, `${JSON.stringify(pack, null, 2)}\n`, 'utf8');
  return { pack, path };
}

export function formatDesignPrompt(packPath: string, instruction: string, references: DesignReference[]): string {
  const first = references[0];
  return [
    'Design Mode reference pack:',
    `- URL: ${first?.url ?? 'about:blank'}`,
    `- Screenshot: ${first?.screenshotPath ?? 'none'}`,
    `- References JSON: ${packPath}`,
    '',
    'User instruction:',
    instruction,
  ].join('\n');
}
