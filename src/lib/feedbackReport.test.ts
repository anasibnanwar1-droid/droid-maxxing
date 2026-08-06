import assert from 'node:assert/strict';
import test from 'node:test';
import { feedbackDraftFromCommand, submitFeedbackReport } from './feedbackReport';
import {
  addDiagnosticsBreadcrumb,
  setDiagnosticsContext,
  __resetDiagnosticsForTest,
} from './rendererDiagnostics';

test('feedbackDraftFromCommand opens bug and feedback reports with optional details', () => {
  assert.deepEqual(feedbackDraftFromCommand('/bug'), { category: 'bug', description: '' });
  assert.deepEqual(feedbackDraftFromCommand('/bug    update froze   '), {
    category: 'bug',
    description: 'update froze',
  });
  assert.deepEqual(feedbackDraftFromCommand('/feedback'), {
    category: 'other',
    description: '',
  });
  assert.deepEqual(feedbackDraftFromCommand('/feedback great result'), {
    category: 'other',
    description: 'great result',
  });
  assert.equal(feedbackDraftFromCommand('/buggy nope'), null);
  assert.equal(feedbackDraftFromCommand('/feedbacks nope'), null);
});

test('submitFeedbackReport enriches with session log and app state when attachments are set', async () => {
  __resetDiagnosticsForTest();
  addDiagnosticsBreadcrumb('session', 'mode changed to spec');
  setDiagnosticsContext({ interactionMode: 'spec', view: 'chat' });

  const originalWindow = globalThis.window;
  let captured: unknown = null;
  globalThis.window = {
    ...globalThis.window,
    droidControl: {
      submitFeedbackReport: async (report: unknown) => {
        captured = report;
        return { reportId: 'RPT-1', userId: 'USR-1', eventId: 'EVT-1' };
      },
    },
  } as unknown as typeof globalThis.window;

  try {
    await submitFeedbackReport({
      category: 'bug',
      description: 'crashed on switch',
      attachments: { sessionLog: true, appState: true, screenshot: false },
    });
  } finally {
    globalThis.window = originalWindow;
  }

  const report = captured as { attachmentData?: { sessionLog?: unknown[]; appState?: unknown } };
  assert.ok(report.attachmentData, 'attachmentData should be present');
  assert.equal(report.attachmentData.sessionLog?.length, 1);
  assert.equal(report.attachmentData.sessionLog?.[0]?.message, 'mode changed to spec');
  assert.deepEqual(report.attachmentData.appState, { interactionMode: 'spec', view: 'chat' });
});

test('submitFeedbackReport omits attachmentData when no attachment flags are set', async () => {
  __resetDiagnosticsForTest();
  addDiagnosticsBreadcrumb('session', 'should not be included');

  const originalWindow = globalThis.window;
  let captured: unknown = null;
  globalThis.window = {
    ...globalThis.window,
    droidControl: {
      submitFeedbackReport: async (report: unknown) => {
        captured = report;
        return { reportId: 'RPT-2', userId: 'USR-2', eventId: 'EVT-2' };
      },
    },
  } as unknown as typeof globalThis.window;

  try {
    await submitFeedbackReport({
      category: 'other',
      description: 'just text report',
      attachments: { sessionLog: false, appState: false, screenshot: false },
    });
  } finally {
    globalThis.window = originalWindow;
  }

  assert.equal((captured as { attachmentData?: unknown }).attachmentData, undefined);
});

test('submitFeedbackReport throws when not in the desktop app', async () => {
  const originalWindow = globalThis.window;
  globalThis.window = undefined as unknown as typeof globalThis.window;

  try {
    await assert.rejects(
      () => submitFeedbackReport({ category: 'bug', description: 'test error' }),
      /Feedback is available only in the desktop app/,
    );
  } finally {
    globalThis.window = originalWindow;
  }
});

test('submitFeedbackReport throws when desktop bridge is unavailable', async () => {
  const originalWindow = globalThis.window;
  globalThis.window = {
    ...globalThis.window,
  } as unknown as typeof globalThis.window;
  delete (globalThis.window as Record<string, unknown>).droidControl;

  try {
    await assert.rejects(
      () => submitFeedbackReport({ category: 'bug', description: 'test error' }),
      /DROIDEX desktop bridge is unavailable/,
    );
  } finally {
    globalThis.window = originalWindow;
  }
});
