# Production Integrations Hotfix Design

Date: 2026-08-08
Branch: `hotfix/v1.1.1-production-integrations`
Base: `origin/main` at `1458290012df142736501361ea2a46df4ff04277`

## Goal

Ship a narrow production hotfix for behavior that works in a terminal-launched development build but is incomplete or misleading in the packaged macOS app:

1. Resolve and run the user's installed GitHub CLI from a GUI-launched app.
2. Request macOS notification permission and report notification delivery truthfully.
3. Let users clear all in-app unread chats from the existing unread view.
4. Trace and fix the user-report delivery failure represented by `RPT-20260808-DBFC7FC3AD47` once its failing boundary is proven.

The hotfix must preserve the existing app-update path and avoid unrelated release, indexing, caching, or UI changes.

## Non-goals

- Replacing GitHub CLI authentication or storing GitHub credentials.
- Changing when background completion notifications are eligible to appear.
- Adding another bell, per-chat context menus, or a “mark all unread” action.
- Redesigning the sidebar or notification settings.
- Shipping a speculative Sentry workaround without a reproduced or evidenced root cause.
- Changing the updater, bundle identity, signing workflow, or persisted data format.

## GitHub CLI discovery

The Electron GitHub integration owns one executable resolver. Every GitHub CLI call uses the resolved absolute executable rather than invoking bare `gh` independently.

Resolution order:

1. Resolve `gh` from the Electron process PATH.
2. Check standard macOS package-manager locations: `/opt/homebrew/bin/gh`, `/usr/local/bin/gh`, and `/opt/local/bin/gh`.
3. Ask the user's configured login shell for `command -v gh` using a fixed command with no user-provided shell input.

Each candidate must be an executable file and pass a bounded `gh --version` probe. The first valid result is cached for the process lifetime. Failure remains explicit: unavailable CLI, unauthenticated CLI, and command failure are distinct states so the renderer can explain the recovery action.

Tests run the resolver with a Finder-style PATH and controlled candidate files. They cover PATH discovery, Apple Silicon Homebrew discovery, login-shell discovery, invalid candidates, and absence. Existing GitHub operations must be proven to reuse the resolved executable.

## macOS notification permission and delivery

The renderer requests notification permission through the browser notification API before a user enables or tests desktop notifications. A denied permission produces a clear in-app message directing the user to macOS System Settings; it must never be presented as a successful notification.

The Electron notification IPC returns a small discriminated result instead of `void`:

- `shown: true` after Electron emits `show`.
- `shown: false` with a reason for unsupported platforms, denied permission, Electron `failed`, or a bounded delivery timeout.

The preload and renderer contracts preserve that result. The settings test action displays success only for `shown: true`; all other outcomes display the specific recovery or failure message. Existing background-only completion behavior remains unchanged.

Tests cover permission granted and denied states, Electron `show` and `failed` events, timeout cleanup, preload contract propagation, and truthful settings feedback. A packaged manual smoke test verifies the first-use macOS permission prompt and delivery with DROIDEX unfocused.

## Mark all chats as read

The existing bell remains the entry point for the unread-only sidebar view. While that view is active and at least one unread chat exists, a compact sidebar-styled **Mark all as read** button appears next to the unread control/list header.

Activating it performs one semantic store operation that advances every current session's `sessionLastSeen` value to at least that session's latest update time. The existing persistence mechanism saves the updated map. The sidebar then exits unread-only mode and returns to the full chat list.

The store remains the only owner of read state. There is no second unread counter, local component mirror, per-chat menu, or macOS notification interaction.

Reducer tests prove all current sessions become read without changing unrelated session state. Sidebar tests prove the button is discoverable only in the active unread view, invokes the global operation once, and returns to the full list.

## Sentry user-report delivery

The trace confirmed that the current success state is weaker than the UI claims. DROIDEX creates the `RPT-...` receipt locally, sends a raw `info` message event, treats any HTTP 2xx as success, and ignores Sentry's response body and event ID. The receipt therefore proves only that the envelope endpoint accepted the request; it does not prove that the report became a discoverable Sentry Issue.

The hotfix preserves the local receipt for user support correlation but restores an error/exception-shaped manual-report event so reports enter the Sentry Issues workflow. Delivery parses Sentry's JSON acknowledgment and requires its event ID to match the submitted event ID before the UI reports success. A missing, malformed, or mismatched acknowledgment is a failed submission and keeps the report available for retry.

The report path remains verified across each boundary:

1. Renderer form validation and submit result.
2. Preload/IPC serialization.
3. Electron envelope construction and DSN parsing.
4. HTTP response status and response body handling.
5. The receipt shown to the user and any Sentry event identifier available from ingestion.

Tests cover a matching acknowledgment, missing response ID, malformed response, mismatched ID, non-2xx response, and the error/exception payload contract. Documentation calls this result “accepted by Sentry,” not durable storage or indexing confirmation. The release configuration also validates the expected public DSN host and project identifier so a build cannot silently target another project. No authenticated Sentry query or production test report is sent without separate authorization.

## Compatibility and release safety

The changes are additive runtime behavior behind existing entry points. They do not change the app ID, updater feed, release asset names, persistence schema, session identity, or sidecar protocol. Existing persisted `sessionLastSeen` data remains canonical; mark-all only writes values through the existing persistence path.

Before release, validation includes focused regression tests plus the repository checks required by the touched files. A packaged DMG smoke test upgrades over the current public build and verifies launch, existing data visibility, GitHub CLI discovery under a minimal GUI PATH, notification permission/delivery, unread clearing, report feedback, and updater metadata.

## Delivery boundary

Implementation and commits remain on the dedicated hotfix worktree. Pushing the branch, opening a PR, merging, tagging, or publishing a release requires explicit user approval after validation results are available.
