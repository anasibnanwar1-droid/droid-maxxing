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
const FETCH_TIMEOUT = 30000;
// Commits run user pre-commit / commit-msg hooks (linters, formatters, tests),
// which routinely take far longer than the default read-command budget.
const COMMIT_TIMEOUT = 120000;
const MAX_BUFFER = 16 * 1024 * 1024;
const UNTRACKED_FILE_CAP = 1000;
const UNTRACKED_BYTE_CAP = 1024 * 1024;
const UNTRACKED_SCAN_CONCURRENCY = 8;
// The well-known SHA of git's empty tree, used as the left side when diffing an
// unborn branch (no HEAD) so first-turn work still shows up.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
// Upper bound on repo-keyed caches (turn baselines, untracked scans) so a
// long-lived session that touches many repositories can't grow them unbounded.
const MAX_REPO_CACHE = 64;

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

// Set a value in a repo-keyed cache, evicting the oldest entry once the cap is
// hit. Map preserves insertion order, so the first key is the oldest.
function setRepoCache(map, key, value) {
  if (!map.has(key) && map.size >= MAX_REPO_CACHE) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
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

async function defaultBaseRef(root, remote = 'origin') {
  if (!remote) return null;
  const head = await tryRun(root, ['symbolic-ref', '--quiet', `refs/remotes/${remote}/HEAD`]);
  if (head) return head.replace('refs/remotes/', '');
  for (const candidate of [`${remote}/main`, `${remote}/master`]) {
    if (await tryRun(root, ['rev-parse', '--verify', '--quiet', candidate])) return candidate;
  }
  return null;
}

async function listRemotes(root) {
  return String((await tryRun(root, ['remote'])) || '')
    .split('\n')
    .filter(Boolean);
}

// The remote to read base/GitHub metadata from. Prefer `origin`, otherwise the
// sole/first remote, so repos cloned as `upstream` (or any name) still resolve.
function pickPrimaryRemote(remotes) {
  if (remotes.includes('origin')) return 'origin';
  return remotes[0] || null;
}

async function resolveBaseRef(root) {
  return defaultBaseRef(root, pickPrimaryRemote(await listRemotes(root)));
}

// Which remote a brand-new branch should publish to. Prefer an explicit
// push default, then `origin`, then the sole remote — never blindly assume
// `origin` exists, so repos cloned from `upstream` (or any other name) work.
async function defaultPushRemote(root) {
  const configured = await tryRun(root, ['config', '--get', 'remote.pushDefault']);
  if (configured) return configured;
  const remotes = await listRemotes(root);
  if (remotes.length === 0) return null;
  if (remotes.includes('origin')) return 'origin';
  if (remotes.length === 1) return remotes[0];
  return 'origin';
}

// Remote names may themselves contain "/" (e.g. "foo/bar"), so resolve the
// owning remote by testing each configured name and preferring the longest
// match, rather than assuming the remote is the text before the first slash.
function matchRemote(ref, remotes) {
  if (!ref) return null;
  return (
    (remotes || [])
      .filter((r) => ref === r || ref.startsWith(`${r}/`))
      .sort((a, b) => b.length - a.length)[0] || null
  );
}

// Drop the leading "<remote>/" from a remote-tracking ref (e.g. "origin/main"
// -> "main"), leaving local refs and bare remote names untouched.
function stripRemotePrefix(ref, remotes) {
  const r = matchRemote(ref, remotes);
  return r && ref.length > r.length + 1 ? ref.slice(r.length + 1) : ref;
}

// A base ref is "remote" when it lives under a configured remote (e.g.
// "origin/main"); otherwise it is a local branch (e.g. "dev").
function baseKindOf(baseRef, remotes) {
  if (!baseRef) return null;
  return matchRemote(baseRef, remotes) ? 'remote' : 'local';
}

// Git does not record the local branch a new branch forked from, so we persist
// the user's chosen base in repo config and read it back for display.
function storedBase(root, branch) {
  if (!branch) return Promise.resolve(null);
  return tryRun(root, ['config', `branch.${branch}.droidcontrolBase`]);
}

// The ref the current branch was forked from: the user's chosen base (persisted
// at creation), verified to still exist, else the repo's default branch. Diffs
// and Review scopes compare against this so a branch cut from `develop` is not
// measured against main (which would surface unrelated changes).
async function effectiveBaseRef(root) {
  const branch = await tryRun(root, ['symbolic-ref', '--short', 'HEAD']);
  const stored = branch ? await storedBase(root, branch) : null;
  if (stored && (await tryRun(root, ['rev-parse', '--verify', '--quiet', stored]))) return stored;
  return resolveBaseRef(root);
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
  const [branch, head, upstream, commonDir, gitDir] = await Promise.all([
    tryRun(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    tryRun(root, ['rev-parse', '--short', 'HEAD']),
    tryRun(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']),
    tryRun(root, ['rev-parse', '--git-common-dir']),
    tryRun(root, ['rev-parse', '--git-dir']),
  ]);
  // `rev-parse --abbrev-ref HEAD` returns "HEAD" when detached and fails on an
  // unborn branch (no commits yet). `symbolic-ref --short HEAD` still resolves
  // the branch name before the first commit, so only a real detached HEAD
  // (where it also fails) is reported as detached.
  const branchName =
    branch && branch !== 'HEAD' ? branch : await tryRun(root, ['symbolic-ref', '--short', 'HEAD']);
  const detached = !branchName;
  const [counts, remotes, storedBaseRef] = await Promise.all([
    upstream ? tryRun(root, ['rev-list', '--left-right', '--count', `${upstream}...HEAD`]) : null,
    listRemotes(root),
    detached ? null : storedBase(root, branchName),
  ]);
  const { ahead, behind } = counts ? parseAheadBehind(counts) : { ahead: 0, behind: 0 };
  const primaryRemote = pickPrimaryRemote(remotes);
  const [remoteUrl, defaultRef, storedBaseVerified] = await Promise.all([
    primaryRemote ? tryRun(root, ['remote', 'get-url', primaryRemote]) : null,
    defaultBaseRef(root, primaryRemote),
    storedBaseRef ? tryRun(root, ['rev-parse', '--verify', '--quiet', storedBaseRef]) : null,
  ]);
  // The ref this branch forks from and is diffed against (mirrors
  // effectiveBaseRef): its verified stored base, otherwise the default branch
  // ref. Upstream is the push target (often the branch's own remote ref), not a
  // base, so it is intentionally not used here.
  const base = storedBaseRef && storedBaseVerified ? storedBaseRef : defaultRef;
  const isLinkedWorktree =
    !!commonDir && !!gitDir && path.resolve(root, commonDir) !== path.resolve(root, gitDir);
  return {
    isRepo: true,
    repoRoot: root,
    worktreePath: root,
    isLinkedWorktree,
    branch: detached ? null : branchName,
    detached,
    head: head || null,
    upstream: upstream || null,
    base: base || null,
    baseKind: baseKindOf(base, remotes),
    ahead,
    behind,
    defaultBranch: defaultRef ? stripRemotePrefix(defaultRef, remotes) : null,
    defaultRef,
    remotes,
    // http(s) remote URLs may embed credentials (https://user:token@host/...);
    // strip the userinfo before handing the URL to the renderer. scp-style ssh
    // remotes (git@host:path) are left alone since "git" is not a secret.
    remoteUrl: remoteUrl ? remoteUrl.replace(/^(\w+:\/\/)[^@/]+@/, '$1') : null,
    // Anchor to the URL's host boundary so `github.com` only matches as the real
    // host (`https://github.com/…`, `git@github.com:…`), never embedded in an
    // arbitrary host such as `github.com.evil.com` or `evil.com/github.com`.
    isGitHub: !!remoteUrl && /(?:^|@|\/\/)github\.com[/:]/i.test(remoteUrl),
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
    // Drop the remote HEAD pointer: refs/remotes/origin/HEAD shortens to either
    // `origin/HEAD` or the bare remote name `origin` (no slash), and `git fetch`
    // now creates it by default. Real tracking branches are always `remote/branch`.
    .filter((name) => name && name.includes('/') && !name.endsWith('/HEAD'))
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

// Untracked-file content cache keyed by repo root, reused across the 6s poll so
// unchanged files are not re-read every cycle. Each file is keyed by a
// size+mtime signature; any edit invalidates it. The per-root map is rebuilt
// from each scan, so vanished files drop out and growth stays bounded.
const untrackedScanCache = new Map();

// Scan untracked (but not ignored) files once, returning a line-addition count,
// binary flag, and size+mtime signature per file. Per-file results are memoized
// by signature so file contents are not re-read when nothing changed.
async function scanUntracked(root) {
  const listing = await tryRun(root, ['ls-files', '--others', '--exclude-standard']);
  const names = String(listing || '')
    .split('\n')
    .filter(Boolean)
    .slice(0, UNTRACKED_FILE_CAP);
  const prior = untrackedScanCache.get(root) || new Map();
  const next = new Map();
  const out = new Array(names.length);

  const scanOne = async (rel) => {
    let entry = { path: rel, additions: 0, binary: false, sig: null };
    let fh;
    try {
      const full = path.join(root, rel);
      // Open once and both stat and read through the same descriptor so the size
      // check and the read observe the same file, closing the check-then-use race
      // where the file could change between a separate stat() and readFile().
      fh = await fsp.open(full, 'r');
      const stat = await fh.stat();
      const sig = `${stat.size}:${stat.mtimeMs}`;
      const cached = prior.get(rel);
      if (cached && cached.sig === sig) {
        entry = { path: rel, additions: cached.additions, binary: cached.binary, sig };
      } else {
        let additions = 0;
        let binary = false;
        if (stat.isFile() && stat.size <= UNTRACKED_BYTE_CAP) {
          const buf = await fh.readFile();
          if (buf.includes(0)) binary = true;
          else {
            const text = buf.toString('utf8');
            additions =
              text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
          }
        } else if (stat.size > UNTRACKED_BYTE_CAP) {
          binary = true;
        }
        entry = { path: rel, additions, binary, sig };
      }
    } catch {
      // ignore unreadable entries
    } finally {
      await fh?.close();
    }
    return entry;
  };

  // Bounded worker pool: a cold scan of hundreds of files would otherwise pay
  // one sequential open/stat/read round-trip each, but unbounded Promise.all
  // could exhaust file descriptors on huge repos.
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(UNTRACKED_SCAN_CONCURRENCY, names.length) },
    async () => {
      while (cursor < names.length) {
        const i = cursor++;
        out[i] = await scanOne(names[i]);
      }
    },
  );
  await Promise.all(workers);

  for (const entry of out) {
    if (entry.sig) {
      next.set(entry.path, { additions: entry.additions, binary: entry.binary, sig: entry.sig });
    }
  }
  setRepoCache(untrackedScanCache, root, next);
  return out;
}

async function untrackedAdditions(root) {
  const entries = await scanUntracked(root);
  let additions = 0;
  for (const e of entries) if (!e.binary) additions += e.additions;
  return { additions, files: entries.length };
}

// mode: 'worktree' (branch + uncommitted vs base), 'branch' (committed vs base),
// or 'uncommitted' (working tree vs HEAD).
async function diffStat(dir, options = {}) {
  const mode = ['worktree', 'branch', 'uncommitted'].includes(options.mode)
    ? options.mode
    : 'worktree';
  const root = await repoRootOf(dir);
  if (!root) return { mode, base: null, additions: 0, deletions: 0, files: 0 };
  const defaultRef = await effectiveBaseRef(root);
  let base = null;
  if (defaultRef) base = await tryRun(root, ['merge-base', defaultRef, 'HEAD']);
  // An unborn repo (no commits yet) has no HEAD, so diffing against it errors;
  // compare against the empty tree so the current working contents of tracked
  // files (and untracked files) are counted, not just the staged copy.
  const hasHead = !!(await tryRun(root, ['rev-parse', '--verify', '--quiet', 'HEAD']));

  if (mode === 'uncommitted') {
    const tracked = parseNumstat(
      await runSoft(root, ['diff', '--numstat', hasHead ? 'HEAD' : EMPTY_TREE]),
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
  const range = base || (hasHead ? 'HEAD' : EMPTY_TREE);
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
  if (typeof name !== 'string' || name.length === 0) return false;
  // A leading dash makes git parse the name as an option (e.g. `-D` would turn
  // `git branch -D <base>` into a branch deletion), so reject it outright.
  if (name.startsWith('-')) return false;
  if (name === '@' || name.endsWith('.') || name.includes('..') || name.includes('@{')) {
    return false;
  }
  // Forbidden characters per `git check-ref-format`: whitespace, the C0 control
  // characters and DEL (\x00-\x1f, \x7f), and ~ ^ : ? * [ \. Forward slashes ARE
  // allowed so hierarchical names like "feature/foo" work.
  if (/[\s~^:?*[\\\x00-\x1f\x7f]/.test(name)) return false;
  // Each slash-separated component must be non-empty (no leading/trailing slash
  // or "//"), must not begin with ".", and must not end with ".lock".
  return name
    .split('/')
    .every((seg) => seg.length > 0 && !seg.startsWith('.') && !seg.endsWith('.lock'));
}

// True only when `ref` resolves to a real commit object. Guards against passing
// an unborn branch name (valid as a symbolic ref but not yet an object) or any
// other unresolvable ref to git as a fork base.
async function resolvesToCommit(root, ref) {
  if (!ref) return false;
  return !!(await tryRun(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]));
}

async function createBranch(dir, { name, base, checkout = true } = {}) {
  const root = await repoRootOf(dir);
  if (!root) return { ok: false, reason: 'not_a_repo' };
  if (!validBranchName(name))
    return { ok: false, reason: 'invalid_name', message: `Invalid branch name "${name ?? ''}"` };
  // Only fork from a base that resolves to a commit. In an unborn repo the
  // current branch (e.g. "main") exists as a symbolic ref but is not yet a valid
  // object, so passing it to git would fail; drop it and start the new branch
  // from the unborn HEAD instead.
  const baseRef = (await resolvesToCommit(root, base)) ? base : null;
  try {
    // `--` ends option parsing so a base ref can never be read as a flag.
    if (checkout) await run(root, ['switch', '-c', name, ...(baseRef ? ['--', baseRef] : [])]);
    else await run(root, ['branch', '--', name, ...(baseRef ? [baseRef] : [])]);
    await rememberBase(root, name, baseRef);
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
  if (!ref) return { ok: false, reason: 'invalid_name', message: 'No branch specified' };
  if (!allowDirty && (await isDirty(root))) return { ok: false, reason: 'dirty' };

  // An exact local branch wins over remote-prefix handling: a branch literally
  // named `origin/foo` must be checked out as-is, not treated as the remote ref
  // and collapsed to `foo`.
  const exactLocal = await tryRun(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${ref}`]);
  if (exactLocal) {
    try {
      await run(root, ['switch', '--', ref]);
      return { ok: true, environment: await environment(root) };
    } catch (err) {
      return { ok: false, reason: 'git_error', message: err.message };
    }
  }

  // When the caller picks a remote-tracking ref (e.g. `origin/feature`), switch
  // to the matching local branch, creating it as a tracking branch from that
  // exact remote when absent. This avoids the ambiguity of stripping the remote
  // prefix client-side, which breaks with multiple remotes sharing a name.
  if (ref.includes('/')) {
    // Resolve the owning remote by configured name (remotes may contain "/"),
    // requiring at least one branch segment after it.
    const remotes = await listRemotes(root);
    const matchedRemote = matchRemote(ref, remotes);
    if (matchedRemote && ref.length > matchedRemote.length + 1) {
      const local = ref.slice(matchedRemote.length + 1);
      const hasLocal = await tryRun(root, [
        'rev-parse',
        '--verify',
        '--quiet',
        `refs/heads/${local}`,
      ]);
      try {
        if (hasLocal) {
          await run(root, ['switch', '--', local]);
          // The user picked a specific remote ref; if the existing local branch
          // tracks a different one, repoint its upstream to honor that choice.
          const current = await tryRun(root, [
            'rev-parse',
            '--abbrev-ref',
            '--symbolic-full-name',
            `${local}@{upstream}`,
          ]);
          if (current !== ref) {
            await run(root, ['branch', `--set-upstream-to=${ref}`, '--', local]).catch(() => {});
          }
        } else {
          // Name the new branch after the part *following* the matched remote.
          // A bare `git switch --track <ref>` derives the name by stripping only
          // the first path component, which is wrong for slash-named remotes.
          await run(root, ['switch', '-c', local, '--track', '--', ref]);
        }
        return { ok: true, environment: await environment(root) };
      } catch (err) {
        return { ok: false, reason: 'git_error', message: err.message };
      }
    }
  }

  try {
    await run(root, ['switch', '--', ref]);
    return { ok: true, environment: await environment(root) };
  } catch (err) {
    // `switch` refuses non-branch refs, so detach for tags/sha. `--detach`
    // avoids `checkout`'s pathspec mode (`git checkout -- x` restores a file
    // named x instead of switching), and `--` keeps a ref that looks like a
    // flag (e.g. `-f`) from being parsed as an option and silently discarding
    // working-tree changes.
    try {
      await run(root, ['switch', '--detach', '--', ref]);
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

function isWithin(base, target) {
  return target === base || target.startsWith(base + path.sep);
}

// A custom worktree location is user-typed, so keep it inside places a checkout
// plausibly lives: the repo itself, its parent (sibling worktrees), or the home
// directory. Anything else (e.g. /etc, /tmp planted by a hostile renderer) is
// rejected, as is nesting inside the .git dir where it would corrupt the repo.
function allowedWorktreeTarget(root, target) {
  const resolved = path.resolve(target);
  if (isWithin(path.join(root, '.git'), resolved)) return false;
  return (
    isWithin(root, resolved) ||
    isWithin(path.dirname(root), resolved) ||
    isWithin(os.homedir(), resolved)
  );
}

async function createWorktree(dir, { branch, base, newBranch = false, location } = {}) {
  const root = await repoRootOf(dir);
  if (!root) return { ok: false, reason: 'not_a_repo' };
  if (!validBranchName(branch))
    return { ok: false, reason: 'invalid_name', message: `Invalid branch name "${branch ?? ''}"` };
  // A relative custom location must resolve against the repo root (where git
  // creates it), not the Electron process cwd — otherwise the existence check,
  // the actual creation, and the returned path could all refer to different
  // directories, missing collisions and starting the chat at the wrong cwd.
  let target = location
    ? path.resolve(root, expandHome(location))
    : defaultWorktreeLocation(root, branch);
  if (location) {
    if (!allowedWorktreeTarget(root, target))
      return {
        ok: false,
        reason: 'invalid_location',
        message: 'Worktree location must be inside the repo, next to it, or in your home folder',
      };
    if (fs.existsSync(target)) return { ok: false, reason: 'exists', path: target };
  } else {
    // Default-location worktrees auto-suffix so a second worktree for the same
    // branch (or a leftover directory) never collides — keeps the flow workable.
    const baseTarget = target;
    for (let n = 2; fs.existsSync(target); n++) target = `${baseTarget}-${n}`;
  }
  try {
    // Ignore `.worktrees/` whenever the target lives there, even if the caller
    // passed the default path explicitly as `location` — otherwise it would
    // surface as untracked in the original checkout.
    const defaultRoot = path.join(root, '.worktrees') + path.sep;
    if (path.resolve(target).startsWith(defaultRoot)) await ensureDefaultWorktreeIgnored(root);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    // Only fork a new worktree branch from a base that resolves to a commit
    // (mirrors createBranch); an unborn base ref would fail.
    const baseRef = newBranch && (await resolvesToCommit(root, base)) ? base : null;
    // `--` ends option parsing so a user-editable target path (e.g. a relative
    // `-wt`) or ref can never be read as a git option.
    const args = newBranch
      ? ['worktree', 'add', '-b', branch, '--', target, ...(baseRef ? [baseRef] : [])]
      : ['worktree', 'add', '--', target, branch];
    await run(root, args, { timeout: PUSH_TIMEOUT });
    if (newBranch) await rememberBase(root, branch, baseRef);
    // When forking from a remote-tracking ref (e.g. `upstream/foo`), set up
    // upstream tracking so push/pull targets the right remote without manual
    // configuration. `git worktree add -b` doesn't do this automatically.
    if (newBranch && baseRef) {
      try {
        // tryRun never throws, so gate on its result: only a real
        // remote-tracking ref should become the new branch's upstream.
        const isRemoteRef = await tryRun(root, [
          'rev-parse',
          '--verify',
          `refs/remotes/${baseRef}`,
        ]);
        if (isRemoteRef) await run(root, ['branch', '--set-upstream-to', baseRef, '--', branch]);
      } catch {
        // upstream config failed; worktree is usable without it
      }
    }
    return { ok: true, path: target, branch };
  } catch (err) {
    return { ok: false, reason: 'git_error', message: err.message };
  }
}

async function removeWorktree(dir, { path: target, force = false } = {}) {
  const root = await repoRootOf(dir);
  if (!root) return { ok: false, reason: 'not_a_repo' };
  try {
    await run(root, [
      'worktree',
      'remove',
      ...(force ? ['--force'] : []),
      '--',
      expandHome(target),
    ]);
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
    if (all) await run(root, ['add', '-A'], { timeout: COMMIT_TIMEOUT });
    const staged = await tryRun(root, ['diff', '--cached', '--name-only']);
    // tryRun returns null on a git failure and '' when nothing is staged; only
    // the empty string means "nothing to commit" — a null is a real error (e.g.
    // a locked or corrupt index) and must not be reported as an empty staging.
    if (staged === null) {
      return { ok: false, reason: 'git_error', message: 'Failed to read staged files' };
    }
    if (!staged) return { ok: false, reason: 'nothing_to_commit' };
    await run(root, ['commit', '-m', message], { timeout: COMMIT_TIMEOUT });
    const head = await tryRun(root, ['rev-parse', '--short', 'HEAD']);
    return { ok: true, head };
  } catch (err) {
    return { ok: false, reason: 'git_error', message: err.message };
  }
}

async function push(dir, { remote, branch, setUpstream = false, force = false } = {}) {
  const root = await repoRootOf(dir);
  if (!root) return { ok: false, reason: 'not_a_repo' };
  const target = branch || (await tryRun(root, ['rev-parse', '--abbrev-ref', 'HEAD']));
  if (!target || target === 'HEAD') return { ok: false, reason: 'detached' };
  // Honor the branch's configured upstream so a non-origin tracking ref is never
  // clobbered — but only when it names the *same* branch. A branch cut from
  // origin/main tracks origin/main as its base, and pushing `feature:main` there
  // would publish feature commits straight onto main.
  const upstream =
    setUpstream || remote || branch
      ? null
      : await tryRun(root, [
          'rev-parse',
          '--abbrev-ref',
          '--symbolic-full-name',
          `${target}@{upstream}`,
        ]);
  // The upstream names the *same* branch only when, after stripping its
  // (possibly slash-containing) remote name, the remainder equals the local
  // branch. Resolve the remote by configured name rather than the first slash so
  // a branch tracking `foo/bar/feature` on remote `foo/bar` is recognized and
  // pushed back to that remote instead of falling through to the default.
  const remotes = upstream ? await listRemotes(root) : [];
  const upstreamRemote = upstream ? matchRemote(upstream, remotes) : null;
  const sameNameUpstream = !!upstreamRemote && stripRemotePrefix(upstream, remotes) === target;
  const args = ['push'];
  // Publish under the branch's own name when the tracked upstream is really a
  // base ref (different name), and repoint tracking so later pushes stay correct.
  if (setUpstream || (upstream && !sameNameUpstream)) args.push('--set-upstream');
  if (force) args.push('--force-with-lease');
  const pushRemote = sameNameUpstream ? upstreamRemote : remote || (await defaultPushRemote(root));
  if (!pushRemote) {
    return { ok: false, reason: 'no_remote', message: 'No git remote configured' };
  }
  // Push a fully-qualified refspec after `--` so a branch literally named like a
  // flag (e.g. `--mirror`) can never be parsed as a push option and, say, mirror
  // every ref. The destination keeps the branch's own name on the remote.
  args.push('--', pushRemote, `refs/heads/${target}:refs/heads/${target}`);
  try {
    const output = await run(root, args, { timeout: PUSH_TIMEOUT });
    return { ok: true, output, environment: await environment(root) };
  } catch (err) {
    return { ok: false, reason: 'git_error', message: err.message };
  }
}

// Best-effort refresh of remote-tracking refs so newly pushed branches appear
// without leaving the app. A no-remote repo is a success no-op; network/auth
// failures are reported but never throw, since callers fetch opportunistically.
async function fetchRemotes(dir) {
  const root = await repoRootOf(dir);
  if (!root) return { ok: false, reason: 'not_a_repo' };
  const remotes = await listRemotes(root);
  if (!remotes.length) return { ok: true };
  try {
    await run(root, ['fetch', '--all', '--prune'], { timeout: FETCH_TIMEOUT });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: 'git_error', message: err.message };
  }
}

// ---- Review tab: per-file diffs across review scopes ----------------------

// Mirror of DIFF_SCOPES in src/types/vcs.ts. The Electron process can't import
// that frontend module, so this list is kept in sync by hand; vcs.ts is the
// canonical source the UI and persisted state validate against.
const REVIEW_SCOPES = [
  'unstaged',
  'staged',
  'uncommitted',
  'commit',
  'branch',
  'worktree',
  'last_turn',
];

// Per-worktree baseline captured at the start of an agent turn so the
// "Last turn" scope can diff the working tree against that point in time.
// Keyed by `${root}\u0000${sessionId}` so two sessions sharing a repo don't
// clobber each other's baseline.
const turnBaselines = new Map();

function turnBaselineKey(root, sessionId) {
  return `${root}\u0000${sessionId ?? ''}`;
}

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

// Split NUL-delimited git output (`-z`) into records, dropping the empty tail a
// trailing NUL leaves behind.
function splitNul(out) {
  const parts = String(out || '').split('\0');
  if (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

// Parse `git diff --numstat -z`. A normal record is `added\tdeleted\tpath`; a
// rename/copy ends right after the counts (`added\tdeleted\t`) and is followed
// by two further records — the old path then the new path.
function parseNumstatZ(out) {
  const tokens = splitNul(out);
  const rows = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok) continue;
    const tab1 = tok.indexOf('\t');
    const tab2 = tab1 >= 0 ? tok.indexOf('\t', tab1 + 1) : -1;
    if (tab2 < 0) continue;
    const add = tok.slice(0, tab1);
    const del = tok.slice(tab1 + 1, tab2);
    let file = tok.slice(tab2 + 1);
    if (file === '') {
      file = tokens[i + 2] ?? tokens[i + 1] ?? '';
      i += 2;
    }
    rows.push({ add, del, path: file });
  }
  return rows;
}

// Parse `git diff --name-status -z`. A normal record is a `status` token then a
// `path` record; a rename/copy is `Rxx`/`Cxx` then old and new path records.
function parseNameStatusZ(out) {
  const tokens = splitNul(out);
  const rows = [];
  for (let i = 0; i < tokens.length; i++) {
    const status = tokens[i];
    if (!status) continue;
    if (/^[RC]/.test(status)) {
      rows.push({ status, from: tokens[i + 1] ?? '', path: tokens[i + 2] ?? '' });
      i += 2;
    } else {
      rows.push({ status, from: null, path: tokens[i + 1] ?? '' });
      i += 1;
    }
  }
  return rows;
}

function parseDiffFileList(numstatOut, nameStatusOut) {
  // Both inputs are NUL-delimited (`-z`), so paths are emitted verbatim with no
  // shell-style quoting — this is what lets Review open files whose names would
  // otherwise be git-quoted (spaces, unicode, control chars). name-status is
  // authoritative for statuses and post-rename paths.
  const files = [];
  const byPath = new Map();
  for (const { status, path: target } of parseNameStatusZ(nameStatusOut)) {
    if (!target) continue;
    const file = {
      path: target,
      status: statusLabel(status),
      additions: 0,
      deletions: 0,
      binary: false,
    };
    files.push(file);
    byPath.set(target, file);
  }
  for (const { add, del, path: target } of parseNumstatZ(numstatOut)) {
    if (!target) continue;
    const counts = {
      additions: add === '-' ? 0 : Number.parseInt(add, 10) || 0,
      deletions: del === '-' ? 0 : Number.parseInt(del, 10) || 0,
      binary: add === '-' && del === '-',
    };
    const existing = byPath.get(target);
    if (existing) {
      existing.additions = counts.additions;
      existing.deletions = counts.deletions;
      existing.binary = counts.binary;
    } else {
      const file = { path: target, status: 'modified', ...counts };
      files.push(file);
      byPath.set(target, file);
    }
  }
  return files;
}

async function untrackedFileList(root) {
  return scanUntracked(root);
}

// Resolve a review scope to the `git diff` arguments, the base ref it compares
// against, and whether untracked working-tree files should be folded in.
async function scopeRange(root, scope, sessionId) {
  if (scope === 'staged') return { args: ['--cached'], base: null, includeUntracked: false };
  if (scope === 'uncommitted') {
    // Everything not yet committed: working tree vs HEAD (staged + unstaged)
    // plus untracked files. Mirrors the Context panel's "Uncommitted" stat.
    const hasHead = await tryRun(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    return { args: [hasHead ? 'HEAD' : EMPTY_TREE], base: null, includeUntracked: true };
  }
  if (scope === 'commit') {
    const hasParent = await tryRun(root, ['rev-parse', '--verify', '--quiet', 'HEAD~1']);
    return {
      args: hasParent ? ['HEAD~1', 'HEAD'] : [EMPTY_TREE, 'HEAD'],
      base: hasParent ? 'HEAD~1' : null,
      includeUntracked: false,
    };
  }
  if (scope === 'branch' || scope === 'worktree') {
    const defaultRef = await effectiveBaseRef(root);
    const base = defaultRef ? await tryRun(root, ['merge-base', defaultRef, 'HEAD']) : null;
    if (scope === 'branch') {
      return { args: base ? [`${base}...HEAD`] : null, base, includeUntracked: false };
    }
    // Unborn repo: diff the whole working tree against the empty tree (mirrors
    // diffStat) so unstaged tracked edits show, not just the index.
    const hasHead = await tryRun(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    return { args: [base || (hasHead ? 'HEAD' : EMPTY_TREE)], base, includeUntracked: true };
  }
  if (scope === 'last_turn') {
    // Try the session-scoped baseline first, then fall back to the repo-level
    // key (used by the first turn of a brand-new mission before it has an ID).
    const entry =
      turnBaselines.get(turnBaselineKey(root, sessionId)) ??
      turnBaselines.get(turnBaselineKey(root, undefined));
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
  const { args, base, includeUntracked, priorUntracked } = await scopeRange(
    root,
    scope,
    options.sessionId,
  );
  if (!args) return { mode: scope, base: null, files: [] };
  const [numstat, nameStatus] = await Promise.all([
    runSoft(root, ['diff', ...args, '--numstat', '-z']).catch(() => ''),
    runSoft(root, ['diff', ...args, '--name-status', '-z']).catch(() => ''),
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

// Resolve the pre-rename path for a file within a diff range. Uses the same
// detection as the file list (parseDiffFileList), so it only reports an old
// path when the list already classified the file as a rename/copy.
async function renameSource(root, args, file) {
  const out = await runSoft(root, ['diff', ...args, '--name-status', '-z']).catch(() => '');
  for (const row of parseNameStatusZ(out)) {
    if (row.from && row.path === file) return row.from;
  }
  return null;
}

async function fileDiff(dir, options = {}) {
  const scope = normalizeScope(options.mode);
  const file = options.path;
  const root = await repoRootOf(dir);
  if (!root || !file) return { path: file || null, diff: '', binary: false };
  // Diff paths are repo-relative; anything resolving outside the root (absolute
  // path, ../ escape) would let the --no-index fallback read arbitrary files.
  if (!isWithin(root, path.resolve(root, file))) return { path: file, diff: '', binary: false };
  const { args, includeUntracked } = await scopeRange(root, scope, options.sessionId);
  if (!args) return { path: file, diff: '', binary: false };
  const ws = options.ignoreWhitespace ? ['-w'] : [];
  // A rename restricted to just the new path can't be paired with its deleted
  // source, so git would render the whole file as newly added. Diff both paths
  // with rename detection on so the rename/edit hunk shows instead.
  const renameOld = await renameSource(root, args, file);
  const pathSpec = renameOld ? ['-M', '--', renameOld, file] : ['--', file];
  let out = await runSoft(root, ['diff', ...ws, ...args, ...pathSpec]).catch(() => '');
  // Untracked files (incl. preexisting ones the agent edited) have no tree-side
  // to diff against, so render their full current content via --no-index. Gate
  // this on the file actually being untracked: with -w a tracked file can yield
  // an empty diff (whitespace-only edits), which must not be shown as brand new.
  if (!out && includeUntracked) {
    const tracked = await run(root, ['ls-files', '--error-unmatch', '--', file])
      .then(() => true)
      .catch(() => false);
    if (!tracked) {
      out = await runSoft(root, ['diff', ...ws, '--no-index', '--', os.devNull, file]).catch(
        () => '',
      );
    }
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

async function markTurnStart(dir, sessionId) {
  const root = await repoRootOf(dir);
  if (!root) return { ok: false };
  let baseline = await tryRun(root, ['stash', 'create']);
  if (!baseline) baseline = await tryRun(root, ['rev-parse', 'HEAD']);
  // Unborn repo (no commits yet): `stash create` and `rev-parse HEAD` both fail,
  // so capture the current index as a tree object instead. Diffing against it
  // (the empty tree when nothing is staged) makes the agent's first-turn work
  // show up once it commits, rather than falling back to a no-op `HEAD` diff.
  if (!baseline) baseline = await tryRun(root, ['write-tree']);
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
  if (baseline)
    setRepoCache(turnBaselines, turnBaselineKey(root, sessionId), { baseline, priorUntracked });
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
  commit,
  push,
  fetchRemotes,
};
