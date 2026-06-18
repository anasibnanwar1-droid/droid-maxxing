import assert from 'node:assert/strict';
import test from 'node:test';
import { bridge } from './bridge';
import {
  addDesignReference,
  clickBrowser,
  closeBrowser,
  closeMission,
  compactSession,
  connect,
  createMission,
  detectEnv,
  installCli,
  interruptAgent,
  interruptMission,
  keypressBrowser,
  listFactoryDefaults,
  listMissions,
  listModels,
  listSkills,
  loadMissionHistory,
  loadOlderMissionHistory,
  newClientRef,
  openBrowser,
  refreshBrowser,
  reloadBrowser,
  requestRuntimeStatus,
  resizeBrowserViewport,
  respondPermission,
  respondQuestion,
  resumeMission,
  scrollBrowser,
  sendDesignPrompt,
  sendNativeBrowserResult,
  sendToAgent,
  sendToAgentNow,
  sendToMission,
  sendToMissionNow,
  setInteractionMode,
  setMissionAutonomy,
  startCliLogin,
  subscribeWorker,
  typeBrowser,
  updateAgentSettings,
  updateCli,
  updateCompactionSettings,
  updateSessionSettings,
} from './commands';
import type { ClientCommand } from '../types/bridge';

function captureCommands(run: () => void): ClientCommand[] {
  const sent: ClientCommand[] = [];
  const originalSend = bridge.send.bind(bridge);
  bridge.send = (cmd: ClientCommand) => {
    sent.push(cmd);
  };
  try {
    run();
  } finally {
    bridge.send = originalSend;
  }
  return sent;
}

test('updateCompactionSettings preserves omitted and cleared global limits', () => {
  const sent = captureCommands(() => {
    updateCompactionSettings({ compactionTokenLimitPerModel: { 'model-a': 100_000 } });
    updateCompactionSettings({ compactionTokenLimit: null, compactionTokenLimitPerModel: {} });
    updateCompactionSettings({ compactionTokenLimit: 200_000, compactionTokenLimitPerModel: {} });
    updateCompactionSettings({
      compactionTokenLimit: 'factory-default',
      compactionTokenLimitPerModel: {},
    });
  });

  assert.deepEqual(sent, [
    {
      type: 'settings.compaction.update',
      compactionTokenLimitPerModel: { 'model-a': 100_000 },
    },
    {
      type: 'settings.compaction.update',
      compactionTokenLimit: null,
      compactionTokenLimitPerModel: {},
    },
    {
      type: 'settings.compaction.update',
      compactionTokenLimit: 200_000,
      compactionTokenLimitPerModel: {},
    },
    {
      type: 'settings.compaction.update',
      compactionTokenLimit: 'factory-default',
      compactionTokenLimitPerModel: {},
    },
  ]);
});

test('resumeMission forwards current compaction settings', () => {
  const sent = captureCommands(() => {
    resumeMission('session-1', {
      compactionTokenLimit: 100_000,
      compactionTokenLimitPerModel: { 'model-a': 80_000 },
    });
  });

  assert.deepEqual(sent, [
    {
      type: 'mission.resume',
      sessionId: 'session-1',
      compactionTokenLimit: 100_000,
      compactionTokenLimitPerModel: { 'model-a': 80_000 },
    },
  ]);
});

test('command wrappers send their bridge payloads', () => {
  const refA = newClientRef();
  const refB = newClientRef();
  assert.match(refA, /^c-/);
  assert.notEqual(refA, refB);

  const sent = captureCommands(() => {
    connect('api-key');
    createMission({
      clientRef: 'client-1',
      cwd: '/tmp/project',
      title: 'Ship',
      goal: 'Fix it',
      interactionMode: 'agi',
      modelId: 'model-a',
      reasoningEffort: 'high',
      compactionModel: 'current-model',
      compactionTokenLimit: 100_000,
      compactionTokenLimitPerModel: { 'model-a': 90_000 },
      autonomy: 'high',
      workerModel: 'worker-a',
      workerReasoning: 'medium',
      validatorModel: 'validator-a',
      validatorReasoning: 'low',
    });
    updateSessionSettings({
      sessionId: 'session-1',
      modelId: null,
      reasoningEffort: 'medium',
      autonomy: 'medium',
    });
    detectEnv();
    installCli('npm');
    updateCli('brew');
    startCliLogin();
    requestRuntimeStatus();
    listModels();
    listSkills('session-1');
    listFactoryDefaults();
    sendToMission('mission-1', 'hello', { compactionTokenLimit: 100_000 });
    sendToMissionNow('mission-1', 'now');
    sendToAgent('mission-1', 'agent-1', 'worker hello', { compactionTokenLimit: 80_000 });
    sendToAgentNow('mission-1', 'agent-1', 'worker now');
    respondPermission('mission-1', 'perm-1', 'proceed_once', { compactionTokenLimit: 100_000 });
    respondQuestion('mission-1', 'question-1', false, [
      { index: 0, question: 'Continue?', answer: 'yes' },
    ]);
    interruptMission('mission-1');
    compactSession('mission-1', 'keep recent edits');
    interruptAgent('mission-1', 'agent-1');
    setMissionAutonomy('mission-1', 'medium');
    setInteractionMode('mission-1', 'spec');
    subscribeWorker('mission-1', 'worker-1');
    closeMission('mission-1');
    listMissions({
      workspaceCwds: ['/tmp/project'],
      includePlainChats: true,
      limitPerWorkspace: 5,
    });
    loadMissionHistory('mission-1');
    loadOlderMissionHistory('mission-1', 'cursor-1');
    updateAgentSettings({
      missionId: 'mission-1',
      agent: 'worker',
      modelId: 'worker-a',
      reasoningEffort: 'high',
    });
    openBrowser({
      missionId: 'mission-1',
      url: 'https://example.com',
      viewport: { width: 1024, height: 768 },
      viewportMode: 'desktop',
    });
    closeBrowser('mission-1');
    reloadBrowser('mission-1');
    refreshBrowser('mission-1');
    resizeBrowserViewport({
      missionId: 'mission-1',
      viewport: { width: 390, height: 844 },
      viewportMode: 'mobile',
    });
    clickBrowser({ missionId: 'mission-1', ref: 'button', source: 'user' });
    typeBrowser('mission-1', 'typed');
    keypressBrowser('mission-1', 'Enter');
    scrollBrowser({ missionId: 'mission-1', direction: 'down', pixels: 300, source: 'agent' });
    addDesignReference('mission-1', {
      id: 'ref-1',
      anchor: {
        id: 'anchor-1',
        kind: 'element',
        label: 'Button',
        box: { x: 1, y: 2, width: 3, height: 4 },
      },
      url: 'https://example.com',
    });
    sendDesignPrompt('mission-1', 'polish this', ['ref-1'], { compactionTokenLimit: 100_000 });
    sendNativeBrowserResult({ requestId: 'native-1', missionId: 'mission-1', ok: true });
  });

  assert.deepEqual(
    sent.map((cmd) => cmd.type),
    [
      'connect',
      'mission.create',
      'session.updateSettings',
      'env.detect',
      'cli.install',
      'cli.update',
      'auth.startCliLogin',
      'runtime.status',
      'models.list',
      'catalog.skills',
      'settings.defaults',
      'mission.send',
      'mission.sendNow',
      'agent.send',
      'agent.sendNow',
      'mission.respondPermission',
      'mission.respondQuestion',
      'mission.interrupt',
      'mission.compact',
      'agent.interrupt',
      'mission.setAutonomy',
      'mission.setInteractionMode',
      'mission.subscribeWorker',
      'mission.close',
      'mission.list',
      'mission.loadHistory',
      'mission.loadHistory',
      'settings.agent.update',
      'browser.open',
      'browser.close',
      'browser.reload',
      'browser.refresh',
      'browser.resizeViewport',
      'browser.click',
      'browser.type',
      'browser.keypress',
      'browser.scroll',
      'browser.design.addReference',
      'browser.design.sendPrompt',
      'browser.native.result',
    ],
  );
  assert.deepEqual(sent[11], {
    type: 'mission.send',
    missionId: 'mission-1',
    text: 'hello',
    compactionTokenLimit: 100_000,
  });
  assert.deepEqual(sent[18], {
    type: 'mission.compact',
    missionId: 'mission-1',
    customInstructions: 'keep recent edits',
  });
  assert.deepEqual(sent.at(-1), {
    type: 'browser.native.result',
    result: { requestId: 'native-1', missionId: 'mission-1', ok: true },
  });
});
