// GitHub pull-request integration for the Context panel, driven by the `gh`
// CLI so it reuses the user's existing authentication and works on every OS.
// Every method degrades gracefully when `gh` is missing or unauthenticated.
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const githubSetup = require('./githubSetup.cjs');

const DEFAULT_TIMEOUT = 15000;
const MAX_BUFFER = 16 * 1024 * 1024;
const COMMON_GH_PATHS = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/opt/local/bin/gh'];

let cachedGhExecutablePromise;

function expandHome(value) {
  const str = String(value || '');
  if (str === '~') return os.homedir();
  if (str.startsWith('~/') || str.startsWith('~\\')) return path.join(os.homedir(), str.slice(2));
  return str;
}

function runFile(file, args, { cwd, timeout = DEFAULT_TIMEOUT } = {}) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { ...(cwd ? { cwd } : {}), timeout, maxBuffer: MAX_BUFFER },
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

async function resolveGhExecutable(options = {}) {
  const env = options.env || process.env;
  const access =
    options.access || ((candidate) => fs.promises.access(candidate, fs.constants.X_OK));
  const execute = options.runFile || runFile;
  const pathCandidates = String(env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.join(directory, 'gh'));
  const candidates = [...new Set([...pathCandidates, ...COMMON_GH_PATHS])];

  const validate = async (candidate) => {
    try {
      await access(candidate);
      const version = await execute(candidate, ['--version'], { timeout: 5_000 });
      return version.code === 0 ? candidate : null;
    } catch {
      return null;
    }
  };

  for (const candidate of candidates) {
    const valid = await validate(candidate);
    if (valid) return valid;
  }

  const shell = String(env.SHELL || '').trim();
  if (!shell) return null;
  const lookup = await execute(shell, ['-lc', 'command -v gh'], { timeout: 5_000 });
  if (lookup.code !== 0) return null;
  const shellCandidate = lookup.stdout.trim().split(/\r?\n/, 1)[0];
  if (!path.isAbsolute(shellCandidate)) return null;
  return validate(shellCandidate);
}

async function cachedGhExecutable() {
  cachedGhExecutablePromise ||= resolveGhExecutable();
  const executable = await cachedGhExecutablePromise;
  if (!executable) cachedGhExecutablePromise = undefined;
  return executable;
}

function install(options = {}) {
  return githubSetup.install({
    ...options,
    resolveGh: options.resolveGh || cachedGhExecutable,
    invalidateGh: () => {
      cachedGhExecutablePromise = undefined;
    },
  });
}

function authenticate(options = {}) {
  return githubSetup.authenticate({
    ...options,
    resolveGh: options.resolveGh || cachedGhExecutable,
  });
}

// Resolve with { code, stdout, stderr } and never reject, so callers can decide
// how to treat non-zero exits (e.g. `gh pr checks` exits 8 while checks pend).
async function gh(cwd, args, { timeout = DEFAULT_TIMEOUT } = {}) {
  const executable = await cachedGhExecutable();
  if (!executable) {
    return { code: 1, stdout: '', stderr: 'GitHub CLI was not found.', spawnFailed: true };
  }
  return runFile(executable, args, {
    cwd: expandHome(cwd) || process.cwd(),
    timeout,
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

async function available(options = {}) {
  const runGh = options.runGh || gh;
  const resolveBrew = options.resolveBrew || githubSetup.resolveBrewExecutable;
  const version = await runGh(process.cwd(), ['--version']);
  if (version.spawnFailed || version.code !== 0) {
    return {
      installed: false,
      authenticated: false,
      installMethod: (await resolveBrew()) ? 'homebrew' : 'manual',
    };
  }
  const auth = await runGh(process.cwd(), ['auth', 'status', '--hostname', 'github.com']);
  return { installed: true, authenticated: auth.code === 0, installMethod: null };
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

// Distinguishes "queried successfully, no PR" ({ ok: true, pr: null }) from a
// failed query ({ ok: false }), so a transient gh error never erases a PR the
// UI already knows about.
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
    if (res.code !== 0) return { ok: false, pr: null };
    const list = parseJson(res.stdout, null);
    pr = Array.isArray(list) && list.length > 0 ? list[0] : null;
  } else {
    const res = await gh(dir, ['pr', 'view', '--json', PR_FIELDS]);
    if (res.code !== 0) {
      // gh exits 1 both when no PR exists and when it fails; only the explicit
      // "no pull requests found" message means an authoritative "no PR".
      if (!res.spawnFailed && /no pull requests found/i.test(res.stderr)) {
        return { ok: true, pr: null };
      }
      return { ok: false, pr: null };
    }
    pr = parseJson(res.stdout, null);
  }
  if (!pr || typeof pr.number !== 'number') return { ok: true, pr: null };
  const normalized = {
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
  return { ok: true, pr: normalized };
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

function normalizePrComments(data, inlineRows = []) {
  const normalizeReactionGroups = (groups) => {
    if (!Array.isArray(groups)) return [];
    return groups
      .map((group) => ({
        content: String(group?.content || '').toUpperCase(),
        count: Number(group?.users?.totalCount || 0),
      }))
      .filter((reaction) => reaction.content && reaction.count > 0);
  };
  const normalizeRestReactions = (reactions) => {
    const contentByField = {
      '+1': 'THUMBS_UP',
      '-1': 'THUMBS_DOWN',
      laugh: 'LAUGH',
      hooray: 'HOORAY',
      confused: 'CONFUSED',
      heart: 'HEART',
      rocket: 'ROCKET',
      eyes: 'EYES',
    };
    if (!reactions || typeof reactions !== 'object') return [];
    return Object.entries(contentByField)
      .map(([field, content]) => ({ content, count: Number(reactions[field] || 0) }))
      .filter((reaction) => reaction.count > 0);
  };
  const comments = (Array.isArray(data?.comments) ? data.comments : []).map((c, i) => ({
    id: `comment-${String(c.databaseId || c.id || `${i}-${c.createdAt || ''}`)}`,
    kind: 'comment',
    author: c.author?.login || 'unknown',
    body: c.body || '',
    createdAt: c.createdAt || null,
    url: c.url || null,
    state: null,
    reactions: normalizeReactionGroups(c.reactionGroups),
  }));
  const reviews = (Array.isArray(data?.reviews) ? data.reviews : [])
    .filter((r) => (r.body && r.body.trim()) || (r.state && r.state !== 'COMMENTED'))
    .map((r, i) => ({
      id: `review-${String(r.databaseId || r.id || `${i}-${r.submittedAt || ''}`)}`,
      kind: 'review',
      author: r.author?.login || 'unknown',
      body: r.body || '',
      createdAt: r.submittedAt || null,
      url: r.url || null,
      state: r.state ? String(r.state).toLowerCase() : null,
      reactions: normalizeReactionGroups(r.reactionGroups),
    }));
  const inline = (Array.isArray(inlineRows) ? inlineRows : []).map((comment, i) => ({
    id: `inline-${String(comment.id || `${i}-${comment.created_at || ''}`)}`,
    kind: 'inline',
    author: comment.user?.login || 'unknown',
    body: comment.body || '',
    createdAt: comment.created_at || null,
    url: comment.html_url || null,
    state: null,
    path: comment.path || null,
    line: comment.line ?? comment.original_line ?? null,
    diffHunk: comment.diff_hunk || null,
    reactions: normalizeRestReactions(comment.reactions),
  }));
  return [...comments, ...reviews, ...inline].sort(
    (a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime(),
  );
}

async function prComments(dir, { prNumber } = {}, runGh = gh) {
  const selector = prSelector(prNumber);
  if (selector == null) return { ok: false, reason: 'missing_pr', comments: [] };
  const [view, inline] = await Promise.all([
    runGh(dir, ['pr', 'view', '--json', 'comments,reviews', '--', selector]),
    runGh(dir, ['api', '--paginate', '--slurp', `repos/{owner}/{repo}/pulls/${selector}/comments`]),
  ]);
  const viewSucceeded = !view.spawnFailed && view.code === 0;
  const inlineSucceeded = !inline.spawnFailed && inline.code === 0;
  if (!viewSucceeded && !inlineSucceeded) {
    const message = [view.stderr, inline.stderr]
      .map((value) => value.trim())
      .filter(Boolean)
      .join('\n');
    return {
      ok: false,
      reason: view.spawnFailed || inline.spawnFailed ? 'gh_unavailable' : 'gh_error',
      message,
      comments: [],
    };
  }
  const data = viewSucceeded
    ? parseJson(view.stdout, { comments: [], reviews: [] })
    : { comments: [], reviews: [] };
  const pages = inlineSucceeded ? parseJson(inline.stdout, []) : [];
  const inlineRows = Array.isArray(pages)
    ? pages.flatMap((page) => (Array.isArray(page) ? page : []))
    : [];
  const failures = [
    ...(viewSucceeded ? [] : [view.stderr.trim() || 'Could not load PR conversation comments']),
    ...(inlineSucceeded ? [] : [inline.stderr.trim() || 'Could not load inline review comments']),
  ];
  return {
    ok: true,
    ...(failures.length === 0 ? {} : { partial: true, message: failures.join('\n') }),
    comments: normalizePrComments(data, inlineRows),
  };
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
  const detected = await detectPr(dir, head ? { branch: head } : {});
  return { ok: true, url, number: detected.pr?.number ?? null, pr: detected.pr };
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
  authenticate,
  install,
  cancelSetup: githubSetup.cancelSetup,
  isGithubDeviceUrl: githubSetup.isGithubDeviceUrl,
  resolveBrewExecutable: githubSetup.resolveBrewExecutable,
  resolveGhExecutable,
  // Exported for unit tests: the validation boundary for PR selectors.
  prSelector,
  normalizePrComments,
  detectPr,
  prChecks,
  prComments,
  createPr,
  postComment,
};
