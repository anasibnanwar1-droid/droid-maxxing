import fs from 'node:fs';
import path from 'node:path';
import { validatorConfigFile } from '../designPaths.js';
import type { ValidatorConfig, ValidatorPage } from '../types.js';

const VIEWPORTS = new Set(['desktop', 'laptop', 'tablet', 'mobile']);

function defaultValidatorConfig(): ValidatorConfig {
  return { pages: [], viewports: ['desktop', 'mobile'] };
}

export function readValidatorConfig(cwd: string): ValidatorConfig {
  try {
    const raw = fs.readFileSync(validatorConfigFile(cwd), 'utf8');
    return normalize(JSON.parse(raw) as Record<string, unknown>);
  } catch {
    return defaultValidatorConfig();
  }
}

export function writeValidatorConfig(cwd: string, config: ValidatorConfig): ValidatorConfig {
  const normalized = normalize(config as unknown as Record<string, unknown>);
  const file = validatorConfigFile(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(normalized, null, 2), 'utf8');
  return normalized;
}

function normalize(raw: Record<string, unknown>): ValidatorConfig {
  const pages: ValidatorPage[] = Array.isArray(raw.pages)
    ? (raw.pages as Record<string, unknown>[])
        .filter((page) => typeof page.url === 'string' && page.url.trim().length > 0)
        .slice(0, 20)
        .map((page, index) => ({
          id: typeof page.id === 'string' && page.id ? page.id : `page-${index + 1}`,
          url: (page.url as string).trim(),
          label: typeof page.label === 'string' ? page.label : undefined,
        }))
    : [];
  const viewports = Array.isArray(raw.viewports)
    ? (raw.viewports as string[]).filter(
        (viewport): viewport is ValidatorConfig['viewports'][number] => VIEWPORTS.has(viewport),
      )
    : [];
  return {
    pages,
    viewports: viewports.length > 0 ? viewports : ['desktop', 'mobile'],
    fixPrompt: typeof raw.fixPrompt === 'string' ? raw.fixPrompt : undefined,
    runAfterDesignPrompt: raw.runAfterDesignPrompt === true,
  };
}
