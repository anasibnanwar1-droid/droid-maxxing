import { appendFileSync } from 'node:fs';
import { WebSocket, WebSocketServer } from 'ws';

const port = Number(process.env.BRIDGE_PORT);
const token = process.env.BRIDGE_TOKEN ?? '';
const logPath = process.env.CHILD_SESSIONS_SMOKE_LOG;
const allowAnyToken = process.env.CHILD_SESSIONS_SMOKE_ALLOW_ANY_TOKEN === '1';

if (
  !Number.isSafeInteger(port) ||
  port < 0 ||
  port > 65_535 ||
  (!token && !allowAnyToken) ||
  !logPath
) {
  throw new Error(
    'Child-session smoke fixture requires BRIDGE_PORT, bridge authentication, and log path.',
  );
}

const now = Date.now();
const session = (appSessionId, title, updatedAt) => ({
  appSessionId,
  providerSessionId: `provider-${appSessionId}`,
  sessionPurpose: 'chat',
  interactionMode: 'auto',
  role: 'primary',
  title,
  goal: `${title} goal`,
  cwd: '',
  workspaceKind: 'none',
  modelId: 'model-primary',
  reasoningEffort: 'medium',
  autonomy: 'medium',
  phase: 'paused',
  streaming: false,
  features: [],
  tokensIn: 10,
  tokensOut: 20,
  contextTokens: 30,
  createdAt: updatedAt - 1_000,
  updatedAt,
});

const parents = [
  session('parent-alpha', 'Parent Alpha', now + 2_000),
  session('parent-beta', 'Parent Beta', now + 1_000),
];

const child = (parentAppSessionId, childSessionId, label, status, transcriptAvailable = true) => ({
  parentAppSessionId,
  childSessionId,
  role: 'worker',
  status,
  label,
  prompt: `${label} prompt`,
  modelId: 'model-child',
  reasoningEffort: 'high',
  spawnLink: { kind: 'tool-use', id: `tool-${parentAppSessionId}-${childSessionId}` },
  transcriptAvailable,
  startedAt: now - 5_000,
});

const children = {
  'parent-alpha': [
    child('parent-alpha', 'shared-child', 'Alpha Worker Shared', 'running'),
    child('parent-alpha', 'alpha-sibling', 'Alpha Worker Two', 'running'),
    child('parent-alpha', 'alpha-history', 'Alpha Historical Worker', 'completed'),
  ],
  'parent-beta': [child('parent-beta', 'shared-child', 'Beta Worker Shared', 'running')],
};

const transcriptEvent = (appSessionId, id, sourceSessionId, role, text, ts, author) => ({
  id,
  appSessionId,
  sourceSessionId,
  role,
  ts,
  kind: 'text',
  text,
  ...(author ? { author } : {}),
});

const transcripts = {
  'parent-alpha': [
    transcriptEvent(
      'parent-alpha',
      'alpha-user',
      'user',
      'primary',
      'ALPHA PRIMARY PROMPT',
      now - 4_000,
      'user',
    ),
    transcriptEvent(
      'parent-alpha',
      'alpha-primary',
      'parent-alpha',
      'primary',
      'ALPHA PRIMARY OUTPUT',
      now - 3_900,
    ),
    transcriptEvent(
      'parent-alpha',
      'alpha-shared-output',
      'shared-child',
      'worker',
      'ALPHA SHARED CHILD OUTPUT',
      now - 3_800,
    ),
    transcriptEvent(
      'parent-alpha',
      'alpha-sibling-output',
      'alpha-sibling',
      'worker',
      'ALPHA CHILD TWO OUTPUT',
      now - 3_700,
    ),
    transcriptEvent(
      'parent-alpha',
      'alpha-history-output',
      'alpha-history',
      'worker',
      'ALPHA HISTORICAL OUTPUT',
      now - 3_600,
    ),
  ],
  'parent-beta': [
    transcriptEvent(
      'parent-beta',
      'beta-primary',
      'parent-beta',
      'primary',
      'BETA PRIMARY OUTPUT',
      now - 2_000,
    ),
    transcriptEvent(
      'parent-beta',
      'beta-shared-output',
      'shared-child',
      'worker',
      'BETA SHARED CHILD OUTPUT',
      now - 1_900,
    ),
  ],
};

function record(value) {
  appendFileSync(logPath, `${JSON.stringify({ receivedAt: Date.now(), ...value })}\n`);
}

record({
  type: 'fixture.start',
  factoryApiKeyConfigured: Boolean(process.env.FACTORY_API_KEY),
  droidPathConfigured: Boolean(process.env.DROID_PATH),
});

const server = new WebSocketServer({ host: '127.0.0.1', port });
const timers = new Set();

function send(socket, event) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
}

function history(socket, appSessionId) {
  send(socket, {
    type: 'session.history',
    appSessionId,
    progress: [],
    transcripts: transcripts[appSessionId] ?? [],
    childSessions: children[appSessionId] ?? [],
    mode: 'replace',
    loadedCount: transcripts[appSessionId]?.length ?? 0,
    hasMore: false,
  });
}

function openChild(socket, command) {
  const summary = children[command.parentAppSessionId]?.find(
    (candidate) => candidate.childSessionId === command.childSessionId,
  );
  if (!summary || summary.status === 'completed') {
    send(socket, {
      type: 'child.updated',
      parentAppSessionId: command.parentAppSessionId,
      childSessionId: command.childSessionId,
      requestId: command.requestId,
      access: 'history',
    });
    return;
  }
  const reply = () =>
    send(socket, {
      type: 'child.updated',
      parentAppSessionId: command.parentAppSessionId,
      childSessionId: command.childSessionId,
      requestId: command.requestId,
      access: 'ready',
      runtimeGeneration: command.childSessionId === 'shared-child' ? 7 : 11,
    });
  if (command.parentAppSessionId === 'parent-alpha' && command.childSessionId === 'shared-child') {
    const timer = setTimeout(() => {
      timers.delete(timer);
      reply();
      send(socket, {
        type: 'event.appended',
        event: transcriptEvent(
          'parent-alpha',
          'stale-open-processed',
          'alpha-sibling',
          'worker',
          'STALE OPEN PROCESSED',
          Date.now(),
        ),
      });
    }, 500);
    timers.add(timer);
  } else {
    reply();
  }
}

server.on('connection', (socket, request) => {
  const provided = new URL(request.url ?? '/', `http://${request.headers.host}`).searchParams.get(
    'token',
  );
  if (!allowAnyToken && provided !== token) {
    socket.close(1008, 'invalid bridge token');
    return;
  }
  send(socket, { type: 'connection', status: 'connected' });
  socket.on('message', (raw) => {
    const command = JSON.parse(String(raw));
    record(command);
    switch (command.type) {
      case 'connect':
      case 'runtime.status':
        send(socket, {
          type: 'runtime.updated',
          status: { mode: 'cli_auth', droidPath: '', apiKeyConfigured: false },
        });
        break;
      case 'env.detect':
        send(socket, {
          type: 'env.report',
          report: {
            platform: process.platform,
            arch: process.arch,
            osVersion: 'local-smoke',
            node: { present: true, version: process.version },
            cli: { present: true, path: '/local-smoke/droid', version: 'smoke' },
            packageManagers: {},
            auth: { apiKeyConfigured: false, loginPresent: true },
            availableChannels: [],
          },
        });
        break;
      case 'settings.defaults':
        send(socket, { type: 'settings.defaults', defaults: {} });
        break;
      case 'sessions.list':
        send(socket, { type: 'sessions.list', sessions: parents });
        break;
      case 'session.loadHistory':
        history(socket, command.appSessionId);
        break;
      case 'child.open':
        openChild(socket, command);
        break;
      case 'catalog.models':
        send(socket, {
          type: 'catalog.updated',
          catalog: 'models',
          items: [
            {
              id: 'model-child',
              displayName: 'Child Model',
              isCustom: false,
              supportedReasoningEfforts: ['high'],
              defaultReasoningEffort: 'high',
            },
          ],
        });
        break;
    }
  });
});

server.on('listening', () => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture has no TCP address.');
  process.stdout.write(`SIDECAR_READY ${String(address.port)}\n`);
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const timer of timers) clearTimeout(timer);
  for (const client of server.clients) client.terminate();
  server.close(() => process.exit(0));
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
if (process.env.BRIDGE_EXIT_ON_STDIN_CLOSE === '1') {
  process.stdin.resume();
  process.stdin.once('end', shutdown);
}
