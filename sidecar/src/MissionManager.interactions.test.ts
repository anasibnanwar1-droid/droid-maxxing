import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ToolConfirmationOutcome,
  ToolConfirmationType,
  type AskUserRequestParams,
  type RequestPermissionRequestParams,
} from '@factory/droid-sdk';

import { createSessionCharacterizationHarness } from './testing/sessionCharacterizationHarness.js';
import type { MissionSummary, ServerEvent } from './protocol.js';

type MissionPermissionEvent = Extract<ServerEvent, { type: 'mission.permission' }>;
type ApprovalRequestedEvent = Extract<ServerEvent, { type: 'approval.requested' }>;
type MissionQuestionEvent = Extract<ServerEvent, { type: 'mission.question' }>;
type QuestionRequestedEvent = Extract<ServerEvent, { type: 'question.requested' }>;
type MissionUpdatedEvent = Extract<ServerEvent, { type: 'mission.updated' }>;

const isMissionPermission = (event: ServerEvent): event is MissionPermissionEvent =>
  event.type === 'mission.permission';
const isApprovalRequested = (event: ServerEvent): event is ApprovalRequestedEvent =>
  event.type === 'approval.requested';
const isMissionQuestion = (event: ServerEvent): event is MissionQuestionEvent =>
  event.type === 'mission.question';
const isQuestionRequested = (event: ServerEvent): event is QuestionRequestedEvent =>
  event.type === 'question.requested';
const isMissionUpdated = (event: ServerEvent): event is MissionUpdatedEvent =>
  event.type === 'mission.updated';

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

function historicalSummary(id: string, sessionId: string): MissionSummary {
  const now = Date.now();
  return {
    id,
    sessionId,
    kind: 'chat',
    role: 'orchestrator',
    title: `Historical ${id}`,
    goal: '',
    cwd: '',
    workspaceKind: 'none',
    autonomy: 'low',
    phase: 'paused',
    streaming: false,
    queuedSends: 0,
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function permissionRequest(events: ServerEvent[]): MissionPermissionEvent {
  const event = events.find(isMissionPermission);
  assert.ok(event);
  return event;
}

function approvalRequested(events: ServerEvent[]): ApprovalRequestedEvent {
  const event = events.find(isApprovalRequested);
  assert.ok(event);
  return event;
}

function latestQuestion(events: ServerEvent[]): MissionQuestionEvent {
  const event = events.filter(isMissionQuestion).at(-1);
  assert.ok(event);
  return event;
}

test(
  '[P1] Permission response keeps the stable app identity and emits both request events',
  { concurrency: false },
  async () => {
    const h = createSessionCharacterizationHarness();

    try {
      h.history.syncSummaries([historicalSummary('app-p1', 'provider-p1')]);
      await h.handle({ type: 'mission.resume', sessionId: 'app-p1' });

      const handler = h.provider.session('provider-p1').handlers.permissionHandler;
      assert.ok(handler);
      const pending = Promise.resolve(handler(permissionInput('p1')));
      const requested = permissionRequest(h.events);
      const mirrored = approvalRequested(h.events);

      assert.equal(requested.request.missionId, 'app-p1');
      assert.equal(h.runtime.loadCalls[0]?.sessionId, 'provider-p1');
      assert.deepEqual(mirrored.request, requested.request);
      assert.equal(h.events.filter(isMissionPermission).length, 1);
      assert.equal(h.events.filter(isApprovalRequested).length, 1);

      await h.handle({
        type: 'mission.respondPermission',
        missionId: requested.request.missionId,
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
    const h = createSessionCharacterizationHarness();

    try {
      await h.create({
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
        type: 'mission.respondPermission',
        missionId: requested.request.missionId,
        requestId: requested.request.requestId,
        outcome: 'proceed_always',
      });

      assert.equal(await first, ToolConfirmationOutcome.ProceedAlways);
      assert.equal(await handler(permissionInput('p2')), ToolConfirmationOutcome.ProceedAlways);
      assert.equal(h.events.filter(isMissionPermission).length, 1);
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
    const h = createSessionCharacterizationHarness();

    try {
      await h.create({
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
        type: 'mission.respondPermission',
        missionId: requested.request.missionId,
        requestId: `${requested.request.requestId}-unknown`,
        outcome: 'proceed_once',
      });
      await h.waitForIdle();
      assert.equal(resolutionCount, 0);

      await h.handle({
        type: 'mission.respondPermission',
        missionId: requested.request.missionId,
        requestId: requested.request.requestId,
        outcome: 'cancel',
      });
      assert.equal(await pending, ToolConfirmationOutcome.Cancel);

      await h.handle({
        type: 'mission.respondPermission',
        missionId: requested.request.missionId,
        requestId: requested.request.requestId,
        outcome: 'proceed_once',
      });
      await h.handle({
        type: 'mission.respondPermission',
        missionId: 'late-mission',
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
    const h = createSessionCharacterizationHarness();

    try {
      await h.create({
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
        type: 'mission.respondPermission',
        missionId: requested.request.missionId,
        requestId: requested.request.requestId,
        outcome: 'proceed_once',
      });

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
      const transition = h.events.filter(isMissionUpdated).at(-1);
      assert.ok(transition);
      assert.equal(transition.mission.kind, 'chat');
      assert.equal(transition.mission.phase, 'running');
    } finally {
      await h.dispose();
    }
  },
);

test(
  '[Q1] Question answers and cancellation each resolve the provider callback once',
  { concurrency: false },
  async () => {
    const h = createSessionCharacterizationHarness();

    try {
      await h.create({
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
      assert.equal(h.events.filter(isMissionQuestion).length, 1);
      assert.equal(h.events.filter(isQuestionRequested).length, 1);

      await h.handle({
        type: 'mission.respondQuestion',
        missionId: answerRequest.question.missionId,
        requestId: answerRequest.question.requestId,
        cancelled: false,
        answers: [{ index: 0, question: 'Proceed?', answer: 'yes' }],
      });
      assert.deepEqual(await answered, {
        cancelled: false,
        answers: [{ index: 0, question: 'Proceed?', answer: 'yes' }],
      });

      await h.handle({
        type: 'mission.respondQuestion',
        missionId: answerRequest.question.missionId,
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
        type: 'mission.respondQuestion',
        missionId: cancellationRequest.question.missionId,
        requestId: cancellationRequest.question.requestId,
        cancelled: true,
        answers: [],
      });
      assert.deepEqual(await cancelled, { cancelled: true, answers: [] });

      await h.handle({
        type: 'mission.respondQuestion',
        missionId: cancellationRequest.question.missionId,
        requestId: cancellationRequest.question.requestId,
        cancelled: false,
        answers: [{ index: 0, question: 'Proceed?', answer: 'no' }],
      });
      await h.waitForIdle();

      assert.equal(cancellationResolutionCount, 1);
      assert.equal(h.events.filter(isMissionQuestion).length, 2);
      assert.equal(h.events.filter(isQuestionRequested).length, 2);
    } finally {
      await h.dispose();
    }
  },
);
