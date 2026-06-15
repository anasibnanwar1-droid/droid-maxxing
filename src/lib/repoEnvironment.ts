export interface RepoStatus {
  repoRoot: string | null;
  branch: string | null;
  changed: number;
  staged: number;
  unstaged: number;
  untracked: number;
}

export function environmentLabels(cwd: string, status: RepoStatus | null | undefined) {
  return {
    changes:
      status === undefined
        ? 'Checking'
        : status === null
          ? 'No repo'
          : status.changed > 0
            ? `${status.changed} change${status.changed === 1 ? '' : 's'}`
            : 'Clean',
    location: basename(status?.repoRoot ?? cwd) || 'No folder',
    branch: status?.branch || 'No branch',
  };
}

function basename(value: string): string {
  return value.split(/[\\/]/).filter(Boolean).pop() ?? '';
}
