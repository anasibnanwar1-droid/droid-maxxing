import { readValidatorConfig } from './validator/config.js';

interface AutomaticValidatorDependencies {
  run: (input: {
    cwd: string;
    appSessionId: string;
    browserAppSessionId: string;
    signal: AbortSignal;
    isCurrent: () => boolean;
  }) => Promise<void>;
  closeBrowser: (browserAppSessionId: string) => Promise<void>;
  reportError: (cwd: string, message: string) => void;
}

interface AutomaticValidatorRun {
  controller: AbortController;
  completion: Promise<void>;
  closeBrowser: () => Promise<void>;
}

interface AutomaticValidatorTask {
  cwd: string;
  appSessionId: string;
  browserAppSessionId: string;
  isCurrent: () => boolean;
  controller: AbortController;
  closeBrowser: () => Promise<void>;
  previous?: Promise<void>;
}

/** Coalesces post-turn audits without letting them outlive their owning session. */
export class AutomaticValidatorCoordinator {
  private readonly runs = new Map<string, AutomaticValidatorRun>();

  constructor(private readonly dependencies: AutomaticValidatorDependencies) {}

  async run(cwd: string, appSessionId: string, isCurrent: () => boolean): Promise<void> {
    if (!readValidatorConfig(cwd).runAfterDesignPrompt) return;
    const previous = this.runs.get(appSessionId);
    previous?.controller.abort();
    const controller = new AbortController();
    const browserAppSessionId = browserSessionIdFor(appSessionId);
    let browserClose: Promise<void> | undefined;
    const closeBrowser = () => {
      browserClose ??= this.dependencies.closeBrowser(browserAppSessionId).catch(() => {
        // Browser cleanup is best-effort after the owning session disappears.
      });
      return browserClose;
    };
    const completion = this.perform({
      cwd,
      appSessionId,
      browserAppSessionId,
      isCurrent,
      controller,
      closeBrowser,
      previous: previous?.completion,
    });
    const record = { controller, completion, closeBrowser };
    this.runs.set(appSessionId, record);
    await completion;
    if (this.runs.get(appSessionId) === record) this.runs.delete(appSessionId);
  }

  async cancel(appSessionId: string): Promise<void> {
    const record = this.runs.get(appSessionId);
    if (!record) return;
    record.controller.abort();
    await record.closeBrowser();
    await record.completion;
    if (this.runs.get(appSessionId) === record) this.runs.delete(appSessionId);
  }

  private async perform(task: AutomaticValidatorTask): Promise<void> {
    const {
      cwd,
      appSessionId,
      browserAppSessionId,
      isCurrent,
      controller,
      closeBrowser,
      previous,
    } = task;
    await previous;
    if (signalIsAborted(controller.signal) || !isCurrent()) return;
    try {
      await this.dependencies.run({
        cwd,
        appSessionId,
        browserAppSessionId,
        signal: controller.signal,
        isCurrent,
      });
    } catch (error) {
      if (signalIsAborted(controller.signal) || !isCurrent()) return;
      this.dependencies.reportError(cwd, error instanceof Error ? error.message : String(error));
    } finally {
      await closeBrowser();
    }
  }
}

function browserSessionIdFor(appSessionId: string): string {
  return `${appSessionId}:automatic-validator`;
}

function signalIsAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}
