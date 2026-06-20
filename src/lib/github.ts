import { isDesktop } from './desktop';
import type {
  CreatePrOptions,
  CreatePrResult,
  GithubAvailability,
  PostCommentResult,
  PrCheck,
  PrChecksResult,
  PrCommentsResult,
  PullRequest,
} from '../types/vcs';

const UNAVAILABLE: GithubAvailability = { installed: false, authenticated: false };

export async function getGithubAvailability(): Promise<GithubAvailability> {
  if (!isDesktop()) return UNAVAILABLE;
  try {
    return await window.droidControl!.githubAvailable();
  } catch {
    return UNAVAILABLE;
  }
}

export async function detectPullRequest(dir: string, branch?: string): Promise<PullRequest | null> {
  if (!isDesktop() || !dir) return null;
  try {
    return await window.droidControl!.githubDetectPr(dir, { branch });
  } catch {
    return null;
  }
}

export async function getPrChecks(dir: string, prNumber: number): Promise<PrChecksResult> {
  if (!isDesktop()) return { ok: false, reason: 'not_desktop', checks: [] };
  try {
    return await window.droidControl!.githubPrChecks(dir, { prNumber });
  } catch {
    return { ok: false, reason: 'error', checks: [] };
  }
}

export async function getPrComments(dir: string, prNumber: number): Promise<PrCommentsResult> {
  if (!isDesktop()) return { ok: false, reason: 'not_desktop', comments: [] };
  try {
    return await window.droidControl!.githubPrComments(dir, { prNumber });
  } catch {
    return { ok: false, reason: 'error', comments: [] };
  }
}

export async function createPullRequest(
  dir: string,
  options: CreatePrOptions,
): Promise<CreatePrResult> {
  if (!isDesktop()) return { ok: false, reason: 'not_desktop' };
  return window.droidControl!.githubCreatePr(dir, options);
}

export async function postPrComment(
  dir: string,
  prNumber: number,
  body: string,
): Promise<PostCommentResult> {
  if (!isDesktop()) return { ok: false, reason: 'not_desktop' };
  return window.droidControl!.githubPostComment(dir, { prNumber, body });
}

// ---- Pure helpers (unit-tested) -------------------------------------------

export type PrKind = 'open' | 'draft' | 'merged' | 'closed';

export function prKind(pr: Pick<PullRequest, 'state' | 'isDraft'>): PrKind {
  const state = (pr.state || '').toLowerCase();
  if (state === 'merged') return 'merged';
  if (state === 'closed') return 'closed';
  if (pr.isDraft) return 'draft';
  return 'open';
}

export function prKindLabel(kind: PrKind): string {
  switch (kind) {
    case 'merged':
      return 'Merged';
    case 'closed':
      return 'Closed';
    case 'draft':
      return 'Draft';
    default:
      return 'Open';
  }
}

export type CheckStatus = 'success' | 'failure' | 'pending' | 'neutral';

export function bucketToStatus(bucket: string): CheckStatus {
  switch ((bucket || '').toLowerCase()) {
    case 'pass':
    case 'success':
      return 'success';
    case 'fail':
    case 'failure':
    case 'cancel':
      return 'failure';
    case 'pending':
      return 'pending';
    default:
      return 'neutral';
  }
}

export interface ChecksSummary {
  total: number;
  pass: number;
  fail: number;
  pending: number;
  status: CheckStatus | 'none';
}

export function checksSummary(checks: PrCheck[]): ChecksSummary {
  const summary: ChecksSummary = {
    total: checks.length,
    pass: 0,
    fail: 0,
    pending: 0,
    status: 'none',
  };
  for (const check of checks) {
    const status = bucketToStatus(check.bucket);
    if (status === 'success') summary.pass += 1;
    else if (status === 'failure') summary.fail += 1;
    else if (status === 'pending') summary.pending += 1;
  }
  if (summary.total === 0) summary.status = 'none';
  else if (summary.fail > 0) summary.status = 'failure';
  else if (summary.pending > 0) summary.status = 'pending';
  else if (summary.pass > 0) summary.status = 'success';
  else summary.status = 'neutral';
  return summary;
}
