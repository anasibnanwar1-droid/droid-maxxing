import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ToolConfirmationOutcome,
  ToolConfirmationType,
  type AskUserRequestParams,
  type RequestPermissionRequestParams,
  type UpdateSessionSettingsRequestParams,
} from '@factory/droid-sdk';

import type { ServerEvent, SessionSummary } from './protocol.js';
import { SessionInteractions, type InteractionLiveSession } from './SessionInteractions.js';

interface HarnessOptions {
  rejectProviderUpdate?: boolean;
  throwSummaryUpdate?: boolean;
}

function createHarness(options: HarnessOptions = {}) {
  const emitted: ServerEvent[] = [];
  const errors: Array<Omit<Extract<ServerEvent, { type: 'error' }>, 'type'>> = [];
  const trace: string[] = [];
  const liveSessions = new Map<string, InteractionLiveSession>();

  const addLiveSession = (appSessionId: string, providerSessionId = appSessionId) => {
    const liveSession: InteractionLiveSession = {
      summary: summary(appSessionId, providerSessionId),
      session: {
        updateSettings: (settings: Partial<UpdateSessionSettingsRequestParams>) => {
          trace.push(`provider:${String(settings.interactionMode ?? '')}`);
          return options.rejectProviderUpdate
            ? Promise.reject(new Error('provider rejected'))
            : Promise.resolve({});
        },
      },
    };
    liveSessions.set(appSessionId, liveSession);
    return liveSession;
  };
  const interactions = new SessionInteractions({
    getLiveSession: (id) =>
      [...liveSessions.values()].find(
        (liveSession) =>
          liveSession.summary.appSessionId === id || liveSession.summary.providerSessionId === id,
      ),
    updateSummary: (id, patch) => {
      const liveSession = liveSessions.get(id);
      if (!liveSession) return;
      trace.push(`publish:${String(patch.interactionMode ?? patch.phase ?? '')}`);
      if (options.throwSummaryUpdate) throw new Error('summary persistence failed');
      Object.assign(liveSession.summary, patch);
    },
    emit: (event) => {
      emitted.push(event);
    },
    emitError: (error) => {
      trace.push(`error:${error.code ?? ''}`);
      errors.push(error);
    },
  });
  return { addLiveSession, emitted, errors, interactions, liveSessions, trace };
}

function summary(appSessionId: string, providerSessionId: string): SessionSummary {
  return {
    appSessionId,
    providerSessionId,
    sessionPurpose: 'chat',
    interactionMode: 'auto',
    role: 'primary',
    title: appSessionId,
    goal: appSessionId,
    cwd: '/workspace',
    workspaceKind: 'folder',
    autonomy: 'low',
    phase: 'paused',
    compacting: false,
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

function permissionInput(toolUseId: string, command = 'pwd'): RequestPermissionRequestParams {
  return {
    toolUses: [
      {
        toolUse: {
          type: 'tool_use',
          id: toolUseId,
          name: 'Bash',
          input: { command },
        },
        confirmationType: ToolConfirmationType.Execute,
        details: {
          type: ToolConfirmationType.Execute,
          fullCommand: command,
          command,
        },
      },
    ],
    options: [],
  };
}

function specApprovalInput(toolUseId: string): RequestPermissionRequestParams {
  return {
    toolUses: [
      {
        toolUse: {
          type: 'tool_use',
          id: toolUseId,
          name: 'ExitSpecMode',
          input: {},
        },
        confirmationType: ToolConfirmationType.ExitSpecMode,
        details: {
          type: ToolConfirmationType.ExitSpecMode,
          plan: 'Run the reviewed plan.',
        },
      },
    ],
    options: [],
  };
}

function approvalRequests(events: ServerEvent[]) {
  return events.filter(
    (event): event is Extract<ServerEvent, { type: 'approval.requested' }> =>
      event.type === 'approval.requested',
  );
}

function questionRequests(events: ServerEvent[]) {
  return events.filter(
    (event): event is Extract<ServerEvent, { type: 'question.requested' }> =>
      event.type === 'question.requested',
  );
}

function latestApprovalRequest(events: ServerEvent[]) {
  const event = approvalRequests(events).at(-1);
  assert.ok(event);
  return event.request;
}

function latestQuestionRequest(events: ServerEvent[]) {
  const event = questionRequests(events).at(-1);
  assert.ok(event);
  return event.question;
}

test('permission requests keep stable identity, exact correlation, and one event', async () => {
  const harness = createHarness();
  harness.addLiveSession('app-1', 'provider-1');
  const handler = harness.interactions.makePermissionHandler({ id: 'app-1' });

  const pending = Promise.resolve(handler(permissionInput('tool-1')));
  const requests = approvalRequests(harness.emitted);

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.request.appSessionId, 'app-1');
  assert.match(requests[0]?.request.requestId ?? '', /^req-/);
  const requestId = latestApprovalRequest(harness.emitted).requestId;
  await harness.interactions.respondToApproval('app-1', requestId, 'proceed_once');
  assert.equal(await pending, ToolConfirmationOutcome.ProceedOnce);
});

test('ProceedAlways bypasses only an equivalent later permission signature', async () => {
  const harness = createHarness();
  harness.addLiveSession('app-1');
  const handler = harness.interactions.makePermissionHandler({ id: 'app-1' });
  const first = Promise.resolve(handler(permissionInput('tool-1', 'pwd')));
  const firstRequestId = latestApprovalRequest(harness.emitted).requestId;

  await harness.interactions.respondToApproval('app-1', firstRequestId, 'proceed_always');
  assert.equal(await first, ToolConfirmationOutcome.ProceedAlways);
  assert.equal(
    await handler(permissionInput('tool-2', 'pwd')),
    ToolConfirmationOutcome.ProceedAlways,
  );
  assert.equal(approvalRequests(harness.emitted).length, 1);

  const different = Promise.resolve(handler(permissionInput('tool-3', 'ls')));
  assert.equal(approvalRequests(harness.emitted).length, 2);
  const differentRequestId = latestApprovalRequest(harness.emitted).requestId;
  await harness.interactions.respondToApproval('app-1', differentRequestId, 'cancel');
  assert.equal(await different, ToolConfirmationOutcome.Cancel);
});

test('invalid outcomes emit an error, settle Cancel once, and create no grant', async () => {
  const harness = createHarness();
  harness.addLiveSession('app-1');
  const handler = harness.interactions.makePermissionHandler({ id: 'app-1' });
  let settlements = 0;
  const first = Promise.resolve(handler(permissionInput('tool-1'))).then((outcome) => {
    settlements += 1;
    return outcome;
  });
  const firstRequestId = latestApprovalRequest(harness.emitted).requestId;

  await harness.interactions.respondToApproval('app-1', firstRequestId, 'not-an-outcome');

  assert.equal(await first, ToolConfirmationOutcome.Cancel);
  assert.equal(settlements, 1);
  assert.equal(harness.errors[0]?.code, 'permission.invalid_outcome');
  const second = Promise.resolve(handler(permissionInput('tool-2')));
  assert.equal(approvalRequests(harness.emitted).length, 2);
  const secondRequestId = latestApprovalRequest(harness.emitted).requestId;
  await harness.interactions.respondToApproval('app-1', secondRequestId, 'cancel');
  await second;
  assert.equal(settlements, 1);
});

test('unknown, duplicate, late, and wrong-session approvals settle at most once', async () => {
  const harness = createHarness();
  harness.addLiveSession('app-1');
  harness.addLiveSession('app-2');
  const handler = harness.interactions.makePermissionHandler({ id: 'app-1' });
  let settlements = 0;
  const pending = Promise.resolve(handler(permissionInput('tool-1'))).then((outcome) => {
    settlements += 1;
    return outcome;
  });
  const requestId = latestApprovalRequest(harness.emitted).requestId;

  await harness.interactions.respondToApproval('app-2', requestId, 'proceed_once');
  await harness.interactions.respondToApproval('app-1', 'unknown', 'proceed_once');
  await Promise.resolve();
  assert.equal(settlements, 0);
  await harness.interactions.respondToApproval('app-1', requestId, 'cancel');
  assert.equal(await pending, ToolConfirmationOutcome.Cancel);
  await harness.interactions.respondToApproval('app-1', requestId, 'proceed_once');
  harness.liveSessions.delete('app-1');
  await harness.interactions.respondToApproval('app-1', requestId, 'proceed_once');
  assert.equal(settlements, 1);
});

test('Spec approval publishes, attempts provider update, then settles the callback', async () => {
  const success = createHarness();
  const liveSession = success.addLiveSession('app-spec');
  liveSession.summary.interactionMode = 'spec';
  const handler = success.interactions.makePermissionHandler({ id: 'app-spec' });
  const pending = Promise.resolve(handler(specApprovalInput('tool-spec'))).then((outcome) => {
    success.trace.push('callback');
    return outcome;
  });
  const requestId = latestApprovalRequest(success.emitted).requestId;

  await success.interactions.respondToApproval('app-spec', requestId, 'proceed_once');

  assert.equal(await pending, ToolConfirmationOutcome.ProceedOnce);
  assert.deepEqual(success.trace, ['publish:auto', 'provider:auto', 'callback']);
  assert.equal(liveSession.summary.phase, 'running');

  const rejected = createHarness({ rejectProviderUpdate: true });
  rejected.addLiveSession('app-spec');
  const rejectedHandler = rejected.interactions.makePermissionHandler({ id: 'app-spec' });
  const rejectedPending = Promise.resolve(rejectedHandler(specApprovalInput('tool-spec'))).then(
    (outcome) => {
      rejected.trace.push('callback');
      return outcome;
    },
  );
  const rejectedRequestId = latestApprovalRequest(rejected.emitted).requestId;
  await rejected.interactions.respondToApproval('app-spec', rejectedRequestId, 'proceed_once');
  assert.equal(await rejectedPending, ToolConfirmationOutcome.ProceedOnce);
  assert.deepEqual(rejected.trace, [
    'publish:auto',
    'provider:auto',
    'error:spec.exit_failed',
    'callback',
  ]);
});

test('Spec approval reports summary failure and still settles the callback once', async () => {
  const harness = createHarness({ throwSummaryUpdate: true });
  harness.addLiveSession('app-spec');
  const handler = harness.interactions.makePermissionHandler({ id: 'app-spec' });
  let settlements = 0;
  const pending = Promise.resolve(handler(specApprovalInput('tool-spec'))).then((outcome) => {
    settlements += 1;
    harness.trace.push('callback');
    return outcome;
  });
  const requestId = latestApprovalRequest(harness.emitted).requestId;

  await harness.interactions.respondToApproval('app-spec', requestId, 'proceed_once');

  assert.equal(await pending, ToolConfirmationOutcome.ProceedOnce);
  assert.equal(settlements, 1);
  assert.deepEqual(harness.trace, ['publish:auto', 'error:spec.exit_failed', 'callback']);
  assert.equal(harness.errors[0]?.code, 'spec.exit_failed');
  assert.match(harness.errors[0]?.message ?? '', /summary persistence failed/);

  await harness.interactions.respondToApproval('app-spec', requestId, 'proceed_once');
  assert.equal(settlements, 1);
});

test('ask-user normalizes omitted values and preserves identities and answers', async () => {
  const harness = createHarness();
  harness.addLiveSession('app-1');
  const handler = harness.interactions.makeAskUserHandler({ id: 'app-1' });
  const input = {
    toolCallId: 'question-tool',
    questions: [{ index: 7, topic: 'input', question: 'What should change?' }],
  } as AskUserRequestParams;
  const pending = Promise.resolve(handler(input));
  const request = latestQuestionRequest(harness.emitted);

  assert.equal(request.appSessionId, 'app-1');
  assert.match(request.requestId, /^req-/);
  assert.deepEqual(request.questions, [{ index: 7, question: 'What should change?', options: [] }]);
  const answers = [{ index: 7, question: 'What should change?', answer: 'The title' }];
  harness.interactions.respondToQuestion('app-1', request.requestId, false, answers);
  assert.deepEqual(await pending, { cancelled: false, answers });

  const empty = Promise.resolve(handler({ toolCallId: 'empty' } as AskUserRequestParams));
  assert.deepEqual(questionRequests(harness.emitted).at(-1)?.question.questions, []);
  const emptyRequestId = latestQuestionRequest(harness.emitted).requestId;
  harness.interactions.respondToQuestion('app-1', emptyRequestId, true, []);
  assert.deepEqual(await empty, { cancelled: true, answers: [] });
});

test('question answers, cancellation, duplicate, late, and wrong-session responses settle once', async () => {
  const harness = createHarness();
  harness.addLiveSession('app-1');
  harness.addLiveSession('app-2');
  const handler = harness.interactions.makeAskUserHandler({ id: 'app-1' });
  let settlements = 0;
  const pending = Promise.resolve(handler({ toolCallId: 'question', questions: [] })).then(
    (result) => {
      settlements += 1;
      return result;
    },
  );
  const requestId = latestQuestionRequest(harness.emitted).requestId;

  harness.interactions.respondToQuestion('app-2', requestId, false, []);
  harness.interactions.respondToQuestion('app-1', 'unknown', false, []);
  await Promise.resolve();
  assert.equal(settlements, 0);
  harness.interactions.respondToQuestion('app-1', requestId, true, []);
  assert.deepEqual(await pending, { cancelled: true, answers: [] });
  harness.interactions.respondToQuestion('app-1', requestId, false, []);
  harness.liveSessions.delete('app-1');
  harness.interactions.respondToQuestion('app-1', requestId, false, []);
  assert.equal(settlements, 1);
});

test('forgetSession is protocol-silent, resolves nothing, and discards owned state', async () => {
  const harness = createHarness();
  harness.addLiveSession('app-1');
  const handler = harness.interactions.makePermissionHandler({ id: 'app-1' });
  const granted = Promise.resolve(handler(permissionInput('grant')));
  const grantRequestId = latestApprovalRequest(harness.emitted).requestId;
  await harness.interactions.respondToApproval('app-1', grantRequestId, 'proceed_always');
  await granted;
  assert.equal(await handler(permissionInput('bypass')), ToolConfirmationOutcome.ProceedAlways);

  let pendingSettled = false;
  void Promise.resolve(handler(permissionInput('pending', 'whoami'))).then(() => {
    pendingSettled = true;
  });
  const eventCount = harness.emitted.length;
  const errorCount = harness.errors.length;
  harness.liveSessions.delete('app-1');

  harness.interactions.forgetSession('app-1');
  await Promise.resolve();

  assert.equal(pendingSettled, false);
  assert.equal(harness.emitted.length, eventCount);
  assert.equal(harness.errors.length, errorCount);

  harness.addLiveSession('app-1');
  const afterResume = Promise.resolve(handler(permissionInput('after-resume')));
  const request = approvalRequests(harness.emitted).at(-1);
  assert.ok(request);
  await harness.interactions.respondToApproval('app-1', request.request.requestId, 'cancel');
  assert.equal(await afterResume, ToolConfirmationOutcome.Cancel);
});
