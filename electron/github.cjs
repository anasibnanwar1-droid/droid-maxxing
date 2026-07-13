// GitHub pull-request integration for the Context panel, driven by the `gh`
// CLI so it reuses the user's existing authentication and works on every OS.
// Every method degrades gracefully when `gh` is missing or unauthenticated.
const { execFile } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_TIMEOUT = 15000;
const MAX_BUFFER = 16 * 1024 * 1024;

function expandHome(value) {
  const str = String(value || '');
  if (str === '~') return os.homedir();
  if (str.startsWith('~/') || str.startsWith('~\\')) return path.join(os.homedir(), str.slice(2));
  return str;
}

// Resolve with { code, stdout, stderr } and never reject, so callers can decide
// how to treat non-zero exits (e.g. `gh pr checks` exits 8 while checks pend).
function gh(cwd, args, { timeout = DEFAULT_TIMEOUT } = {}) {
  return new Promise((resolve) => {
    execFile(
      'gh',
      args,
      { cwd: expandHome(cwd) || process.cwd(), timeout, maxBuffer: MAX_BUFFER },
      (err, stdout, stderr) => {
        resolve({
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          spawnFailed: !!err && err.code === 'ENOENT',
        });
      },
    );
  });
}

function parseJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

// A PR selector must be a bare integer. Anything else (a URL, a branch name, or
// a value beginning with `-`) could be parsed by gh as an option and silently
// retarget another repository, so reject it before spawning gh. Callers pass the
// validated selector after a `--` terminator as a second line of defense.
function prSelector(value) {
  if (value == null) return null;
  const s = String(value);
  return /^[0-9]+$/.test(s) ? s : null;
}

async function available() {
  const version = await gh(process.cwd(), ['--version']);
  if (version.spawnFailed || version.code !== 0) {
    return { installed: false, authenticated: false };
  }
  const auth = await gh(process.cwd(), ['auth', 'status']);
  return { installed: true, authenticated: auth.code === 0 };
}

const PR_FIELDS = [
  'number',
  'title',
  'state',
  'url',
  'isDraft',
  'headRefName',
  'baseRefName',
  'mergeable',
  'reviewDecision',
  'additions',
  'deletions',
  'changedFiles',
  'createdAt',
  'updatedAt',
  'author',
].join(',');

async function detectPr(dir, { branch } = {}) {
  let pr;
  if (branch) {
    // `gh pr view <branch>` treats a numeric branch name (e.g. "123") as a PR
    // number; filtering by `--head` matches the branch name unambiguously.
    const res = await gh(dir, [
      'pr',
      'list',
      '--head',
      branch,
      '--state',
      'all',
      '--limit',
      '1',
      '--json',
      PR_FIELDS,
    ]);
    if (res.code !== 0) return null; // gh unavailable
    const list = parseJson(res.stdout, null);
    pr = Array.isArray(list) && list.length > 0 ? list[0] : null;
  } else {
    const res = await gh(dir, ['pr', 'view', '--json', PR_FIELDS]);
    if (res.code !== 0) return null; // no PR for the current branch, or gh unavailable
    pr = parseJson(res.stdout, null);
  }
  if (!pr || typeof pr.number !== 'number') return null;
  return {
    number: pr.number,
    title: pr.title || '',
    state: String(pr.state || '').toLowerCase(), // open | closed | merged
    url: pr.url || '',
    isDraft: !!pr.isDraft,
    headRefName: pr.headRefName || null,
    baseRefName: pr.baseRefName || null,
    mergeable: pr.mergeable ? String(pr.mergeable).toLowerCase() : null,
    reviewDecision: pr.reviewDecision ? String(pr.reviewDecision).toLowerCase() : null,
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    changedFiles: pr.changedFiles ?? 0,
    createdAt: pr.createdAt || null,
    updatedAt: pr.updatedAt || null,
    author: pr.author?.login || null,
  };
}

async function prChecks(dir, { prNumber } = {}) {
  const selector = prSelector(prNumber);
  if (selector == null) return { ok: false, reason: 'missing_pr', checks: [] };
  const res = await gh(dir, [
    'pr',
    'checks',
    '--json',
    'name,state,bucket,link,workflow,description,startedAt,completedAt',
    '--',
    selector,
  ]);
  // exit 8 = checks pending, exit 1 = a check failed; both still emit JSON.
  if (res.spawnFailed) return { ok: false, reason: 'gh_unavailable', checks: [] };
  const rows = parseJson(res.stdout, null);
  if (!Array.isArray(rows)) {
    // No checks reported is not an error for our UI.
    if (/no checks reported/i.test(res.stderr)) return { ok: true, checks: [] };
    return { ok: false, reason: 'gh_error', message: res.stderr.trim(), checks: [] };
  }
  const checks = rows.map((row) => ({
    name: row.name || row.workflow || 'check',
    workflow: row.workflow || null,
    bucket: String(row.bucket || row.state || '').toLowerCase(), // pass|fail|pending|skipping|cancel
    state: String(row.state || '').toLowerCase(),
    description: row.description || '',
    link: row.link || null,
    startedAt: row.startedAt || null,
    completedAt: row.completedAt || null,
  }));
  return { ok: true, checks };
}

async function prComments(dir, { prNumber } = {}) {
  const selector = prSelector(prNumber);
  if (selector == null) return { ok: false, reason: 'missing_pr', comments: [] };
  const res = await gh(dir, ['pr', 'view', '--json', 'comments,reviews', '--', selector]);
  if (res.spawnFailed) return { ok: false, reason: 'gh_unavailable', comments: [] };
  if (res.code !== 0)
    return { ok: false, reason: 'gh_error', message: res.stderr.trim(), comments: [] };
  const data = parseJson(res.stdout, { comments: [], reviews: [] });
  const comments = (data.comments || []).map((c, i) => ({
    id: `comment-${i}-${c.createdAt || ''}`,
    kind: 'comment',
    author: c.author?.login || 'unknown',
    body: c.body || '',
    createdAt: c.createdAt || null,
    url: c.url || null,
    state: null,
  }));
  const reviews = (data.reviews || [])
    .filter((r) => (r.body && r.body.trim()) || (r.state && r.state !== 'COMMENTED'))
    .map((r, i) => ({
      id: `review-${i}-${r.submittedAt || ''}`,
      kind: 'review',
      author: r.author?.login || 'unknown',
      body: r.body || '',
      createdAt: r.submittedAt || null,
      url: null,
      state: r.state ? String(r.state).toLowerCase() : null,
    }));
  const all = [...comments, ...reviews].sort(
    (a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime(),
  );
  return { ok: true, comments: all };
}

async function createPr(dir, { title, body = '', base, draft = false, head } = {}) {
  if (!title || !title.trim()) return { ok: false, reason: 'empty_title' };
  const args = ['pr', 'create', '--title', title, '--body', body];
  if (base) args.push('--base', base);
  if (head) args.push('--head', head);
  if (draft) args.push('--draft');
  const res = await gh(dir, args, { timeout: 30000 });
  if (res.spawnFailed) return { ok: false, reason: 'gh_unavailable' };
  if (res.code !== 0) return { ok: false, reason: 'gh_error', message: res.stderr.trim() };
  const url = (res.stdout.match(/https?:\/\/\S+/) || [])[0] || null;
  const pr = await detectPr(dir, head ? { branch: head } : {});
  return { ok: true, url, number: pr?.number ?? null, pr };
}

async function postComment(dir, { prNumber, body } = {}) {
  const selector = prSelector(prNumber);
  if (selector == null) return { ok: false, reason: 'missing_pr' };
  if (!body || !body.trim()) return { ok: false, reason: 'empty_body' };
  const res = await gh(dir, ['pr', 'comment', '--body', body, '--', selector], {
    timeout: 30000,
  });
  if (res.spawnFailed) return { ok: false, reason: 'gh_unavailable' };
  if (res.code !== 0) return { ok: false, reason: 'gh_error', message: res.stderr.trim() };
  const url = (res.stdout.match(/https?:\/\/\S+/) || [])[0] || null;
  return { ok: true, url };
}

module.exports = {
  available,
  detectPr,
  prChecks,
  prComments,
  createPr,
  postComment,
};
