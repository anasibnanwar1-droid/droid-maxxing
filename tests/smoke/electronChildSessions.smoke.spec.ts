import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';

type RecordedCommand = {
  type: string;
  parentAppSessionId?: string;
  childSessionId?: string;
  text?: string;
  factoryApiKeyConfigured?: boolean;
  droidPathConfigured?: boolean;
};

interface SmokeResources {
  smokeHome: string;
  fixtureProcess?: ChildProcessWithoutNullStreams;
  app?: ElectronApplication;
}

async function startFixture(
  logPath: string,
  environment: NodeJS.ProcessEnv,
  overrides: NodeJS.ProcessEnv = {},
  onSpawn: (child: ChildProcessWithoutNullStreams) => void = () => undefined,
): Promise<{ process: ChildProcessWithoutNullStreams; port: number }> {
  const child = spawn(
    process.execPath,
    [path.resolve('sidecar/test-fixtures/childSessionsSidecar.mjs')],
    {
      cwd: process.cwd(),
      env: {
        ...environment,
        BRIDGE_PORT: '0',
        BRIDGE_TOKEN: '',
        BRIDGE_EXIT_ON_STDIN_CLOSE: '1',
        CHILD_SESSIONS_SMOKE_ALLOW_ANY_TOKEN: '1',
        CHILD_SESSIONS_SMOKE_LOG: logPath,
        ...overrides,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  onSpawn(child);
  return new Promise((resolve, reject) => {
    let output = '';
    const fail = (error: unknown) => {
      child.kill();
      reject(error);
    };
    child.once('error', fail);
    child.once('exit', (code) => fail(new Error(`Smoke fixture exited before ready (${code}).`)));
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
      const match = output.match(/SIDECAR_READY (\d+)/);
      if (!match) return;
      child.removeListener('error', fail);
      child.removeAllListeners('exit');
      resolve({ process: child, port: Number(match[1]) });
    });
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => resolve());
  });
}

async function cleanupSmokeResources(resources: SmokeResources): Promise<void> {
  try {
    await resources.app?.close();
  } finally {
    try {
      const fixture = resources.fixtureProcess;
      if (fixture && fixture.exitCode === null && fixture.signalCode === null) fixture.stdin.end();
      if (fixture) await waitForExit(fixture);
    } finally {
      rmSync(resources.smokeHome, { recursive: true, force: true });
    }
  }
}

function recordedCommands(logPath: string): RecordedCommand[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RecordedCommand);
}

async function waitForCommand(
  logPath: string,
  predicate: (command: RecordedCommand) => boolean,
): Promise<RecordedCommand> {
  await expect
    .poll(() => recordedCommands(logPath).find(predicate), { timeout: 10_000 })
    .not.toBeUndefined();
  return recordedCommands(logPath).find(predicate)!;
}

test('[E2] parent-scoped child navigation and visible commands', async () => {
  for (const artifact of [
    'dist/index.html',
    'electron/main.cjs',
    'sidecar/test-fixtures/childSessionsSidecar.mjs',
  ]) {
    assert.ok(existsSync(artifact), `missing ${artifact}`);
  }

  const smokeHome = mkdtempSync(path.join(tmpdir(), 'droid-control-child-sessions-'));
  const profile = {
    config: path.join(smokeHome, 'config'),
    data: path.join(smokeHome, 'data'),
    localAppData: path.join(smokeHome, 'local-app-data'),
    roamingAppData: path.join(smokeHome, 'roaming-app-data'),
    userData: path.join(smokeHome, 'user-data'),
  };
  for (const directory of Object.values(profile)) mkdirSync(directory, { recursive: true });

  const commandLog = path.join(smokeHome, 'commands.jsonl');
  const bootstrapUrl = `data:text/html;charset=utf-8,${encodeURIComponent(
    '<!doctype html><html><body>Child-session smoke bootstrap</body></html>',
  )}`;
  const {
    FACTORY_API_KEY: _factoryApiKey,
    DROID_PATH: _droidPath,
    ...unauthenticatedEnvironment
  } = process.env;

  const resources: SmokeResources = { smokeHome };
  try {
    const fixture = await startFixture(commandLog, unauthenticatedEnvironment, {}, (child) => {
      resources.fixtureProcess = child;
    });
    const launchEnvironment = {
      ...unauthenticatedEnvironment,
      HOME: smokeHome,
      USERPROFILE: smokeHome,
      XDG_CONFIG_HOME: profile.config,
      XDG_DATA_HOME: profile.data,
      APPDATA: profile.roamingAppData,
      LOCALAPPDATA: profile.localAppData,
      ELECTRON_START_URL: bootstrapUrl,
      SIDECAR_ENTRY: path.resolve('sidecar/test-fixtures/noopSidecar.mjs'),
      BRIDGE_PORT: String(fixture.port),
      NODE_BIN: process.execPath,
    };
    const app = await electron.launch({
      args: [path.resolve('electron/main.cjs'), `--user-data-dir=${profile.userData}`],
      cwd: process.cwd(),
      env: launchEnvironment,
    });
    resources.app = app;
    const page = await app.firstWindow();
    await page.evaluate(async () => {
      await window.droidControl!.setOnboarding({
        completed: true,
        cliAutoUpdate: false,
        appAutoUpdate: false,
      });
    });
    await page.goto(pathToFileURL(path.resolve('dist/index.html')).href);

    const fixtureStart = await waitForCommand(
      commandLog,
      (command) => command.type === 'fixture.start',
    );
    assert.equal(fixtureStart.factoryApiKeyConfigured, false);
    assert.equal(fixtureStart.droidPathConfigured, false);

    const leftNavigation = page.getByTestId('left-navigation');
    await expect(leftNavigation.getByText('Parent Alpha', { exact: true })).toBeVisible();
    await expect(leftNavigation.getByText('Parent Beta', { exact: true })).toBeVisible();
    await expect(leftNavigation.getByText('Alpha Worker Shared', { exact: true })).toHaveCount(0);
    await expect(leftNavigation.locator('[data-app-session-id]')).toHaveCount(2);

    await leftNavigation.locator('[data-app-session-id="parent-alpha"]').click();
    const chat = page.getByTestId('chat-view');
    await expect(chat.getByText('ALPHA PRIMARY OUTPUT', { exact: true })).toBeVisible();

    const rightPanel = page.getByTestId('right-context-panel');
    await expect(rightPanel).toBeVisible();
    await expect(rightPanel.locator('[data-parent-app-session-id="parent-alpha"]')).toHaveCount(3);
    await expect(rightPanel.getByText('Alpha Worker Shared', { exact: true })).toBeVisible();
    await expect(rightPanel.getByText('Alpha Worker Two', { exact: true })).toBeVisible();
    await expect(rightPanel.getByText('Alpha Historical Worker', { exact: true })).toBeVisible();

    const alphaShared = rightPanel.locator(
      '[data-parent-app-session-id="parent-alpha"][data-child-session-id="shared-child"]',
    );
    const alphaSibling = rightPanel.locator(
      '[data-parent-app-session-id="parent-alpha"][data-child-session-id="alpha-sibling"]',
    );
    await alphaShared.locator('button').first().click();
    await alphaSibling.locator('button').first().click();
    await expect(chat.getByText('ALPHA CHILD TWO OUTPUT', { exact: true })).toBeVisible();
    await expect(chat.getByText('ALPHA PRIMARY OUTPUT', { exact: true })).toHaveCount(0);
    await expect(chat.getByText('STALE OPEN PROCESSED', { exact: true })).toBeVisible();
    await expect(chat.getByText('Alpha Worker Two', { exact: true })).toBeVisible();

    await chat.getByTitle('Back to primary session').click();
    await expect(chat.getByText('ALPHA PRIMARY OUTPUT', { exact: true })).toBeVisible();
    await expect(chat.getByText('ALPHA CHILD TWO OUTPUT', { exact: true })).toHaveCount(0);
    await alphaSibling.locator('button').first().click();
    await expect(chat.getByText('ALPHA CHILD TWO OUTPUT', { exact: true })).toBeVisible();

    const composer = page.locator('textarea');
    await composer.fill('STEER EXACT CHILD');
    await composer.press('Control+Enter');
    await waitForCommand(
      commandLog,
      (command) =>
        command.type === 'child.sendNow' &&
        command.parentAppSessionId === 'parent-alpha' &&
        command.childSessionId === 'alpha-sibling' &&
        command.text === 'STEER EXACT CHILD',
    );
    await chat.getByTitle('Stop child session').click();
    await waitForCommand(
      commandLog,
      (command) =>
        command.type === 'child.interrupt' &&
        command.parentAppSessionId === 'parent-alpha' &&
        command.childSessionId === 'alpha-sibling',
    );

    await leftNavigation.locator('[data-app-session-id="parent-beta"]').click();
    await expect(chat.getByText('BETA PRIMARY OUTPUT', { exact: true })).toBeVisible();
    await expect(rightPanel.locator('[data-parent-app-session-id="parent-beta"]')).toHaveCount(1);
    await expect(rightPanel.getByText('Beta Worker Shared', { exact: true })).toBeVisible();
    await expect(rightPanel.getByText('Alpha Worker Shared', { exact: true })).toHaveCount(0);

    const betaShared = rightPanel.locator(
      '[data-parent-app-session-id="parent-beta"][data-child-session-id="shared-child"]',
    );
    await betaShared.locator('button').first().click();
    await expect(chat.getByText('BETA SHARED CHILD OUTPUT', { exact: true })).toBeVisible();
    await expect(chat.getByText('ALPHA SHARED CHILD OUTPUT', { exact: true })).toHaveCount(0);
    await expect(leftNavigation.getByText('Beta Worker Shared', { exact: true })).toHaveCount(0);
  } finally {
    await cleanupSmokeResources(resources);
  }
});

test('[E2] pre-ready fixture failure cleans the temporary profile and process', async () => {
  const smokeHome = mkdtempSync(path.join(tmpdir(), 'droid-control-child-startup-failure-'));
  const commandLog = path.join(smokeHome, 'commands.jsonl');
  const {
    FACTORY_API_KEY: _factoryApiKey,
    DROID_PATH: _droidPath,
    ...unauthenticatedEnvironment
  } = process.env;
  const resources: SmokeResources = { smokeHome };

  try {
    await assert.rejects(
      startFixture(commandLog, unauthenticatedEnvironment, { BRIDGE_PORT: '65536' }, (child) => {
        resources.fixtureProcess = child;
      }),
      /Smoke fixture exited before ready/,
    );
  } finally {
    await cleanupSmokeResources(resources);
  }

  assert.equal(existsSync(smokeHome), false);
  assert.ok(resources.fixtureProcess);
  assert.ok(
    resources.fixtureProcess.exitCode !== null || resources.fixtureProcess.signalCode !== null,
  );
});
