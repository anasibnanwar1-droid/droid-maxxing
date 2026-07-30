# Agent Instructions

This repository contains the DROIDEX Electron app, React renderer, Electron host,
and Node sidecar that integrates with the Factory Droid SDK.

Treat every change as production work that another strong engineer must be able
to understand, review, debug, extend, and confidently ship.

## The standard

Choose the smallest complete solution that solves the current problem well.

Beautiful code is boring in the best way: clear names, obvious control flow,
few concepts, predictable state, and no surprises.

- Prefer simple, explicit code over clever code.
- Keep behavior close to the state and invariants it changes.
- Give every piece of mutable state one authoritative owner.
- Preserve working behavior unless the task explicitly changes it.
- Reuse existing code when it represents the same concept.
- Make failures visible and diagnostics actionable.
- Keep the touched area clean without expanding the task.

Do not overengineer. Do not add layers, factories, registries, interfaces,
configuration, extension points, or dependencies for hypothetical future needs.

## Before changing code

1. Read the relevant implementation, tests, types, and architecture docs.
2. Search with `rg` for existing helpers, hooks, commands, events, selectors,
   and names before adding anything.
3. Identify who owns the state and behavior being changed.
4. Check the branch and worktree. Preserve unrelated user changes.
5. For broad or risky work, use a dedicated worktree from a freshly fetched
   `origin/main`.
6. Define the intended behavior and how it will be verified.

Never reset, clean, stash, rebase, overwrite, or broadly reformat a dirty
checkout without explicit permission.

Do not infer permission for unrelated refactors, dependency upgrades, pushes,
PRs, merges, releases, migrations, or authenticated external calls.

## Modules and ownership

A module should own one cohesive product or runtime concept.

- Keep its state, lifecycle, validation, persistence, cleanup, and error handling
  together.
- Expose semantic operations, not internal maps or mutable objects.
- Keep dependency direction explicit.
- Prefer direct calls over internal event buses or generic context bags.
- Keep composition roots focused on construction and routing.
- Delete superseded paths instead of keeping two canonical implementations.

Before extracting code, apply the deletion test:

- If deleting the new module only removes forwarding calls, it is a useless
  wrapper.
- If deleting it would spread meaningful state, sequencing, or validation back
  across several callers, it owns a real responsibility.

Avoid:

- god files mixing unrelated workflows;
- mirrored state or multiple owners;
- vague dumping grounds such as `Utils`, `Helpers`, or generic `Manager`;
- one-line forwarding wrappers;
- interface/default-class pairs with one implementation;
- speculative abstractions;
- hidden global state; and
- abstractions created only to reduce a line count.

## File size

Line count is a warning, not a design goal.

- Leaf UI files should usually stay around 50-250 readable lines.
- Feature modules, hooks, reducers, and screens should usually stay around
  150-400 lines.
- Stop for architecture review before adding a new production file above 500
  lines.
- Any change that creates a production file above 500 lines, takes a file across
  500 lines, or materially grows a file already above 500 lines must stop for
  approval and justify the exception every time.
- The justification must state the file's single cohesive responsibility,
  current and expected line count, why a clean split would make ownership or
  readability worse, which alternatives were rejected, and the reviewed
  ceiling.
- A cohesive state machine may exceed 500 lines only through that explicit
  exception process.
- Never compress readable code or create tiny files merely to satisfy a limit.
- Existing oversized files are debt. Avoid materially growing them. Extract a
  cohesive responsibility only when it belongs to the current task.

Prefer a few focused modules over either a monolith or a maze of tiny files.

## Naming

Names should explain the product concept without requiring the reader to inspect
the implementation.

- Use nouns for concepts and verbs for operations.
- Name booleans as predicates such as `isReady`, `hasHistory`, or
  `canInterrupt`.
- Include units when ambiguous: `timeoutMs`, `tokenLimit`, `startedAt`.
- Avoid abbreviations except established domain terms.
- Do not use one word for multiple identities or lifecycle states.
- Commands and events describe domain intent and facts, not implementation
  details.

Canonical session vocabulary:

- `appSessionId`: stable top-level DROIDEX session identity.
- `parentAppSessionId`: owning top-level identity for a child.
- `childSessionId`: stable logical child identity within its parent.
- `providerSessionId`: replaceable backend/runtime identity.
- `session`: universal runtime and UI concept.
- `mission`: actual AGI Mission Control behavior only.
- `auto`, `spec`, `agi`: interaction modes.
- `off`, `low`, `medium`, `high`: independent autonomy levels.

Workers and validators are child sessions. They remain parent-owned and do not
become top-level navigation sessions.

## Reuse

Search first, but do not force different concepts through one abstraction.

- Reuse code only when behavior, invariants, and failure semantics match.
- Extend a module only when the new behavior belongs to its responsibility.
- Keep code feature-local until a second real consumer proves it is shared.
- A little duplication is better than the wrong abstraction.
- Centralize stable domain rules and test them once through the shared entry
  point.

Moving code into a shared folder is not reuse unless it reduces what callers
need to know.

## Frontend

The renderer is a provider-neutral DROIDEX UI. Backend-specific behavior reaches
it through the bridge and DROIDEX domain contracts.

- Screens compose focused feature modules.
- Keep feature state, selectors, persistence, commands, and visual sections near
  the owning feature.
- Keep Factory, Droid, Codex, and future SDK types out of presentation code.
- Do not hide real provider differences behind a misleading universal
  abstraction. Translate them at the provider seam.
- Prefer pure selectors and reducers for state transitions.
- Put effects in narrowly named hooks with complete cleanup.
- Do not put feature-local state in the root store without a real cross-feature
  need.
- Pass small meaningful values and operations, not giant state objects.
- Build visual primitives locally first. Promote them after real reuse appears.
- Keep controls discoverable, keyboard-usable, and accessible.
- Never ship fake controls or UI that looks functional without real behavior.

For substantial new areas such as Studio, prefer a feature-first shape:

```text
src/features/<feature>/
  <Feature>View.tsx
  components/
  hooks/
  state/
  lib/
  tests/
```

Do not create empty folders or one file per function to imitate this layout.

## TypeScript, contracts, and concurrency

- Prefer precise types, discriminated unions, exhaustive switches, and runtime
  validation at untrusted inputs.
- Avoid `any`, non-null assertions, and casts that bypass missing invariants.
  Narrow assertions at validated external seams must stay local and documented.
- Model mutually exclusive states explicitly instead of combining optional
  fields.
- Keep protocol mirrors synchronized in the same change.
- Never expose backend identity as UI identity.
- Fail fast when canonical state is invalid.
- Do not silently swallow errors.

For asynchronous state:

- Capture stable identity and generation before provider work.
- Revalidate after awaits that can race close, replacement, or shutdown.
- Make settlement and cleanup idempotent.
- Invalidate stale work before awaiting external cleanup.
- Clean timers, subscriptions, pollers, watchdogs, queues, provisional
  resources, and request waiters.

Race fixes require deterministic regression tests, not sleeps.

## Hard-cut product policy

DROIDEX currently has no external installed user base. Maintain one canonical
current implementation.

- Backward compatibility is opt-in, never the default.
- Do not add compatibility shims, migrations, aliases, dual commands, fallback
  fields, legacy readers, or silent recovery for obsolete states unless the
  user explicitly requests support for a specific historical state.
- Do not preserve an old path merely because it already exists or because
  compatibility feels safer.
- Prefer fail-fast diagnostics and explicit recovery instructions.
- Delete replaced compatibility code.

Any explicitly approved temporary compatibility path must document why it
exists, its exact deletion criteria, and the issue or ADR that owns removal.

## Tests

Test behavior through the same entry points used by production.

- Every behavior change gets focused tests.
- Every bug fix gets a regression test for the original failure.
- Prefer deterministic production-faithful fakes over private reach-ins.
- Test failure, cancellation, stale results, close, and cleanup when relevant.
- Reducer tests prove transitions and isolation.
- UI tests prove visible behavior and command targeting, not only snapshots.
- Use integration or Electron smoke tests for cross-process behavior.
- Report authenticated or manual smoke tests as pending when they were not run.

Do not weaken assertions, delete useful coverage, or add sleeps to make tests
pass.

## Workflow and review

1. Establish the exact base and current behavior.
2. Write and approve a design before risky architectural changes.
3. Implement the smallest coherent vertical slice.
4. Keep commits focused, buildable, and honestly named.
5. Run focused checks while developing.
6. Review the diff for duplication, dead code, naming drift, accidental
   compatibility, unrelated formatting, and missing cleanup.
7. Run validation proportional to the risk.
8. Report what changed, what passed, what remains manual, and known debt.

Keep behavior changes separate from structural refactors unless they are
inseparable and explicitly approved. Do not perform drive-by cleanup.

Do not commit internal prompts, private implementation plans, reviewer
transcripts, or agent-process artifacts. Public docs explain the current
product, architecture, operation, and recovery.

## Definition of done

A change is done only when:

- behavior works end to end;
- the implementation is simple and maintainable;
- important contracts and failures are tested;
- relevant validation passes;
- documentation matches the current system;
- users can discover and understand the behavior; and
- the result can be confidently demonstrated and shipped.

## Fast start

Use Node.js 22.

```bash
npm install
npm ci --prefix sidecar
npm run dev
```

For the full desktop app:

```bash
npm run electron
```

## Required validation

Run checks that match the files changed. For broad changes:

```bash
npm run format:check
npm run typecheck
npm run sidecar:typecheck
npm run electron:check
npm run test
npm --prefix sidecar run test
npm run docs:check
npm run build
```

`npm run lint` is currently non-blocking because of existing backlog. New and
changed files remain responsible for their diagnostics.

## Project map

- `src/`: React UI, state, hooks, and frontend tests
- `electron/`: Electron main process, preload scripts, and launcher
- `sidecar/src/`: bridge, Factory runtime, browser runtime, and sidecar tests
- `docs/`: public architecture, generated reference, and runbooks
- `tools/`: maintenance and validation scripts

## Environment variables

Start from `.env.example` for local overrides.

- `ELECTRON_START_URL`: Electron development URL
- `BRIDGE_PORT`: local sidecar WebSocket port
- `BRIDGE_TOKEN`: packaged Electron bridge token
- `DROID_PATH`: explicit Droid CLI path
- `FACTORY_API_KEY`: optional Factory key for Droid child processes

## Secrets

Never commit or print secrets, tokens, personal data, or authenticated payloads.

## Documentation upkeep

When scripts, environment variables, or onboarding commands change:

```bash
npm run docs:generate
npm run docs:check
```

`npm run docs:check` confirms generated docs are current and command references
in `AGENTS.md` map to real package scripts.
