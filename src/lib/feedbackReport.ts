import type { FeedbackReportReceipt, FeedbackReportRequest } from './desktop';
import { getSessionLog, getCurrentAppState } from './rendererDiagnostics';

export function feedbackDraftFromCommand(text: string): FeedbackReportRequest | null {
  if (text === '/bug') return { category: 'bug', description: '' };
  if (text.startsWith('/bug ')) {
    return { category: 'bug', description: text.slice('/bug '.length).trim() };
  }
  if (text === '/feedback') return { category: 'other', description: '' };
  if (text.startsWith('/feedback ')) {
    return { category: 'other', description: text.slice('/feedback '.length).trim() };
  }
  return null;
}

export async function submitFeedbackReport(
  report: FeedbackReportRequest,
): Promise<FeedbackReportReceipt> {
  if (typeof window === 'undefined')
    throw new Error('Feedback is available only in the desktop app.');
  const desktop = window.droidControl;
  if (!desktop) throw new Error('DROIDEX desktop bridge is unavailable.');

  const enriched: FeedbackReportRequest = { ...report };
  if (report.attachments) {
    const data: Record<string, unknown> = {};
    if (report.attachments.sessionLog) data.sessionLog = getSessionLog();
    if (report.attachments.appState) data.appState = getCurrentAppState();
    if (Object.keys(data).length > 0) enriched.attachmentData = data;
  }

  return desktop.submitFeedbackReport(enriched);
}
