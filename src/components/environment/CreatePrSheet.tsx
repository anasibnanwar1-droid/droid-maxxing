import { useState } from 'react';
import { ChevronDown, Loader2 } from 'lucide-react';
import { createPullRequest } from '../../lib/github';
import { baseDescriptor, gitPush, stripRemotePrefix } from '../../lib/git';
import { openExternal } from '../../lib/onboarding';
import { toast } from '../../lib/toast';
import type { GitBranchList, GitEnvironment } from '../../types/vcs';

// Inline "open pull request" form. Pushes the branch (setting upstream when
// needed) before asking gh to create the PR.
export function CreatePrSheet({
  cwd,
  env,
  branches,
  onDone,
  onCreated,
}: {
  cwd: string;
  env: GitEnvironment | null;
  branches: GitBranchList | null;
  onDone: () => void;
  // Fired after a PR is successfully opened so the parent can re-detect it
  // immediately instead of waiting for the next poll (which would keep the
  // "Open PR" affordance visible and allow a duplicate attempt).
  onCreated?: () => void;
}) {
  // Default the PR base to the branch's recorded base (e.g. a branch cut from
  // `develop` targets develop), falling back to the repo's default branch.
  const recordedBase = baseDescriptor(env)?.shortName;
  const [title, setTitle] = useState(env?.branch ?? '');
  const [body, setBody] = useState('');
  const [base, setBase] = useState(recordedBase ?? env?.defaultBranch ?? 'main');
  const [draft, setDraft] = useState(false);
  const [pickingBase, setPickingBase] = useState(false);
  const [busy, setBusy] = useState(false);

  const baseOptions = [
    recordedBase,
    env?.defaultBranch ?? 'main',
    ...(branches?.remote ?? []).map((b) => stripRemotePrefix(b.name, env?.remotes)),
  ].filter((value, index, all): value is string => !!value && all.indexOf(value) === index);

  const doCreate = async () => {
    if (!title.trim()) return;
    setBusy(true);
    // Push when there is no upstream yet, or when the local branch is ahead, so
    // gh opens the PR from the latest commits instead of a stale remote tip.
    if (!env?.upstream || (env?.ahead ?? 0) > 0) {
      const pushed = await gitPush(cwd, { setUpstream: !env?.upstream });
      if (!pushed.ok) {
        setBusy(false);
        toast.error(pushed.message || 'Could not push branch');
        return;
      }
    }
    const res = await createPullRequest(cwd, { title: title.trim(), body, base, draft });
    setBusy(false);
    if (res.ok) {
      toast.success(`Opened PR #${res.number ?? ''}`.trim());
      if (res.url) void openExternal(res.url);
      onCreated?.();
      onDone();
    } else if (res.reason === 'gh_unavailable') {
      toast.error('GitHub CLI not available');
    } else {
      toast.error(res.message || 'Could not open PR');
    }
  };

  return (
    <div className="mx-2 mb-1.5 space-y-2 rounded-xl bg-droid-elevated/50 px-2.5 py-2.5">
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Pull request title"
        className="w-full rounded-lg bg-droid-bg/60 px-2.5 py-1.5 text-[12.5px] text-droid-text placeholder:text-droid-text-muted/70 focus:outline-none"
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
        placeholder="Description (optional)"
        className="w-full resize-none rounded-lg bg-droid-bg/60 px-2.5 py-2 text-[12.5px] text-droid-text placeholder:text-droid-text-muted/70 focus:outline-none"
      />
      <div className="relative">
        <button
          onClick={() => setPickingBase((v) => !v)}
          className="flex w-full items-center gap-1.5 rounded-lg bg-droid-bg/40 px-2.5 py-1.5 text-[11.5px] hover:bg-droid-bg/60"
        >
          <span className="text-droid-text-muted">Base</span>
          <span className="flex-1 truncate text-left text-droid-text">{base}</span>
          <ChevronDown
            className={`h-3 w-3 transition-transform ${pickingBase ? 'rotate-180' : ''}`}
          />
        </button>
        {pickingBase && (
          <div className="mt-1 max-h-32 overflow-y-auto rounded-lg bg-droid-bg/60 p-1">
            {baseOptions.map((option) => (
              <button
                key={option}
                onClick={() => {
                  setBase(option);
                  setPickingBase(false);
                }}
                className="flex w-full items-center rounded px-1.5 py-1 text-left text-[11.5px] text-droid-text-secondary hover:bg-droid-elevated/60 hover:text-droid-text"
              >
                {option}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="flex items-center justify-between">
        <label className="flex cursor-pointer items-center gap-1.5 text-[11.5px] text-droid-text-secondary">
          <input
            type="checkbox"
            checked={draft}
            onChange={(e) => setDraft(e.target.checked)}
            className="accent-droid-accent"
          />
          Draft
        </label>
        <button
          onClick={() => void doCreate()}
          disabled={!title.trim() || busy}
          className="flex items-center gap-1.5 rounded-lg bg-droid-accent/15 px-2.5 py-1 text-[11.5px] font-medium text-droid-accent transition-colors hover:bg-droid-accent/25 disabled:opacity-40"
        >
          {busy && <Loader2 className="h-3 w-3 animate-spin" />}
          Open PR
        </button>
      </div>
    </div>
  );
}
