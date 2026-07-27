import assert from 'node:assert/strict';
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

import { resolveDroidPath } from '../../sidecar/src/Environment.ts';

type SmokeResult = { appSessionId: string; assistantText: string };
type BridgeInfo = { port: number; token: string };
type SidecarReadyProof = { port: number; pid: number; tokenHash: string };
const PRELOAD_ONLY_BOOTSTRAP_DOCUMENT =
  '<!doctype html><html><head><meta charset="utf-8"></head><body>E1 bootstrap</body></html>';
function createPreloadOnlyBootstrapUrl(): string {
  const url = `data:text/html;charset=utf-8,${encodeURIComponent(PRELOAD_ONLY_BOOTSTRAP_DOCUMENT)}`;
  assertPreloadOnlyBootstrapUrl(url);
  return url;
}
function assertPreloadOnlyBootstrapUrl(url: string): void {
  assert.equal(new URL(url).protocol, 'data:', 'E1 bootstrap must use a data URL.');
  const documentSource = decodeURIComponent(url.slice(url.indexOf(',') + 1));
  assert.equal(
    documentSource,
    PRELOAD_ONLY_BOOTSTRAP_DOCUMENT,
    'E1 bootstrap document must stay preload-only.',
  );
  assert.equal(/<script\b/i.test(documentSource), false, 'E1 bootstrap must not execute scripts.');
  assert.equal(
    /<(?:iframe|img|link|audio|video|object|embed|source)\b/i.test(documentSource),
    false,
    'E1 bootstrap must not load subresources.',
  );
}
async function assertPreloadOnlyBootstrap(page: Page, url: string): Promise<void> {
  const state = await page.evaluate(() => ({
    url: window.location.href,
    scriptCount: document.scripts.length,
    hasReactRoot: document.getElementById('root') !== null,
    hasPreload: typeof window.droidControl?.bridgeInfo === 'function',
  }));
  assert.deepEqual(state, { url, scriptCount: 0, hasReactRoot: false, hasPreload: true });
}
function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  );
}
async function allocateLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error('E1 could not allocate a loopback bridge port.');
  }
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
function writeIsolatedSidecarEntry(home: string, sidecar: string): string {
  const entry = path.join(home, 'e1-sidecar-entry.mjs');
  writeFileSync(
    entry,
    [
      "import { createHash } from 'node:crypto';",
      "import { renameSync, unlinkSync, writeFileSync } from 'node:fs';",
      'const proofPath = process.env.SIDECAR_READY_PROOF;',
      'const port = Number(process.env.BRIDGE_PORT);',
      "const token = process.env.BRIDGE_TOKEN ?? '';",
      'const readyLine = `SIDECAR_READY ${port}\\n`;',
      'let proofWritten = false;',
      'function writeReadyProof() {',
      '  if (proofWritten || !proofPath || !token || !Number.isSafeInteger(port)) return;',
      '  const temporaryProof = `${proofPath}.${process.pid}.tmp`;',
      '  try {',
      '    writeFileSync(',
      '      temporaryProof,',
      "      JSON.stringify({ port, pid: process.pid, tokenHash: createHash('sha256').update(token).digest('hex') }) + '\\n',",
      '      { mode: 0o600 },',
      '    );',
      '    renameSync(temporaryProof, proofPath);',
      '    proofWritten = true;',
      '  } catch {',
      '    try { unlinkSync(temporaryProof); } catch {}',
      '  }',
      '}',
      'const originalWrite = process.stdout.write.bind(process.stdout);',
      'process.stdout.write = function write(chunk, ...args) {',
      '  if (!proofWritten && String(chunk) === readyLine) writeReadyProof();',
      '  return originalWrite(chunk, ...args);',
      '};',
      "process.env.BRIDGE_ALLOW_LOCAL_NO_TOKEN = '0';",
      `await import(${JSON.stringify(pathToFileURL(sidecar).href)});`,
      '',
    ].join('\n'),
  );
  return entry;
}
function waitForSidecarReadyProof(proofPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let watcher: ReturnType<typeof watch> | undefined;
    const settle = (proof?: string, error?: Error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      watcher?.close();
      if (error) reject(error);
      else resolve(proof!);
    };
    const readProof = () => {
      if (!existsSync(proofPath)) return;
      try {
        settle(readFileSync(proofPath, 'utf8'));
      } catch {
        // The wrapper writes then atomically renames; wait for its next filesystem event.
      }
    };
    try {
      watcher = watch(path.dirname(proofPath), readProof);
    } catch {
      settle(undefined, new Error('E1 could not watch for the sidecar readiness proof.'));
      return;
    }
    timeout = setTimeout(
      () => settle(undefined, new Error('E1 sidecar readiness proof did not appear.')),
      10_000,
    );
    readProof();
  });
}

function parseSidecarReadyProof(proofText: string): SidecarReadyProof {
  let value: unknown;
  try {
    value = JSON.parse(proofText);
  } catch {
    throw new Error('E1 sidecar readiness proof is not valid JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('E1 sidecar readiness proof has an invalid shape.');
  const proof = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(proof.port) ||
    proof.port <= 0 ||
    proof.port > 65_535 ||
    !Number.isSafeInteger(proof.pid) ||
    proof.pid <= 1 ||
    proof.pid > 0x7fffffff ||
    typeof proof.tokenHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(proof.tokenHash)
  )
    throw new Error('E1 sidecar readiness proof has invalid values.');
  return { port: proof.port, pid: proof.pid, tokenHash: proof.tokenHash };
}

async function verifySidecarReadyProof(proofPath: string, bridge: BridgeInfo): Promise<void> {
  const proofText = await waitForSidecarReadyProof(proofPath);
  if ((statSync(proofPath).mode & 0o777) !== 0o600)
    throw new Error('E1 sidecar readiness proof must be mode 0600.');
  if (proofText.includes(bridge.token))
    throw new Error('E1 sidecar readiness proof unexpectedly contains a raw token.');
  const proof = parseSidecarReadyProof(proofText);
  if (proof.port !== bridge.port)
    throw new Error('E1 sidecar readiness proof did not report the selected port.');
  try {
    process.kill(proof.pid, 0);
  } catch {
    throw new Error('E1 sidecar readiness proof did not report a live process.');
  }
  const expectedHash = createHash('sha256').update(bridge.token).digest();
  const proofHash = Buffer.from(proof.tokenHash, 'hex');
  if (proofHash.length !== expectedHash.length || !timingSafeEqual(proofHash, expectedHash))
    throw new Error('E1 sidecar readiness proof token hash did not match bridge ownership.');
}

async function verifyOwnedBridge(page: Page, bridge: BridgeInfo): Promise<void> {
  await page.evaluate(async (info) => {
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${info.port}`);
      let settled = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        try {
          socket.close();
        } catch {}
        if (error) reject(error);
        else resolve();
      };
      const timeout = window.setTimeout(
        () => settle(new Error('E1 unauthenticated bridge probe timed out.')),
        10_000,
      );
      socket.onerror = () => settle(new Error('E1 unauthenticated bridge probe failed.'));
      socket.onclose = (event) => {
        if (event.code !== 1008) {
          settle(new Error('E1 bridge accepted an unauthenticated WebSocket.'));
          return;
        }
        settle();
      };
    });

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(
        `ws://127.0.0.1:${info.port}?token=${encodeURIComponent(info.token)}`,
      );
      let settled = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        try {
          socket.close();
        } catch {}
        if (error) reject(error);
        else resolve();
      };
      const timeout = window.setTimeout(
        () => settle(new Error('E1 authenticated environment probe timed out.')),
        20_000,
      );
      socket.onopen = () => {
        try {
          socket.send(JSON.stringify({ type: 'env.detect' }));
        } catch {
          settle(new Error('E1 authenticated bridge probe could not send env.detect.'));
        }
      };
      socket.onerror = () => settle(new Error('E1 authenticated bridge probe failed.'));
      socket.onclose = () => settle(new Error('E1 bridge closed before env.report.'));
      socket.onmessage = ({ data }) => {
        let event: unknown;
        try {
          event = JSON.parse(data);
        } catch {
          settle(new Error('E1 environment probe received invalid JSON.'));
          return;
        }
        if (!event || typeof event !== 'object' || Array.isArray(event)) return;
        const value = event as Record<string, unknown>;
        if (value.type !== 'env.report') return;
        const report = value.report;
        if (
          !report ||
          typeof report !== 'object' ||
          Array.isArray(report) ||
          !('cli' in report) ||
          !report.cli ||
          typeof report.cli !== 'object' ||
          Array.isArray(report.cli) ||
          report.cli.present !== true
        ) {
          settle(new Error('E1 env.report did not confirm CLI readiness.'));
          return;
        }
        settle();
      };
    });
  }, bridge);
}

async function runRoundTrip(page: Page): Promise<SmokeResult> {
  return page.evaluate(async () => {
    const { port, token } = await window.droidControl!.bridgeInfo();
    const ws = new WebSocket(`ws://127.0.0.1:${port}${token ? `?token=${token}` : ''}`);
    return new Promise<SmokeResult>((resolve, reject) => {
      const clientRef = `e1-${Date.now()}`;
      let appSessionId = '';
      let assistantText = '';
      let settled = false;
      let closeSent = false;
      const sendSessionClose = () => {
        if (!appSessionId || closeSent || ws.readyState !== WebSocket.OPEN) return;
        closeSent = true;
        try {
          ws.send(JSON.stringify({ type: 'session.close', appSessionId }));
        } catch {}
      };
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        if (error) sendSessionClose();
        try {
          ws.close();
        } catch {}
        if (error) reject(error);
        else resolve({ appSessionId, assistantText });
      };
      const timer = window.setTimeout(() => settle(new Error('E1 timed out')), 120_000);
      ws.onopen = () => {
        if (settled) return;
        try {
          ws.send(
            JSON.stringify({
              type: 'session.create',
              clientRef,
              title: 'E1 authenticated smoke',
              goal: 'Reply with exactly E1_OK.',
              sessionPurpose: 'chat',
              interactionMode: 'auto',
              autonomy: 'off',
            }),
          );
        } catch {
          settle(new Error('E1 bridge WebSocket failed'));
        }
      };
      ws.onerror = () => settle(new Error('E1 bridge WebSocket failed'));
      ws.onmessage = ({ data }) => {
        if (settled) return;
        let event: unknown;
        try {
          event = JSON.parse(data);
        } catch {
          settle(new Error('E1 received invalid JSON'));
          return;
        }
        if (!event || typeof event !== 'object' || !('type' in event)) return;
        const value = event as Record<string, unknown>;
        if (value.type === 'error') {
          settle(new Error(String(value.message ?? 'E1 sidecar error')));
          return;
        }
        if (value.type === 'session.created' && value.clientRef === clientRef) {
          const session = value.session as Record<string, unknown>;
          appSessionId = String(session.appSessionId ?? '');
          if (
            !appSessionId ||
            session.sessionPurpose !== 'chat' ||
            session.interactionMode !== 'auto' ||
            session.autonomy !== 'off' ||
            session.goal !== 'Reply with exactly E1_OK.'
          )
            settle(new Error('E1 creation contract drift'));
          return;
        }
        if (value.type === 'event.appended') {
          const transcript = value.event as Record<string, unknown>;
          if (
            transcript.appSessionId === appSessionId &&
            transcript.sourceSessionId === appSessionId &&
            transcript.role === 'primary' &&
            transcript.kind === 'text' &&
            transcript.author === undefined &&
            typeof transcript.text === 'string' &&
            transcript.text.trim()
          )
            assistantText += transcript.text;
          return;
        }
        if (value.type === 'session.updated') {
          const session = value.session as Record<string, unknown>;
          if (
            session.appSessionId === appSessionId &&
            session.streaming === false &&
            assistantText.trim() &&
            !closeSent
          )
            sendSessionClose();
          return;
        }
        if (value.type === 'sessions.list' && closeSent) settle();
      };
    });
  });
}

test('[E1] Authenticated desktop round trip', async () => {
  const { FACTORY_API_KEY: apiKey, ...childEnv } = process.env;
  assert.equal(
    process.env.RUN_AUTHENTICATED_DROID_SMOKE,
    '1',
    'run npm run test:smoke:electron-droid',
  );
  assert.ok(apiKey, 'FACTORY_API_KEY is required');
  for (const artifact of ['dist/index.html', 'sidecar/dist/sidecar.mjs', 'electron/main.cjs'])
    assert.ok(existsSync(artifact), `missing ${artifact}`);
  const droidPath = resolveDroidPath();

  const home = mkdtempSync(path.join(tmpdir(), 'droid-control-e1-'));
  const profile = {
    config: path.join(home, 'config'),
    data: path.join(home, 'data'),
    localAppData: path.join(home, 'local-app-data'),
    roamingAppData: path.join(home, 'roaming-app-data'),
    userData: path.join(home, 'user-data'),
  };
  for (const directory of Object.values(profile)) mkdirSync(directory, { recursive: true });
  const bridgePort = await allocateLoopbackPort();
  const sidecar = path.resolve('sidecar/dist/sidecar.mjs');
  const sidecarEntry = writeIsolatedSidecarEntry(home, sidecar);
  const sidecarReadyProof = path.join(home, 'e1-sidecar-ready.json');
  const bootstrapUrl = createPreloadOnlyBootstrapUrl();
  const launchEnv = {
    ...childEnv,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: profile.config,
    XDG_DATA_HOME: profile.data,
    APPDATA: profile.roamingAppData,
    LOCALAPPDATA: profile.localAppData,
    ELECTRON_START_URL: bootstrapUrl,
    DROID_PATH: droidPath,
    SIDECAR_ENTRY: sidecarEntry,
    SIDECAR_READY_PROOF: sidecarReadyProof,
    BRIDGE_PORT: String(bridgePort),
  };
  assert.equal(
    launchEnv.ELECTRON_START_URL,
    bootstrapUrl,
    'E1 did not pass the safe bootstrap URL to Electron.',
  );
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({
      args: [path.resolve('electron/main.cjs'), `--user-data-dir=${profile.userData}`],
      cwd: process.cwd(),
      env: launchEnv,
    });
    const page = await app.firstWindow();
    await assertPreloadOnlyBootstrap(page, bootstrapUrl);
    const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
    assert.equal(isWithin(home, userData), true, 'E1 userData escaped its isolated profile.');
    // This is the preload IPC boundary; no bridge socket may run until its
    // token is bound to the supervisor's readiness proof below.
    const bridge = await page.evaluate(() => window.droidControl!.bridgeInfo());
    assert.equal(bridge.port, bridgePort, 'E1 bridge did not report the selected port.');
    assert.equal(
      typeof bridge.token === 'string' && bridge.token.length > 0,
      true,
      'E1 bridge did not report an authentication token.',
    );
    await verifySidecarReadyProof(sidecarReadyProof, bridge);
    await verifyOwnedBridge(page, bridge);

    await page.evaluate(async (key) => {
      await window.droidControl!.setApiKey(key);
      await window.droidControl!.setOnboarding({
        completed: false,
        cliAutoUpdate: false,
        appAutoUpdate: false,
      });
    }, apiKey);
    const rendererUrl = pathToFileURL(path.resolve('dist', 'index.html')).href;
    await page.goto(rendererUrl);
    assert.equal(page.url(), rendererUrl, 'E1 did not navigate to the built renderer.');
    await page.getByRole('button', { name: /Get started/i }).click();
    await page.getByRole('button', { name: /^Continue/ }).click();
    await expect(page.getByText("You're signed in.")).toBeVisible();
    await page.getByRole('button', { name: /^Continue/ }).click();
    await page.getByRole('button', { name: /^Continue/ }).click();
    await page.getByRole('button', { name: /Start using DROIDEX/i }).click();
    const onboarding = JSON.parse(
      readFileSync(path.join(userData, 'onboarding.json'), 'utf8'),
    ) as Record<string, unknown>;
    assert.deepEqual(
      {
        completed: onboarding['completed'],
        cliAutoUpdate: onboarding['cliAutoUpdate'],
        appAutoUpdate: onboarding['appAutoUpdate'],
      },
      { completed: true, cliAutoUpdate: false, appAutoUpdate: false },
    );
    const result = await runRoundTrip(page);
    expect(result.assistantText.trim()).toBe('E1_OK');
  } finally {
    try {
      await app?.close();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
});
