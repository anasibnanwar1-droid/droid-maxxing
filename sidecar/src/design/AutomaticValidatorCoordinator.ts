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

/** Coalesces post-turn audits without letting them outlive their owning session. */
export class AutomaticValidatorCoordinator {
  private readonly runs = new Map<
    string,
    { controller: AbortController; completion: Promise<void> }
  >();

  constructor(private readonly dependencies: AutomaticValidatorDependencies) {}

  async run(cwd: string, appSessionId: string, isCurrent: () => boolean): Promise<void> {
    if (!readValidatorConfig(cwd).runAfterDesignPrompt) return;
    const previous = this.runs.get(appSessionId);
    previous?.controller.abort();
    const controller = new AbortController();
    const completion = this.perform(cwd, appSessionId, isCurrent, controller, previous?.completion);
    const record = { controller, completion };
    this.runs.set(appSessionId, record);
    await completion;
    if (this.runs.get(appSessionId) === record) this.runs.delete(appSessionId);
  }

  private async perform(
    cwd: string,
    appSessionId: string,
    isCurrent: () => boolean,
    controller: AbortController,
    previous: Promise<void> | undefined,
  ): Promise<void> {
    await previous;
    if (signalIsAborted(controller.signal) || !isCurrent()) return;
    const browserAppSessionId = `${appSessionId}:automatic-validator`;
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
      await this.dependencies.closeBrowser(browserAppSessionId).catch(() => {
        // Browser cleanup is best-effort after the owning session disappears.
      });
    }
  }
}

function signalIsAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}
