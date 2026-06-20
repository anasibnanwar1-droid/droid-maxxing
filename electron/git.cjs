// Git operations for the Context panel: environment detection, branch and
// worktree listing, diff stats, and mutating actions (create branch/worktree,
// checkout, stage, commit, push). All paths are built with `node:path` so the
// worktree features work on macOS, Linux, and Windows.
const { execFile } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const fsp = require('node:fs/promises');

const DEFAULT_TIMEOUT = 6000;
const PUSH_TIMEOUT = 45000;
const MAX_BUFFER = 16 * 1024 * 1024;
const UNTRACKED_FILE_CAP = 1000;
const UNTRACKED_BYTE_CAP = 1024 * 1024;

function expandHome(value) {
  const str = String(value || '');
  if (str === '~') return os.homedir();
  if (str.startsWith('~/') || str.startsWith('~\\')) return path.join(os.homedir(), str.slice(2));
  return str;
}

// Resolve and reject on a non-zero exit so callers can try/catch.
function run(cwd, args, { timeout = DEFAULT_TIMEOUT } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { timeout, maxBuffer: MAX_BUFFER }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout));
    });
  });
}

// `git diff` exits 1 when differences exist; treat that as success.
function runSoft(cwd, args, { timeout = DEFAULT_TIMEOUT } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { timeout, maxBuffer: MAX_BUFFER }, (err, stdout) => {
      if (err && err.code !== 1) reject(err);
      else resolve(String(stdout));
    });
  });
}

async function tryRun(cwd, args, opts) {
  try {
    return (await run(cwd, args, opts)).trim();
  } catch {
    return null;
  }
}

async function isDirectory(dir) {
  try {
    return (await fsp.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

// Parse `git rev-list --left-right --count A...B` → { ahead, behind }.
function parseAheadBehind(out) {
  const [behind, ahead] = String(out || '')
    .trim()
    .split(/\s+/)
    .map((n) => Number.parseInt(n, 10));
  return {
    ahead: Number.isFinite(ahead) ? ahead : 0,
    behind: Number.isFinite(behind) ? behind : 0,
  };
}

// Parse `%(upstream:track)` like "[ahead 2, behind 1]" → { ahead, behind }.
function parseTrack(track) {
  const result = { ahead: 0, behind: 0 };
  if (!track) return result;
  const ahead = /ahead (\d+)/.exec(track);
  const behind = /behind (\d+)/.exec(track);
  if (ahead) result.ahead = Number.parseInt(ahead[1], 10);
  if (behind) result.behind = Number.parseInt(behind[1], 10);
  return result;
}

// Parse `git worktree list --porcelain` into structured entries.
function parseWorktrees(stdout, currentRoot) {
  const blocks = String(stdout || '')
    .split(/\n\n+/)
    .map((b) => b.trim())
    .filter(Boolean);
  return blocks.map((block, index) => {
    const entry = {
      path: null,
      head: null,
      branch: null,
      bare: false,
      detached: false,
      locked: false,
      isMain: index === 0,
      isCurrent: false,
    };
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) entry.path = line.slice('worktree '.length).trim();
      else if (line.startsWith('HEAD '))
        entry.head = line.slice('HEAD '.length).trim().slice(0, 12);
      else if (line.startsWith('branch '))
        entry.branch = line.slice('branch '.length).replace('refs/heads/', '').trim();
      else if (line === 'bare') entry.bare = true;
      else if (line === 'detached') entry.detached = true;
      else if (line.startsWith('locked')) entry.locked = true;
    }
    if (entry.path && currentRoot && path.resolve(entry.path) === path.resolve(currentRoot))
      entry.isCurrent = true;
    return entry;
  });
}

// Parse `git diff --numstat` lines into a totals object. Binary files report
// "-\t-\t<path>" and count as one changed file with zero line deltas.
function parseNumstat(stdout) {
  let additions = 0;
  let deletions = 0;
  let files = 0;
  for (const line of String(stdout || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [add, del] = trimmed.split('\t');
    files += 1;
    if (add !== '-') additions += Number.parseInt(add, 10) || 0;
    if (del !== '-') deletions += Number.parseInt(del, 10) || 0;
  }
  return { additions, deletions, files };
}

async function repoRootOf(dir) {
  const root = expandHome(dir);
  if (!root || !(await isDirectory(root))) return null;
  const top = await tryRun(root, ['rev-parse', '--show-toplevel']);
  return top || null;
}

async function defaultBaseRef(root) {
  const head = await tryRun(root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (head) return head.replace('refs/remotes/', '');
  for (const candidate of ['origin/main', 'origin/master']) {
    if (await tryRun(root, ['rev-parse', '--verify', '--quiet', candidate])) return candidate;
  }
  return null;
}

async function listRemotes(root) {
  return String((await tryRun(root, ['remote'])) || '')
    .split('\n')
    .filter(Boolean);
}

// A base ref is "remote" when its first path segment names a configured remote
// (e.g. "origin/main"); otherwise it is a local branch (e.g. "dev").
function baseKindOf(baseRef, remotes) {
  if (!baseRef) return null;
  return remotes.includes(baseRef.split('/')[0]) ? 'remote' : 'local';
}

// Git does not record the local branch a new branch forked from, so we persist
// the user's chosen base in repo config and read it back for display.
function storedBase(root, branch) {
  if (!branch) return Promise.resolve(null);
  return tryRun(root, ['config', `branch.${branch}.droidcontrolBase`]);
}

async function rememberBase(root, branch, base) {
  if (!branch || !base) return;
  try {
    await run(root, ['config', `branch.${branch}.droidcontrolBase`, base]);
  } catch {
    // non-fatal: base display simply falls back to the upstream ref
  }
}

async function environment(dir) {
  const root = await repoRootOf(dir);
  if (!root) return { isRepo: false };
  const [branch, head, upstream, commonDir, gitDir, remoteUrl] = await Promise.all([
    tryRun(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    tryRun(root, ['rev-parse', '--short', 'HEAD']),
    tryRun(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']),
    tryRun(root, ['rev-parse', '--git-common-dir']),
    tryRun(root, ['rev-parse', '--git-dir']),
    tryRun(root, ['remote', 'get-url', 'origin']),
  ]);
  const detached = !branch || branch === 'HEAD';
  let ahead = 0;
  let behind = 0;
  if (upstream) {
    const counts = await tryRun(root, [
      'rev-list',
      '--left-right',
      '--count',
      `${upstream}...HEAD`,
    ]);
    ({ ahead, behind } = parseAheadBehind(counts));
  }
  const defaultRef = await defaultBaseRef(root);
  const remotes = await listRemotes(root);
  const base = (detached ? null : (await storedBase(root, branch)) || upstream) || null;
  const isLinkedWorktree =
    !!commonDir && !!gitDir && path.resolve(root, commonDir) !== path.resolve(root, gitDir);
  return {
    isRepo: true,
    repoRoot: root,
    worktreePath: root,
    isLinkedWorktree,
    branch: detached ? null : branch,
    detached,
    head: head || null,
    upstream: upstream || null,
    base,
    baseKind: baseKindOf(base, remotes),
    ahead,
    behind,
    defaultBranch: defaultRef ? defaultRef.replace(/^origin\//, '') : null,
    defaultRef,
    remoteUrl: remoteUrl || null,
    isGitHub: !!remoteUrl && /github\.com/i.test(remoteUrl),
  };
}

async function branches(dir) {
  const root = await repoRootOf(dir);
  if (!root) return { current: null, detached: true, local: [], remote: [] };
  const current = await tryRun(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const sep = '\u0001';
  const localOut = await tryRun(root, [
    'for-each-ref',
    `--format=%(refname:short)${sep}%(upstream:short)${sep}%(upstream:track)${sep}%(HEAD)${sep}%(committerdate:unix)${sep}%(contents:subject)`,
    'refs/heads',
  ]);
  const local = String(localOut || '')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, upstream, track, headMark, date, subject] = line.split(sep);
      return {
        name,
        upstream: upstream || null,
        ...parseTrack(track),
        current: headMark === '*',
        committerDate: Number.parseInt(date, 10) || 0,
        subject: subject || '',
      };
    });
  const remoteOut = await tryRun(root, [
    'for-each-ref',
    '--format=%(refname:short)',
    'refs/remotes',
  ]);
  const remote = String(remoteOut || '')
    .split('\n')
    .filter((name) => name && !name.endsWith('/HEAD'))
    .map((name) => ({ name }));
  return {
    current: current === 'HEAD' ? null : current,
    detached: current === 'HEAD',
    local,
    remote,
  };
}

async function worktrees(dir) {
  const root = await repoRootOf(dir);
  if (!root) return [];
  const out = await tryRun(root, ['worktree', 'list', '--porcelain']);
  return parseWorktrees(out, root);
}

async function untrackedAdditions(root) {
  const listing = await tryRun(root, ['ls-files', '--others', '--exclude-standard']);
  const files = String(listing || '')
    .split('\n')
    .filter(Boolean)
    .slice(0, UNTRACKED_FILE_CAP);
  let additions = 0;
  for (const rel of files) {
    try {
      const full = path.join(root, rel);
      const stat = await fsp.stat(full);
      if (!stat.isFile() || stat.size > UNTRACKED_BYTE_CAP) continue;
      const buf = await fsp.readFile(full);
      if (buf.includes(0)) continue; // binary
      const text = buf.toString('utf8');
      if (text.length === 0) continue;
      additions += text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
    } catch {
      // ignore unreadable files
    }
  }
  return { additions, files: files.length };
}

// mode: 'worktree' (branch + uncommitted vs base), 'branch' (committed vs base),
// or 'uncommitted' (working tree vs HEAD).
async function diffStat(dir, options = {}) {
  const mode = ['worktree', 'branch', 'uncommitted'].includes(options.mode)
    ? options.mode
    : 'worktree';
  const root = await repoRootOf(dir);
  if (!root) return { mode, base: null, additions: 0, deletions: 0, files: 0 };
  const defaultRef = await defaultBaseRef(root);
  let base = null;
  if (defaultRef) base = await tryRun(root, ['merge-base', defaultRef, 'HEAD']);
  // An unborn repo (no commits yet) has no HEAD, so diffing against it errors;
  // compare the index instead so staged + untracked files still get counted.
  const hasHead = !!(await tryRun(root, ['rev-parse', '--verify', '--quiet', 'HEAD']));

  if (mode === 'uncommitted') {
    const tracked = parseNumstat(
      await runSoft(root, ['diff', '--numstat', hasHead ? 'HEAD' : '--cached']),
    );
    const untracked = await untrackedAdditions(root);
    return {
      mode,
      base: null,
      additions: tracked.additions + untracked.additions,
      deletions: tracked.deletions,
      files: tracked.files + untracked.files,
    };
  }

  if (mode === 'branch') {
    if (!base) return { mode, base: null, additions: 0, deletions: 0, files: 0 };
    const tracked = parseNumstat(await runSoft(root, ['diff', '--numstat', `${base}...HEAD`]));
    return { mode, base, ...tracked };
  }

  // worktree total: everything since base, including the working tree.
  const range = base || (hasHead ? 'HEAD' : '--cached');
  const tracked = parseNumstat(await runSoft(root, ['diff', '--numstat', range]));
  const untracked = await untrackedAdditions(root);
  return {
    mode,
    base,
    additions: tracked.additions + untracked.additions,
    deletions: tracked.deletions,
    files: tracked.files + untracked.files,
  };
}

function validBranchName(name) {
  return typeof name === 'string' && name.length > 0 && !/[\s~^:?*[\\]/.test(name);
}

async function createBranch(dir, { name, base, checkout = true } = {}) {
  const root = await repoRootOf(dir);
  if (!root) return { ok: false, reason: 'not_a_repo' };
  if (!validBranchName(name)) return { ok: false, reason: 'invalid_name' };
  try {
    if (checkout) await run(root, ['switch', '-c', name, ...(base ? [base] : [])]);
    else await run(root, ['branch', name, ...(base ? [base] : [])]);
    await rememberBase(root, name, base);
    return { ok: true, environment: await environment(root) };
  } catch (err) {
    return { ok: false, reason: 'git_error', message: err.message };
  }
}

async function isDirty(root) {
  const status = await tryRun(root, ['status', '--porcelain']);
  return !!status && status.length > 0;
}

async function checkout(dir, { ref, allowDirty = false } = {}) {
  const root = await repoRootOf(dir);
  if (!root) return { ok: false, reason: 'not_a_repo' };
  if (!ref) return { ok: false, reason: 'invalid_name' };
  if (!allowDirty && (await isDirty(root))) return { ok: false, reason: 'dirty' };

  // When the caller picks a remote-tracking ref (e.g. `origin/feature`), switch
  // to the matching local branch, creating it as a tracking branch from that
  // exact remote when absent. This avoids the ambiguity of stripping the remote
  // prefix client-side, which breaks with multiple remotes sharing a name.
  const slash = ref.indexOf('/');
  const maybeRemote = slash > 0 ? ref.slice(0, slash) : null;
  if (maybeRemote) {
    const remotes = await listRemotes(root);
    if (remotes.includes(maybeRemote)) {
      const local = ref.slice(slash + 1);
      const hasLocal = await tryRun(root, [
        'rev-parse',
        '--verify',
        '--quiet',
        `refs/heads/${local}`,
      ]);
      try {
        await run(root, hasLocal ? ['switch', local] : ['switch', '--track', ref]);
        return { ok: true, environment: await environment(root) };
      } catch (err) {
        return { ok: false, reason: 'git_error', message: err.message };
      }
    }
  }

  try {
    await run(root, ['switch', ref]);
    return { ok: true, environment: await environment(root) };
  } catch (err) {
    // `switch` refuses detached refs; fall back to checkout for tags/sha.
    try {
      await run(root, ['checkout', ref]);
      return { ok: true, environment: await environment(root) };
    } catch {
      return { ok: false, reason: 'git_error', message: err.message };
    }
  }
}

function sanitizeSegment(value) {
  return String(value || '')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function defaultWorktreeLocation(root, branch) {
  return path.join(root, '.worktrees', sanitizeSegment(branch) || 'worktree');
}

// Default worktrees live under `<repo>/.worktrees`. Add that path to the repo's
// local exclude file (not a tracked `.gitignore`) so creating one does not leave
// the original checkout dirty and trip the dirty-tree guards / status counts.
async function ensureDefaultWorktreeIgnored(root) {
  try {
    const rel = await tryRun(root, ['rev-parse', '--git-common-dir']);
    if (!rel) return;
    const excludePath = path.join(path.resolve(root, rel), 'info', 'exclude');
    let contents = '';
    try {
      contents = await fsp.readFile(excludePath, 'utf8');
    } catch {
      // exclude file may not exist yet
    }
    if (/^\/?\.worktrees\/?$/m.test(contents)) return;
    await fsp.mkdir(path.dirname(excludePath), { recursive: true });
    const prefix = contents && !contents.endsWith('\n') ? '\n' : '';
    await fsp.appendFile(excludePath, `${prefix}/.worktrees/\n`);
  } catch {
    // best effort: never block worktree creation on the ignore write
  }
}

async function createWorktree(dir, { branch, base, newBranch = false, location } = {}) {
  const root = await repoRootOf(dir);
  if (!root) return { ok: false, reason: 'not_a_repo' };
  if (!validBranchName(branch)) return { ok: false, reason: 'invalid_name' };
  const target = location ? expandHome(location) : defaultWorktreeLocation(root, branch);
  if (fs.existsSync(target)) return { ok: false, reason: 'exists', path: target };
  try {
    if (!location) await ensureDefaultWorktreeIgnored(root);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const args = newBranch
      ? ['worktree', 'add', '-b', branch, target, ...(base ? [base] : [])]
      : ['worktree', 'add', target, branch];
    await run(root, args, { timeout: PUSH_TIMEOUT });
    if (newBranch) await rememberBase(root, branch, base);
    return { ok: true, path: target, branch };
  } catch (err) {
    return { ok: false, reason: 'git_error', message: err.message };
  }
}

async function removeWorktree(dir, { path: target, force = false } = {}) {
  const root = await repoRootOf(dir);
  if (!root) return { ok: false, reason: 'not_a_repo' };
  try {
    await run(root, ['worktree', 'remove', ...(force ? ['--force'] : []), expandHome(target)]);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: 'git_error', message: err.message };
  }
}

async function stageAll(dir) {
  const root = await repoRootOf(dir);
  if (!root) return { ok: false, reason: 'not_a_repo' };
  try {
    await run(root, ['add', '-A']);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: 'git_error', message: err.message };
  }
}

async function commit(dir, { message, all = true } = {}) {
  const root = await repoRootOf(dir);
  if (!root) return { ok: false, reason: 'not_a_repo' };
  if (!message || !message.trim()) return { ok: false, reason: 'empty_message' };
  try {
    if (all) await run(root, ['add', '-A']);
    const staged = await tryRun(root, ['diff', '--cached', '--name-only']);
    if (!staged) return { ok: false, reason: 'nothing_to_commit' };
    await run(root, ['commit', '-m', message]);
    const head = await tryRun(root, ['rev-parse', '--short', 'HEAD']);
    return { ok: true, head };
  } catch (err) {
    return { ok: false, reason: 'git_error', message: err.message };
  }
}

async function push(dir, { remote = 'origin', branch, setUpstream = false, force = false } = {}) {
  const root = await repoRootOf(dir);
  if (!root) return { ok: false, reason: 'not_a_repo' };
  const target = branch || (await tryRun(root, ['rev-parse', '--abbrev-ref', 'HEAD']));
  if (!target || target === 'HEAD') return { ok: false, reason: 'detached' };
  const args = ['push'];
  if (setUpstream) args.push('--set-upstream');
  if (force) args.push('--force-with-lease');
  args.push(remote, target);
  try {
    const output = await run(root, args, { timeout: PUSH_TIMEOUT });
    return { ok: true, output, environment: await environment(root) };
  } catch (err) {
    return { ok: false, reason: 'git_error', message: err.message };
  }
}

// ---- Review tab: per-file diffs across review scopes ----------------------

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const REVIEW_SCOPES = ['unstaged', 'staged', 'commit', 'branch', 'worktree', 'last_turn'];

// Per-worktree baseline captured at the start of an agent turn so the
// "Last turn" scope can diff the working tree against that point in time.
const turnBaselines = new Map();

function normalizeScope(value) {
  return REVIEW_SCOPES.includes(value) ? value : 'unstaged';
}

function statusLabel(letter) {
  switch ((letter || '')[0]) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'T':
      return 'type';
    default:
      return 'modified';
  }
}

// Recover the post-rename path from numstat/name-status fields, handling both
// the `old => new` and `dir/{old => new}/file` rename encodings.
function renameTarget(field) {
  const value = String(field || '');
  if (!value.includes(' => ')) return value;
  const open = value.indexOf('{');
  const close = value.indexOf('}');
  if (open !== -1 && close > open) {
    const pre = value.slice(0, open);
    const inner = value.slice(open + 1, close);
    const post = value.slice(close + 1);
    const next = inner.split(' => ')[1] ?? inner;
    return (pre + next + post).replace(/\/{2,}/g, '/');
  }
  return value.slice(value.indexOf(' => ') + 4);
}

function parseDiffFileList(numstatOut, nameStatusOut) {
  const counts = new Map();
  for (const line of String(numstatOut || '').split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const [add, del] = parts;
    const target = renameTarget(parts.slice(2).join('\t'));
    counts.set(target, {
      additions: add === '-' ? 0 : Number.parseInt(add, 10) || 0,
      deletions: del === '-' ? 0 : Number.parseInt(del, 10) || 0,
      binary: add === '-' && del === '-',
    });
  }
  const files = [];
  const seen = new Set();
  for (const line of String(nameStatusOut || '').split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    // Renames/copies are reported tab-separated as `R<score>\told\tnew`, so the
    // post-change path is the final field; every other status carries one path.
    const target = /^[RC]/.test(parts[0])
      ? parts[parts.length - 1]
      : renameTarget(parts.slice(1).join('\t'));
    if (!target) continue;
    const c = counts.get(target) || { additions: 0, deletions: 0, binary: false };
    files.push({ path: target, status: statusLabel(parts[0]), ...c });
    seen.add(target);
  }
  for (const [target, c] of counts) {
    if (!seen.has(target)) files.push({ path: target, status: 'modified', ...c });
  }
  return files;
}

async function untrackedFileList(root) {
  const listing = await tryRun(root, ['ls-files', '--others', '--exclude-standard']);
  const names = String(listing || '')
    .split('\n')
    .filter(Boolean)
    .slice(0, UNTRACKED_FILE_CAP);
  const out = [];
  for (const rel of names) {
    let additions = 0;
    let binary = false;
    let sig = null;
    try {
      const stat = await fsp.stat(path.join(root, rel));
      sig = `${stat.size}:${stat.mtimeMs}`;
      if (stat.isFile() && stat.size <= UNTRACKED_BYTE_CAP) {
        const buf = await fsp.readFile(path.join(root, rel));
        if (buf.includes(0)) binary = true;
        else {
          const text = buf.toString('utf8');
          additions =
            text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
        }
      } else if (stat.size > UNTRACKED_BYTE_CAP) {
        binary = true;
      }
    } catch {
      // ignore unreadable entries
    }
    out.push({ path: rel, additions, binary, sig });
  }
  return out;
}

// Resolve a review scope to the `git diff` arguments, the base ref it compares
// against, and whether untracked working-tree files should be folded in.
async function scopeRange(root, scope) {
  if (scope === 'staged') return { args: ['--cached'], base: null, includeUntracked: false };
  if (scope === 'commit') {
    const hasParent = await tryRun(root, ['rev-parse', '--verify', '--quiet', 'HEAD~1']);
    return {
      args: hasParent ? ['HEAD~1', 'HEAD'] : [EMPTY_TREE, 'HEAD'],
      base: hasParent ? 'HEAD~1' : null,
      includeUntracked: false,
    };
  }
  if (scope === 'branch' || scope === 'worktree') {
    const defaultRef = await defaultBaseRef(root);
    const base = defaultRef ? await tryRun(root, ['merge-base', defaultRef, 'HEAD']) : null;
    if (scope === 'branch') {
      return { args: base ? [`${base}...HEAD`] : null, base, includeUntracked: false };
    }
    // Unborn repo: diff the index rather than a nonexistent HEAD.
    const hasHead = await tryRun(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    return { args: [base || (hasHead ? 'HEAD' : '--cached')], base, includeUntracked: true };
  }
  if (scope === 'last_turn') {
    const entry = turnBaselines.get(root);
    const baseline = entry?.baseline || 'HEAD';
    return {
      args: [baseline],
      base: baseline,
      includeUntracked: true,
      priorUntracked: entry?.priorUntracked ?? null,
    };
  }
  // unstaged (working tree vs index)
  return { args: [], base: null, includeUntracked: true };
}

async function diffFiles(dir, options = {}) {
  const scope = normalizeScope(options.mode);
  const root = await repoRootOf(dir);
  if (!root) return { mode: scope, base: null, files: [] };
  const { args, base, includeUntracked, priorUntracked } = await scopeRange(root, scope);
  if (!args) return { mode: scope, base: null, files: [] };
  const [numstat, nameStatus] = await Promise.all([
    runSoft(root, ['diff', ...args, '--numstat']).catch(() => ''),
    runSoft(root, ['diff', ...args, '--name-status']).catch(() => ''),
  ]);
  const files = parseDiffFileList(numstat, nameStatus);
  if (includeUntracked) {
    for (const u of await untrackedFileList(root)) {
      if (priorUntracked) {
        const priorSig = priorUntracked.get(u.path);
        // Hide files that predate the turn only when byte-for-byte unchanged;
        // surface preexisting untracked files the agent edited this turn.
        if (priorSig !== undefined && priorSig === u.sig) continue;
      }
      if (!files.some((f) => f.path === u.path)) {
        files.push({
          path: u.path,
          status: 'untracked',
          additions: u.additions,
          deletions: 0,
          binary: u.binary,
        });
      }
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { mode: scope, base: base || null, files };
}

async function fileDiff(dir, options = {}) {
  const scope = normalizeScope(options.mode);
  const file = options.path;
  const root = await repoRootOf(dir);
  if (!root || !file) return { path: file || null, diff: '', binary: false };
  const { args, includeUntracked } = await scopeRange(root, scope);
  if (!args) return { path: file, diff: '', binary: false };
  let out = await runSoft(root, ['diff', ...args, '--', file]).catch(() => '');
  // Untracked files (incl. preexisting ones the agent edited) have no tree-side
  // to diff against, so render their full current content via --no-index.
  if (!out && includeUntracked) {
    out = await runSoft(root, ['diff', '--no-index', '--', os.devNull, file]).catch(() => '');
  }
  return { path: file, diff: out, binary: /^Binary files /m.test(out) };
}

async function fileSignature(root, rel) {
  try {
    const s = await fsp.stat(path.join(root, rel));
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return null;
  }
}

async function markTurnStart(dir) {
  const root = await repoRootOf(dir);
  if (!root) return { ok: false };
  let baseline = await tryRun(root, ['stash', 'create']);
  if (!baseline) baseline = await tryRun(root, ['rev-parse', 'HEAD']);
  // `git stash create` captures tracked changes but omits untracked files, while
  // the last-turn diff folds in every current untracked file. Snapshot each
  // preexisting untracked path with a size+mtime signature so files that predate
  // the turn are hidden, while edits the agent makes to them still surface.
  const priorNames = String(
    (await tryRun(root, ['ls-files', '--others', '--exclude-standard'])) || '',
  )
    .split('\n')
    .filter(Boolean);
  const priorUntracked = new Map();
  for (const rel of priorNames) priorUntracked.set(rel, await fileSignature(root, rel));
  if (baseline) turnBaselines.set(root, { baseline, priorUntracked });
  return { ok: !!baseline, baseline: baseline || null };
}

module.exports = {
  environment,
  branches,
  worktrees,
  diffStat,
  diffFiles,
  fileDiff,
  markTurnStart,
  createBranch,
  checkout,
  createWorktree,
  removeWorktree,
  stageAll,
  commit,
  push,
  // exported for reuse/inspection
  parseWorktrees,
  parseNumstat,
  parseDiffFileList,
  renameTarget,
  statusLabel,
  parseTrack,
  parseAheadBehind,
  baseKindOf,
  defaultWorktreeLocation,
};
