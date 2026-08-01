import { auditElements } from './audit.js';
import type {
  AuditElement,
  DesignTokens,
  ValidatorConfig,
  ValidatorFinding,
  ValidatorReport,
} from '../types.js';

export interface ValidatorBrowser {
  open(url: string): Promise<void>;
  setViewportMode(mode: string): Promise<void>;
  audit(): Promise<AuditElement[]>;
}

export interface ValidatorProgress {
  pageId: string;
  viewport: string;
  completed: number;
  total: number;
}

export interface RunValidatorOptions {
  cwd: string;
  config: ValidatorConfig;
  tokens: DesignTokens;
  browser: ValidatorBrowser;
  onProgress?: (progress: ValidatorProgress) => void;
  signal?: AbortSignal;
}

export async function runValidator(options: RunValidatorOptions): Promise<ValidatorReport> {
  const { cwd, config, tokens, browser, onProgress, signal } = options;
  const startedAt = new Date().toISOString();
  const findings: ValidatorFinding[] = [];
  const total = config.pages.length * config.viewports.length;
  let completed = 0;
  let pagesAudited = 0;
  let elementsAudited = 0;

  for (const page of config.pages) {
    let opened = false;
    for (const viewport of config.viewports) {
      signal?.throwIfAborted();
      onProgress?.({ pageId: page.id, viewport, completed, total });
      try {
        await browser.setViewportMode(viewport);
        signal?.throwIfAborted();
        if (!opened) {
          await browser.open(page.url);
          signal?.throwIfAborted();
          opened = true;
        }
        const elements = await browser.audit();
        signal?.throwIfAborted();
        elementsAudited += elements.length;
        findings.push(...auditElements(elements, tokens, { pageId: page.id, viewport }));
      } catch (error) {
        signal?.throwIfAborted();
        findings.push({
          id: `${page.id}-${viewport}-audit-error`,
          rule: 'off-palette-color',
          severity: 'warning',
          pageId: page.id,
          viewport,
          selector: 'page',
          label: page.label ?? page.url,
          property: 'audit',
          actual: error instanceof Error ? error.message : 'Audit failed.',
          expected: 'page reachable and auditable',
        });
      }
      completed += 1;
    }
    if (opened) pagesAudited += 1;
  }

  return {
    cwd,
    startedAt,
    finishedAt: new Date().toISOString(),
    pagesAudited,
    elementsAudited,
    findings,
  };
}

export function formatFindingsPrompt(report: ValidatorReport, prefix?: string): string {
  const lines: string[] = [];
  lines.push(prefix?.trim() || 'Fix these design-system violations found by the style validator.');
  lines.push('Change only what each finding names; do not restyle unrelated elements.');
  lines.push('');
  for (const finding of report.findings.slice(0, 40)) {
    lines.push(
      `- [${finding.severity}] ${finding.rule} on ${finding.label} (${finding.selector}) ` +
        `at ${finding.pageId}/${finding.viewport}: ${finding.property} is ${finding.actual}, ` +
        `expected ${finding.expected}.`,
    );
  }
  if (report.findings.length > 40) {
    lines.push(`- ...and ${report.findings.length - 40} more findings.`);
  }
  return lines.join('\n');
}
