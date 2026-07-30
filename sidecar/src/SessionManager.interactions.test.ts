import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ToolConfirmationOutcome,
  ToolConfirmationType,
  type AskUserRequestParams,
  type RequestPermissionRequestParams,
} from '@factory/droid-sdk';

import type { SessionSummary, ServerEvent } from './protocol.js';
import { writeProviderSessionStart } from './testing/historyCharacterizationSupport.js';
import type { RecordedCall } from './testing/fakeFactoryRuntime.js';
import { createSessionManagerTestContext } from './testing/sessionManagerTestContext.js';

type PermissionRequestedEvent = Extract<ServerEvent, { type: 'approval.requested' }>;
type ApprovalRequestedEvent = Extract<ServerEvent, { type: 'approval.requested' }>;
type SessionQuestionEvent = Extract<ServerEvent, { type: 'question.requested' }>;
type QuestionRequestedEvent = Extract<ServerEvent, { type: 'question.requested' }>;
type SessionUpdatedEvent = Extract<ServerEvent, { type: 'session.updated' }>;

const isPermissionRequested = (event: ServerEvent): event is PermissionRequestedEvent =>
  event.type === 'approval.requested';
const isApprovalRequested = (event: ServerEvent): event is ApprovalRequestedEvent =>
  event.type === 'approval.requested';
const isSessionQuestion = (event: ServerEvent): event is SessionQuestionEvent =>
  event.type === 'question.requested';
const isQuestionRequested = (event: ServerEvent): event is QuestionRequestedEvent =>
  event.type === 'question.requested';
const isSessionUpdated = (event: ServerEvent): event is SessionUpdatedEvent =>
  event.type === 'session.updated';

function permissionInput(toolUseId: string): RequestPermissionRequestParams {
  return {
    toolUses: [
      {
        toolUse: {
          type: 'tool_use',
          id: toolUseId,
          name: 'Bash',
          input: { command: 'pwd' },
        },
        confirmationType: ToolConfirmationType.Execute,
        details: {
          type: ToolConfirmationType.Execute,
          fullCommand: 'pwd',
          command: 'pwd',
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

function questionInput(toolCallId: string): AskUserRequestParams {
  return {
    toolCallId,
    questions: [
      {
        index: 0,
        topic: 'choice',
        question: 'Proceed?',
        options: ['yes', 'no'],
      },
    ],
  };
}

function historicalSummary(appSessionId: string, providerSessionId: string): SessionSummary {
  const now = Date.now();
  return {
    appSessionId,
    providerSessionId,
    sessionPurpose: 'chat',
    interactionMode: 'auto',
    role: 'primary',
    title: `Historical ${appSessionId}`,
    goal: '',
    cwd: '',
    workspaceKind: 'none',
    autonomy: 'low',
    phase: 'paused',
    streaming: false,
    compacting: false,
    queuedSends: 0,
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function permissionRequest(events: ServerEvent[]): PermissionRequestedEvent {
  const event = events.find(isPermissionRequested);
  assert.ok(event);
  return event;
}

function approvalRequested(events: ServerEvent[]): ApprovalRequestedEvent {
  const event = events.find(isApprovalRequested);
  assert.ok(event);
  return event;
}

function latestQuestion(events: ServerEvent[]): SessionQuestionEvent {
  const event = events.filter(isSessionQuestion).at(-1);
  assert.ok(event);
  return event;
}

function isSpecTransitionPublication(call: RecordedCall): boolean {
  const event = call.args[0];
  if (
    call.target !== 'protocol' ||
    call.method !== 'event' ||
    typeof event !== 'object' ||
    event === null ||
    !('type' in event) ||
    event.type !== 'session.updated' ||
    !('session' in event) ||
    typeof event.session !== 'object' ||
    event.session === null
  )
    return false;
  return (
    'interactionMode' in event.session &&
    event.session.interactionMode === 'auto' &&
    'phase' in event.session &&
    event.session.phase === 'running'
  );
}

test(
  '[P1] Permission response keeps the stable app identity and emits both request events',
  { concurrency: false },
  async () => {
    const h = createSessionManagerTestContext();

    try {
      h.fixture.seedHistorySummaries([historicalSummary('app-p1', 'provider-p1')]);
      writeProviderSessionStart(h.home, 'provider-p1', 'Historical app-p1');
      await h.handle({ type: 'session.resume', appSessionId: 'app-p1' });

      const handler = h.provider.session('provider-p1').handlers.permissionHandler;
      assert.ok(handler);
      const pending = Promise.resolve(handler(permissionInput('p1')));
      const requested = permissionRequest(h.events);
      const mirrored = approvalRequested(h.events);

      assert.equal(requested.request.appSessionId, 'app-p1');
      assert.equal(h.runtime.loadCalls[0]?.sessionId, 'provider-p1');
      assert.deepEqual(mirrored.request, requested.request);
      assert.equal(h.events.filter(isPermissionRequested).length, 1);
      assert.equal(h.events.filter(isApprovalRequested).length, 1);

      await h.handle({
        type: 'approval.respond',
        appSessionId: requested.request.appSessionId,
        requestId: requested.request.requestId,
        outcome: 'proceed_once',
      });

      assert.equal(await pending, ToolConfirmationOutcome.ProceedOnce);
    } finally {
      await h.dispose();
    }
  },
);

test(
  '[P2] Always-grant responses bypass an identical later permission request',
  { concurrency: false },
  async () => {
    const h = createSessionManagerTestContext();

    try {
      await h.create({
        sessionPurpose: 'chat',
        clientRef: 'p2',
        title: 'P2',
        goal: 'go',
        interactionMode: 'auto',
        autonomy: 'low',
      });

      const handler = h.provider.session('provider-1').handlers.permissionHandler;
      assert.ok(handler);
      const first = Promise.resolve(handler(permissionInput('p2')));
      const requested = permissionRequest(h.events);

      await h.handle({
        type: 'approval.respond',
        appSessionId: requested.request.appSessionId,
        requestId: requested.request.requestId,
        outcome: 'proceed_always',
      });

      assert.equal(await first, ToolConfirmationOutcome.ProceedAlways);
      assert.equal(await handler(permissionInput('p2')), ToolConfirmationOutcome.ProceedAlways);
      assert.equal(h.events.filter(isPermissionRequested).length, 1);
      assert.equal(h.events.filter(isApprovalRequested).length, 1);
    } finally {
      await h.dispose();
    }
  },
);

test(
  '[P3] Permission responses ignore invalid ids and duplicate or late replies',
  { concurrency: false },
  async () => {
    const h = createSessionManagerTestContext();

    try {
      await h.create({
        sessionPurpose: 'chat',
        clientRef: 'p3',
        title: 'P3',
        goal: 'go',
        interactionMode: 'auto',
        autonomy: 'low',
      });

      const handler = h.provider.session('provider-1').handlers.permissionHandler;
      assert.ok(handler);
      let resolutionCount = 0;
      const pending = Promise.resolve(handler(permissionInput('p3'))).then((outcome) => {
        resolutionCount += 1;
        return outcome;
      });
      const requested = permissionRequest(h.events);

      await h.handle({
        type: 'approval.respond',
        appSessionId: requested.request.appSessionId,
        requestId: `${requested.request.requestId}-unknown`,
        outcome: 'proceed_once',
      });
      await h.waitForIdle();
      assert.equal(resolutionCount, 0);

      await h.handle({
        type: 'approval.respond',
        appSessionId: requested.request.appSessionId,
        requestId: requested.request.requestId,
        outcome: 'cancel',
      });
      assert.equal(await pending, ToolConfirmationOutcome.Cancel);

      await h.handle({
        type: 'approval.respond',
        appSessionId: requested.request.appSessionId,
        requestId: requested.request.requestId,
        outcome: 'proceed_once',
      });
      await h.handle({
        type: 'approval.respond',
        appSessionId: 'late-session',
        requestId: requested.request.requestId,
        outcome: 'proceed_once',
      });
      await h.waitForIdle();

      assert.equal(resolutionCount, 1);
    } finally {
      await h.dispose();
    }
  },
);

test(
  '[P4] Spec approval updates the provider before completing the permission callback',
  { concurrency: false },
  async () => {
    const h = createSessionManagerTestContext();

    try {
      await h.create({
        sessionPurpose: 'chat',
        clientRef: 'p4',
        title: 'P4',
        goal: 'go',
        interactionMode: 'spec',
        autonomy: 'low',
      });

      const handler = h.provider.session('provider-1').handlers.permissionHandler;
      assert.ok(handler);
      const pending = Promise.resolve(handler(specApprovalInput('p4')));
      const requested = permissionRequest(h.events);
      assert.equal(requested.request.kind, 'spec');

      const responseCallOffset = h.calls.length;
      let callbackObservedProviderUpdate = false;
      const completed = pending.then((outcome) => {
        callbackObservedProviderUpdate = h.calls
          .slice(responseCallOffset)
          .some((call) => call.target === 'provider' && call.method === 'updateSettings');
        return outcome;
      });

      await h.handle({
        type: 'approval.respond',
        appSessionId: requested.request.appSessionId,
        requestId: requested.request.requestId,
        outcome: 'proceed_once',
      });

      const responseCalls = h.calls.slice(responseCallOffset);
      const publicationIndex = responseCalls.findIndex(isSpecTransitionPublication);
      const providerIndex = responseCalls.findIndex(
        (call) => call.target === 'provider' && call.method === 'updateSettings',
      );
      assert.ok(publicationIndex >= 0);
      assert.ok(providerIndex > publicationIndex);
      assert.equal(await completed, ToolConfirmationOutcome.ProceedOnce);
      assert.equal(callbackObservedProviderUpdate, true);
      assert.deepEqual(
        h.calls
          .slice(responseCallOffset)
          .filter((call) => call.target === 'provider')
          .map((call) => call.method),
        ['updateSettings'],
      );
      assert.equal(
        h.provider
          .session('provider-1')
          .settings.some((settings) => settings['interactionMode'] === 'auto'),
        true,
      );
      const transition = h.events.filter(isSessionUpdated).at(-1);
      assert.ok(transition);
      assert.equal(transition.session.interactionMode, 'auto');
      assert.equal(transition.session.sessionPurpose, 'chat');
      assert.equal(transition.session.missionId, undefined);
      assert.equal(transition.session.phase, 'running');
    } finally {
      await h.dispose();
    }
  },
);

test(
  '[Q1] Question answers and cancellation each resolve the provider callback once',
  { concurrency: false },
  async () => {
    const h = createSessionManagerTestContext();

    try {
      await h.create({
        sessionPurpose: 'chat',
        clientRef: 'q1',
        title: 'Q1',
        goal: 'go',
        interactionMode: 'auto',
        autonomy: 'low',
      });

      const handler = h.provider.session('provider-1').handlers.askUserHandler;
      assert.ok(handler);

      let answerResolutionCount = 0;
      const answered = Promise.resolve(handler(questionInput('q-answer'))).then((result) => {
        answerResolutionCount += 1;
        return result;
      });
      const answerRequest = latestQuestion(h.events);
      const answerMirror = h.events.find(isQuestionRequested);
      assert.ok(answerMirror);
      assert.deepEqual(answerMirror.question, answerRequest.question);
      assert.equal(h.events.filter(isSessionQuestion).length, 1);
      assert.equal(h.events.filter(isQuestionRequested).length, 1);

      await h.handle({
        type: 'question.respond',
        appSessionId: answerRequest.question.appSessionId,
        requestId: answerRequest.question.requestId,
        cancelled: false,
        answers: [{ index: 0, question: 'Proceed?', answer: 'yes' }],
      });
      assert.deepEqual(await answered, {
        cancelled: false,
        answers: [{ index: 0, question: 'Proceed?', answer: 'yes' }],
      });

      await h.handle({
        type: 'question.respond',
        appSessionId: answerRequest.question.appSessionId,
        requestId: answerRequest.question.requestId,
        cancelled: true,
        answers: [],
      });
      await h.waitForIdle();
      assert.equal(answerResolutionCount, 1);

      let cancellationResolutionCount = 0;
      const cancelled = Promise.resolve(handler(questionInput('q-cancel'))).then((result) => {
        cancellationResolutionCount += 1;
        return result;
      });
      const cancellationRequest = latestQuestion(h.events);

      await h.handle({
        type: 'question.respond',
        appSessionId: cancellationRequest.question.appSessionId,
        requestId: cancellationRequest.question.requestId,
        cancelled: true,
        answers: [],
      });
      assert.deepEqual(await cancelled, { cancelled: true, answers: [] });

      await h.handle({
        type: 'question.respond',
        appSessionId: cancellationRequest.question.appSessionId,
        requestId: cancellationRequest.question.requestId,
        cancelled: false,
        answers: [{ index: 0, question: 'Proceed?', answer: 'no' }],
      });
      await h.waitForIdle();

      assert.equal(cancellationResolutionCount, 1);
      assert.equal(h.events.filter(isSessionQuestion).length, 2);
      assert.equal(h.events.filter(isQuestionRequested).length, 2);
    } finally {
      await h.dispose();
    }
  },
);

test('close preserves current interaction lifetime and forgets unresolved state at unregister', async () => {
  const h = createSessionManagerTestContext();
  let releaseClose = (): void => undefined;

  try {
    await h.create({
      sessionPurpose: 'chat',
      clientRef: 'interaction-close',
      title: 'Interaction close',
      goal: 'go',
      interactionMode: 'auto',
      autonomy: 'low',
    });
    const provider = h.provider.session('provider-1');
    await provider.waitForPrompts(1);
    await h.waitForIdle();
    const closeGate = provider.deferNextClose();
    releaseClose = () => closeGate.resolve();
    const closing = h.handle({ type: 'session.close', appSessionId: 'provider-1' });
    await h.waitForIdle();
    assert.equal(
      h.calls.some(
        (call) =>
          call.target === 'cleanup' &&
          call.method === 'session.close' &&
          call.args[0] === 'provider-1',
      ),
      true,
    );

    const permissionHandler = provider.handlers.permissionHandler;
    assert.ok(permissionHandler);
    let permissionSettlements = 0;
    const permission = Promise.resolve(permissionHandler(permissionInput('during-close'))).then(
      (outcome) => {
        permissionSettlements += 1;
        return outcome;
      },
    );
    const approval = approvalRequested(h.events).request;
    assert.equal(permissionSettlements, 0);
    await h.handle({
      type: 'approval.respond',
      appSessionId: approval.appSessionId,
      requestId: approval.requestId,
      outcome: 'proceed_once',
    });
    assert.equal(await permission, ToolConfirmationOutcome.ProceedOnce);
    assert.equal(permissionSettlements, 1);

    const askUserHandler = provider.handlers.askUserHandler;
    assert.ok(askUserHandler);
    let questionSettlements = 0;
    void Promise.resolve(askUserHandler(questionInput('unresolved-at-close'))).then(() => {
      questionSettlements += 1;
    });
    const question = latestQuestion(h.events).question;

    closeGate.resolve();
    await closing;
    await h.waitForIdle();
    assert.equal(questionSettlements, 0);
    await h.handle({ type: 'session.resume', appSessionId: question.appSessionId });
    await h.waitForIdle();
    const eventCountAfterResume = h.events.length;

    await h.handle({
      type: 'question.respond',
      appSessionId: question.appSessionId,
      requestId: question.requestId,
      cancelled: true,
      answers: [],
    });
    assert.equal(questionSettlements, 0);
    assert.equal(h.events.length, eventCountAfterResume);
  } finally {
    releaseClose();
    await h.dispose();
  }
});

test('ask-user requests tolerate omitted questions and options', async () => {
  const h = createSessionManagerTestContext();

  try {
    await h.create({
      sessionPurpose: 'chat',
      clientRef: 'question-defaults',
      title: 'Question defaults',
      goal: 'go',
      interactionMode: 'auto',
      autonomy: 'low',
    });

    const handler = h.provider.session('provider-1').handlers.askUserHandler;
    assert.ok(handler);

    const emptyRequestResult = Promise.resolve(
      handler({ toolCallId: 'q-empty' } as AskUserRequestParams),
    );
    const emptyRequest = latestQuestion(h.events);
    assert.deepEqual(emptyRequest.question.questions, []);
    await h.handle({
      type: 'question.respond',
      appSessionId: emptyRequest.question.appSessionId,
      requestId: emptyRequest.question.requestId,
      cancelled: true,
      answers: [],
    });
    assert.deepEqual(await emptyRequestResult, { cancelled: true, answers: [] });

    const freeFormResult = Promise.resolve(
      handler({
        toolCallId: 'q-free-form',
        questions: [{ index: 0, topic: 'input', question: 'What should change?' }],
      } as AskUserRequestParams),
    );
    const freeFormRequest = latestQuestion(h.events);
    assert.deepEqual(freeFormRequest.question.questions, [
      { index: 0, question: 'What should change?', options: [] },
    ]);
    await h.handle({
      type: 'question.respond',
      appSessionId: freeFormRequest.question.appSessionId,
      requestId: freeFormRequest.question.requestId,
      cancelled: false,
      answers: [{ index: 0, question: 'What should change?', answer: 'The title' }],
    });
    assert.deepEqual(await freeFormResult, {
      cancelled: false,
      answers: [{ index: 0, question: 'What should change?', answer: 'The title' }],
    });
  } finally {
    await h.dispose();
  }
});
