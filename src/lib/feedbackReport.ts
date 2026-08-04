import { isDesktop, type FeedbackReportReceipt, type FeedbackReportRequest } from './desktop';

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
  if (!isDesktop()) throw new Error('Feedback is available only in the desktop app.');
  const desktop = window.droidControl;
  if (!desktop) throw new Error('DROIDEX desktop bridge is unavailable.');
  return desktop.submitFeedbackReport(report);
}
