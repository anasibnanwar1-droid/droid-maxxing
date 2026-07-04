import type { BrowserSessionManager } from '../browser/BrowserSessionManager.js';
import { VIEWPORT_PRESETS } from '../browser/BrowserSessionManager.js';
import type { BrowserViewportMode } from '../browser/types.js';
import type { ClientCommand, ServerEvent } from '../protocol.js';
import { dnaFilePath, readDnaState, writeDnaFile } from './dnaFiles.js';
import { getDnaLibrary, listDnaLibraries } from './dnaLibraries.js';
import { scanRepoForDna } from './dnaScan.js';
import { commitDesignChange } from './gitCommit.js';
import { listPrototypes } from './prototypes.js';
import {
  deleteLibraryItem,
  getLibraryItem,
  listLibraryItems,
  saveReference,
} from './referenceLibrary.js';
import { extractTokensFromItem } from './referenceExtract.js';
import { scanComponentRegistry } from './registryScan.js';
import { formatSwapPrompt, type SwapReplacement } from './swapPrompt.js';
import type { ValidatorReport } from './types.js';
import { readValidatorConfig, writeValidatorConfig } from './validator/config.js';
import { formatFindingsPrompt, runValidator, type ValidatorBrowser } from './validator/runner.js';

export interface DesignManagerOptions {
  emit: (event: ServerEvent) => void;
  browsers: BrowserSessionManager;
  sendPrompt: (missionId: string, prompt: string) => Promise<void>;
}

type DesignCommand = Extract<ClientCommand, { type: `design.${string}` }>;

export class DesignManager {
  private readonly lastReports = new Map<string, ValidatorReport>();
  private validatorRunning = false;

  constructor(private readonly options: DesignManagerOptions) {}

  isDesignCommand(cmd: ClientCommand): cmd is DesignCommand {
    return cmd.type.startsWith('design.');
  }

  async handle(cmd: DesignCommand): Promise<void> {
    try {
      await this.dispatch(cmd);
    } catch (error) {
      this.options.emit({
        type: 'design.error',
        cwd: 'cwd' in cmd ? cmd.cwd : undefined,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Injected into Design Mode prompts so agents read the project DNA before
  // touching UI code.
  // A tiny, prompt-cache-friendly pointer — not the DNA contents. Values are
  // pulled on demand through the design_system/design_dna MCP tool so a large
  // DESIGN.md never rides in every prompt (avoids context rot).
  dnaPromptLines(cwd: string): string[] {
    const state = readDnaState(cwd);
    const lines: string[] = [];
    if (state.design.exists) {
      lines.push(
        `- This project has a Design DNA at ${state.design.path}. Pull exact token values on demand with the design_system tool; do not paste the whole file into context.`,
      );
    }
    if (state.motion.exists) {
      lines.push(`- Motion rules live in ${state.motion.path}; consult them for timing and easing.`);
    }
    if (lines.length === 0) return [];
    return ['Project design DNA:', ...lines];
  }

  lastReport(cwd: string): ValidatorReport | undefined {
    return this.lastReports.get(cwd);
  }

  private async dispatch(cmd: DesignCommand): Promise<void> {
    switch (cmd.type) {
      case 'design.dna.read':
        this.emitDnaState(cmd.cwd);
        return;
      case 'design.dna.write':
        writeDnaFile(cmd.cwd, cmd.file, cmd.content);
        this.emitDnaState(cmd.cwd);
        return;
      case 'design.dna.scan':
        this.options.emit({ type: 'design.dna.draft', draft: scanRepoForDna(cmd.cwd) });
        return;
      case 'design.dna.libraries':
        this.options.emit({ type: 'design.dna.libraries', libraries: listDnaLibraries() });
        return;
      case 'design.dna.applyLibrary': {
        const library = getDnaLibrary(cmd.libraryId);
        if (!library) throw new Error(`Unknown DNA library: ${cmd.libraryId}`);
        writeDnaFile(cmd.cwd, 'design', library.design);
        writeDnaFile(cmd.cwd, 'motion', library.motion);
        this.emitDnaState(cmd.cwd);
        return;
      }
      case 'design.validator.readConfig':
        this.options.emit({
          type: 'design.validator.config',
          cwd: cmd.cwd,
          config: readValidatorConfig(cmd.cwd),
        });
        return;
      case 'design.validator.writeConfig':
        this.options.emit({
          type: 'design.validator.config',
          cwd: cmd.cwd,
          config: writeValidatorConfig(cmd.cwd, cmd.config),
        });
        return;
      case 'design.validator.run':
        await this.runValidator(cmd.cwd, cmd.missionId);
        return;
      case 'design.validator.fix': {
        const report = this.lastReports.get(cmd.cwd);
        if (!report || report.findings.length === 0) {
          throw new Error('Run the validator first; there are no findings to fix.');
        }
        const config = readValidatorConfig(cmd.cwd);
        await this.options.sendPrompt(
          cmd.missionId,
          formatFindingsPrompt(report, config.fixPrompt),
        );
        return;
      }
      case 'design.library.list':
        this.emitLibraryState(cmd.cwd);
        return;
      case 'design.library.save': {
        const reference = this.options.browsers.referenceDetail(cmd.missionId, cmd.referenceId);
        if (!reference) throw new Error('Browser reference not found; reselect the element.');
        const items = saveReference({
          cwd: cmd.cwd,
          reference,
          name: cmd.name,
          note: cmd.note,
        });
        this.options.emit({ type: 'design.library.state', cwd: cmd.cwd, items });
        return;
      }
      case 'design.library.delete':
        this.options.emit({
          type: 'design.library.state',
          cwd: cmd.cwd,
          items: deleteLibraryItem(cmd.cwd, cmd.id),
        });
        return;
      case 'design.library.extract': {
        const item = getLibraryItem(cmd.cwd, cmd.id);
        if (!item) throw new Error('Library item not found.');
        const extracted = extractTokensFromItem(item);
        this.options.emit({
          type: 'design.library.extracted',
          cwd: cmd.cwd,
          id: cmd.id,
          tokens: extracted.tokens,
          summary: extracted.summary,
        });
        return;
      }
      case 'design.prototypes.list':
        this.options.emit({
          type: 'design.prototypes.state',
          cwd: cmd.cwd,
          prototypes: listPrototypes(cmd.cwd),
        });
        return;
      case 'design.registry.scan':
        this.options.emit({
          type: 'design.registry.state',
          cwd: cmd.cwd,
          components: scanComponentRegistry(cmd.cwd),
        });
        return;
      case 'design.swap': {
        const replacement = this.resolveReplacement(cmd.cwd, cmd.replacement);
        const prompt = formatSwapPrompt({
          target: cmd.target,
          replacement,
          strategy: cmd.strategy,
          note: cmd.note,
        });
        await this.options.sendPrompt(cmd.missionId, prompt);
        return;
      }
      case 'design.git.commit': {
        const result = await commitDesignChange(cmd.cwd, cmd.message);
        this.options.emit({ type: 'design.git.committed', cwd: cmd.cwd, ...result });
        return;
      }
    }
  }

  private emitDnaState(cwd: string): void {
    this.options.emit({ type: 'design.dna.state', state: readDnaState(cwd) });
  }

  private emitLibraryState(cwd: string): void {
    this.options.emit({ type: 'design.library.state', cwd, items: listLibraryItems(cwd) });
  }

  private resolveReplacement(
    cwd: string,
    ref: Extract<DesignCommand, { type: 'design.swap' }>['replacement'],
  ): SwapReplacement {
    if (ref.kind === 'reference') {
      const item = getLibraryItem(cwd, ref.id);
      if (!item) throw new Error('Replacement library item not found.');
      return { kind: 'reference', item };
    }
    const entry = scanComponentRegistry(cwd).find(
      (candidate) => candidate.name === ref.name && candidate.file === ref.file,
    );
    if (!entry) throw new Error(`Replacement component not found: ${ref.name} in ${ref.file}`);
    return { kind: 'component', entry };
  }

  private async runValidator(cwd: string, missionId: string): Promise<void> {
    if (this.validatorRunning) throw new Error('A validator run is already in progress.');
    const state = readDnaState(cwd);
    if (!state.tokens) {
      throw new Error(
        `No design tokens found. Add a design-tokens block to ${dnaFilePath(cwd, 'design')} first.`,
      );
    }
    const config = readValidatorConfig(cwd);
    if (config.pages.length === 0) {
      throw new Error('Add at least one page to the validator config before running it.');
    }
    this.validatorRunning = true;
    try {
      const report = await runValidator({
        cwd,
        config,
        tokens: state.tokens,
        browser: this.validatorBrowser(missionId),
        onProgress: (progress) =>
          this.options.emit({
            type: 'design.validator.status',
            cwd,
            missionId,
            status: 'running',
            ...progress,
          }),
      });
      this.lastReports.set(cwd, report);
      this.options.emit({ type: 'design.validator.status', cwd, missionId, status: 'done' });
      this.options.emit({ type: 'design.validator.report', report });
    } catch (error) {
      this.options.emit({
        type: 'design.validator.status',
        cwd,
        missionId,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      this.validatorRunning = false;
    }
  }

  private validatorBrowser(missionId: string): ValidatorBrowser {
    const { browsers } = this.options;
    let mode: BrowserViewportMode = 'desktop';
    let opened = false;
    const presetFor = (id: BrowserViewportMode) =>
      VIEWPORT_PRESETS.find((preset) => preset.id === id)?.viewport;
    return {
      async setViewportMode(next: string): Promise<void> {
        if (VIEWPORT_PRESETS.some((preset) => preset.id === next)) {
          mode = next as BrowserViewportMode;
        }
        const viewport = presetFor(mode);
        if (opened && viewport) {
          await browsers.resizeViewport({ missionId, viewport, viewportMode: mode });
        }
      },
      async open(url: string): Promise<void> {
        await browsers.open({ missionId, url, viewport: presetFor(mode), viewportMode: mode });
        opened = true;
      },
      audit: () => browsers.audit(missionId),
    };
  }
}
