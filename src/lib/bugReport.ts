import { isDesktop, type BugReportReceipt } from './desktop';

export function bugDescriptionFromCommand(text: string): string | null {
  if (text === '/bug') return '';
  if (!text.startsWith('/bug ')) return null;
  return text.slice('/bug '.length).trim();
}

export async function reportBug(description: string): Promise<BugReportReceipt> {
  if (!isDesktop()) throw new Error('Bug reporting is available only in the desktop app.');
  const desktop = window.droidControl;
  if (!desktop) throw new Error('DROIDEX desktop bridge is unavailable.');
  return desktop.reportBug(description);
}
