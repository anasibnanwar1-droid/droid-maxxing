import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { ModelInfo, ReasoningEffort } from './protocol.js';

const execFileAsync = promisify(execFile);
const CACHE_PATH = join(homedir(), '.factory', 'droid-control', 'model-catalog.json');

type Section = 'available' | 'custom' | 'details' | null;

export async function readDroidCliModelCatalog(droidPath: string): Promise<ModelInfo[]> {
  const { stdout } = await execFileAsync(droidPath, ['exec', '--help'], {
    maxBuffer: 1024 * 1024,
    env: process.env,
  });
  const models = parseDroidExecHelp(stdout);
  writeDroidCliModelCatalogCache(droidPath, models);
  return models;
}

export function readDroidCliModelCatalogCache(droidPath: string): ModelInfo[] {
  try {
    if (!existsSync(CACHE_PATH)) return [];
    const raw = JSON.parse(readFileSync(CACHE_PATH, 'utf8')) as Record<string, unknown>;
    if (raw.version !== 1 || raw.droidPath !== droidPath || !Array.isArray(raw.models)) return [];
    return raw.models.map(modelInfoValue).filter((model): model is ModelInfo => Boolean(model));
  } catch {
    return [];
  }
}

function writeDroidCliModelCatalogCache(droidPath: string, models: ModelInfo[]): void {
  try {
    mkdirSync(dirname(CACHE_PATH), { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify({ version: 1, droidPath, updatedAt: Date.now(), models }), 'utf8');
  } catch {
    /* cache is best-effort */
  }
}

export function parseDroidExecHelp(help: string): ModelInfo[] {
  const models = new Map<string, ModelInfo>();
  const idsByDisplayName = new Map<string, string[]>();
  let section: Section = null;

  for (const line of help.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === 'Available Models:') {
      section = 'available';
      continue;
    }
    if (trimmed === 'Custom Models:') {
      section = 'custom';
      continue;
    }
    if (trimmed === 'Model details:') {
      section = 'details';
      continue;
    }
    if (trimmed === 'Authentication:') break;
    if (!trimmed) continue;

    if (section === 'available' || section === 'custom') {
      const parsed = parseModelLine(line, section === 'custom');
      if (!parsed) continue;
      models.set(parsed.id, parsed);
      const names = idsByDisplayName.get(parsed.displayName) ?? [];
      names.push(parsed.id);
      idsByDisplayName.set(parsed.displayName, names);
      continue;
    }

    if (section === 'details') {
      const detail = parseDetailLine(trimmed);
      if (!detail) continue;
      const ids = idsByDisplayName.get(detail.displayName) ?? [];
      for (const id of ids) {
        const model = models.get(id);
        if (!model) continue;
        models.set(id, {
          ...model,
          supportedReasoningEfforts: detail.supportedReasoningEfforts,
          defaultReasoningEffort: detail.defaultReasoningEffort,
        });
      }
    }
  }

  return enrichCustomModelReasoning([...models.values()]);
}

function parseModelLine(line: string, isCustom: boolean): ModelInfo | null {
  const match = line.match(/^\s{2,}(\S+)\s{2,}(.+?)\s*$/);
  if (!match) return null;
  const id = match[1];
  const isDefault = /\s+\(default\)$/.test(match[2]);
  const displayName = stripDefaultSuffix(match[2]);
  return {
    id,
    displayName,
    provider: providerFor(id, displayName, isCustom),
    isCustom,
    isDefault,
  };
}

function parseDetailLine(line: string): Pick<ModelInfo, 'displayName' | 'supportedReasoningEfforts' | 'defaultReasoningEffort'> | null {
  const match = line.match(/^-\s+(.+?):\s+supports reasoning:\s+\w+;\s+supported:\s+\[([^\]]*)\];\s+default:\s+(\S+)/);
  if (!match) return null;
  return {
    displayName: match[1].trim(),
    supportedReasoningEfforts: match[2]
      .split(',')
      .map((value) => parseReasoning(value.trim()))
      .filter((value): value is ReasoningEffort => Boolean(value)),
    defaultReasoningEffort: parseReasoning(match[3]),
  };
}

function stripDefaultSuffix(value: string): string {
  return value.replace(/\s+\(default\)$/, '').trim();
}

function parseReasoning(value: string): ReasoningEffort | undefined {
  if (
    value === 'off' ||
    value === 'none' ||
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max' ||
    value === 'dynamic'
  ) {
    return value;
  }
  return undefined;
}

function modelInfoValue(value: unknown): ModelInfo | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const id = stringValue(raw.id);
  const displayName = stringValue(raw.displayName);
  if (!id || !displayName) return undefined;
  const supportedReasoningEfforts = Array.isArray(raw.supportedReasoningEfforts)
    ? raw.supportedReasoningEfforts.map((item) => parseReasoning(String(item))).filter((item): item is ReasoningEffort => Boolean(item))
    : undefined;
  return {
    id,
    displayName,
    provider: stringValue(raw.provider),
    isCustom: raw.isCustom === true,
    isDefault: raw.isDefault === true,
    maxContextTokens: numberValue(raw.maxContextTokens),
    supportedReasoningEfforts: supportedReasoningEfforts?.length ? supportedReasoningEfforts : undefined,
    defaultReasoningEffort: raw.defaultReasoningEffort ? parseReasoning(String(raw.defaultReasoningEffort)) : undefined,
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function providerFor(id: string, displayName: string, isCustom: boolean): string {
  const hay = `${id} ${displayName}`.toLowerCase();
  if (isCustom) return 'custom';
  if (displayName.startsWith('Droid Core')) return 'droid-core';
  if (hay.includes('claude') || hay.includes('opus') || hay.includes('sonnet') || hay.includes('haiku')) return 'anthropic';
  if (hay.includes('gpt') || hay.includes('codex')) return 'openai';
  if (hay.includes('gemini')) return 'google';
  return 'factory';
}

function enrichCustomModelReasoning(models: ModelInfo[]): ModelInfo[] {
  const baseById = new Map(models.filter((model) => !model.isCustom).map((model) => [model.id, model]));
  const customBaseById = readCustomModelBaseIds();
  return models.map((model) => {
    if (!model.isCustom || model.supportedReasoningEfforts?.length) return model;
    const baseId = customBaseById.get(model.id);
    const base = baseId ? baseById.get(baseId) : undefined;
    if (!base) return model;
    return {
      ...model,
      supportedReasoningEfforts: base.supportedReasoningEfforts,
      defaultReasoningEffort: base.defaultReasoningEffort,
    };
  });
}

function readCustomModelBaseIds(): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const path = join(homedir(), '.factory', 'settings.json');
    if (!existsSync(path)) return map;
    const settings = JSON.parse(readFileSync(path, 'utf8')) as { customModels?: unknown[] };
    if (!Array.isArray(settings.customModels)) return map;
    for (const item of settings.customModels) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      if (typeof record.id === 'string' && typeof record.model === 'string') map.set(record.id, record.model);
    }
  } catch {
    return map;
  }
  return map;
}
