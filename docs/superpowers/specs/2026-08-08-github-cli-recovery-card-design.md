# GitHub CLI Recovery Card Design

Date: 2026-08-08
Branch: `hotfix/v1.1.1-production-integrations`
Base: `origin/main` at `1458290012df142736501361ea2a46df4ff04277`

## Goal

Make the Context panel's GitHub pull-request integration self-diagnosing and recoverable in the packaged macOS app. When GitHub CLI is missing or signed out, the same area that normally shows pull-request context must explain the problem and provide the next safe action.

The recovery must work from a Finder-launched app with a minimal PATH. It must use the user's GitHub CLI credentials, never collect or persist GitHub tokens inside DROIDEX, and never perform an installation before an explicit button click.

## Scope

This change covers the currently shipped macOS application and GitHub.com repositories.

It adds:

- an inline GitHub setup card in the Context panel;
- explicit GitHub CLI availability state in the renderer;
- Homebrew-based GitHub CLI installation when Homebrew is already installed;
- an official installation-page fallback when Homebrew is unavailable; and
- GitHub CLI's browser/device authentication flow when GitHub CLI is installed but unauthenticated.

It does not install Homebrew, run remote shell scripts, use `sudo`, bundle GitHub CLI, implement DROIDEX-owned OAuth, support GitHub Enterprise authentication, or change git commit/push behavior.

## User experience

The setup card appears directly below the existing git action row, where pull-request context normally begins. It uses the existing compact Context-panel card, typography, spacing, focus, disabled, and error styles rather than introducing a new visual system.

The UI has one authoritative availability result and one transient action state.

### Checking

While the first availability probe is unresolved, DROIDEX does not flash an error card. GitHub-dependent PR actions remain unavailable until the probe settles.

### GitHub CLI missing, Homebrew available

The card says **GitHub CLI required** and briefly explains that PR checks and comments require GitHub CLI. Its primary action is **Install GitHub CLI**.

Clicking the button starts `brew install gh` and changes the action to a disabled **Installing…** state. Success immediately re-probes GitHub CLI. Failure remains inline with a concise error and a retry button.

### GitHub CLI missing, Homebrew unavailable

The same card explains that no supported installer was found. **Install GitHub CLI** opens GitHub CLI's official installation page in the default browser. After that explicit action, the button becomes **Check installation**. DROIDEX also rechecks when the window becomes visible again, so returning from the browser can advance without another click.

DROIDEX does not install Homebrew or execute an installer copied from the internet.

### GitHub CLI installed but unauthenticated

The card changes to **Connect GitHub** with a **Sign in to GitHub** button. Clicking it starts GitHub CLI's non-interactive web/device flow. The one-time code is copied to the clipboard by GitHub CLI, DROIDEX opens the exact GitHub device-login URL emitted by GitHub CLI, and the card shows **Waiting for GitHub…** while GitHub CLI polls for completion.

On success DROIDEX re-runs `gh auth status`, refreshes pull-request detection, and removes the card. On cancellation, timeout, browser-open failure, or authentication failure, the card remains with a concise retryable error. No token or authenticated command output is sent to the renderer or written to logs.

### Ready

When GitHub CLI is installed and authenticated, the setup card is absent and the current PR row, PR detail panel, comments, checks, and create-PR behavior render normally.

GitHub-dependent actions are not presented as usable while setup is incomplete. Local git actions such as commit and push remain unchanged.

## State and ownership

`RightPanel` owns the Context panel's GitHub setup lifecycle because it already owns the active repository, PR detection, and Context/PR view switch. A focused hook may own the asynchronous probe/action state, but it must expose product-level operations rather than child-process details.

The renderer state is:

- `checking`: the first availability probe has not settled;
- `missing` with installer mode `homebrew` or `manual`;
- `unauthenticated`;
- `ready`; and
- transient `installing` or `authenticating`, with an optional retryable error.

Repository/session changes invalidate in-flight renderer requests before their results can update the new Context panel. A successful setup operation triggers both an availability refresh and the existing pull-request refresh. The existing PR polling remains the owner of PR data.

Availability is checked on Context mount, repository change, explicit retry, setup completion, and window visibility after the manual installation page was opened. It is not added to the existing 20-second PR polling loop.

## Electron boundary

The Electron GitHub module remains the sole owner of executable discovery and GitHub CLI processes. The preload exposes narrow operations for:

- availability, including whether a supported Homebrew executable exists;
- installing GitHub CLI through Homebrew; and
- starting browser authentication.

All IPC handlers validate that the request originated from the main renderer, matching other privileged Electron operations.

### Homebrew installation

Homebrew resolution follows the same packaged-app discipline as GitHub CLI resolution: validate absolute candidates from PATH and the standard Apple Silicon and Intel locations, then use a bounded login-shell lookup only for discovery. The installation executes the resolved absolute `brew` executable with the fixed argument vector `install gh` through `execFile`/`spawn`, never through a shell.

Only one install operation may run at a time. It has a bounded timeout, terminates on app shutdown, and returns a small result containing success or a safe user-facing reason. After success, the cached GitHub CLI miss is invalidated and `gh --version` must pass before installation is reported complete.

### Browser authentication

Authentication executes the resolved absolute GitHub CLI with fixed arguments equivalent to:

```text
gh auth login --hostname github.com --git-protocol https --web --clipboard --skip-ssh-key
```

The process uses pipes so GitHub CLI selects its non-interactive web/device flow. Electron incrementally reads bounded output only to detect the verification URL and completion/failure. It opens a URL only when its parsed origin and path exactly match `https://github.com/login/device`; every other URL is rejected.

GitHub CLI owns device-code creation, clipboard copying, polling, credential storage, and token persistence. DROIDEX never parses, receives, stores, or displays the resulting token. Authentication is successful only when the process exits successfully and a fresh `gh auth status --hostname github.com` succeeds.

Only one authentication process may run at a time. It is terminated on timeout or app shutdown. Output returned to the renderer is a fixed reason/message, not raw stderr.

## Failure behavior

Failures stay explicit and local to the setup card:

- GitHub CLI still missing after Homebrew exits successfully: installation verification failed;
- Homebrew missing: open the official installation page;
- package-manager failure or timeout: show a retryable installation error;
- device URL not observed or rejected: stop authentication and show a retryable error;
- browser failed to open: stop authentication and show a retryable error;
- authentication cancelled, timed out, or exited non-zero: show a retryable sign-in error;
- final `gh auth status` failure: remain unauthenticated.

Existing last-known PR data must not be shown as current when availability is missing or unauthenticated.

## Accessibility and discoverability

The card has a visible title, a short explanation, and one clear primary action. Buttons use native button semantics, visible keyboard focus, disabled state during work, and an adjacent spinner with status text. Errors use text in addition to color and are announced through a polite live region.

The action copy always describes the next operation: **Install GitHub CLI**, **Check installation**, **Sign in to GitHub**, **Installing…**, or **Waiting for GitHub…**.

## Testing

Electron tests cover:

- Homebrew discovery under Finder-style PATH on Apple Silicon and Intel paths;
- missing Homebrew;
- the exact `brew install gh` executable and argument vector;
- concurrent install rejection, timeout, failure, and post-install GitHub CLI verification;
- the exact GitHub CLI authentication argument vector;
- incremental recognition of only the allowed GitHub device URL;
- browser-open failure, non-zero exit, timeout, shutdown cleanup, and final auth verification;
- cache invalidation after installation; and
- IPC/preload contract propagation without raw command output.

Renderer tests cover:

- no error flash while checking;
- missing/Homebrew, missing/manual, unauthenticated, busy, failed, and ready card states;
- the manual-install button changing to **Check installation**;
- recheck on window visibility after opening the installation guide;
- disabling GitHub-dependent PR actions until ready;
- successful install advancing to sign-in;
- successful authentication removing the card and refreshing PR detection;
- stale async results being ignored after repository changes; and
- keyboard focus, disabled state, and live error/status text.

A packaged macOS smoke test launches DROIDEX with a clean isolated profile and Finder-style PATH, then verifies both Homebrew architectures where available, the official-page fallback, device-browser opening, successful authentication detection, and restoration of PR context. The smoke test must not disturb the installed DROIDEX profile.

## Release boundary

This work remains on `hotfix/v1.1.1-production-integrations` in the dedicated hotfix worktree. It does not alter the app ID, updater feed, persistence schema, release asset names, or Sparkle metadata.

No branch push, PR, merge, tag, or release occurs without explicit user approval. After push is authorized, the PR must pass Cubic review and the repository's required checks before it can be considered releasable.
