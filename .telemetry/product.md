# DROIDEX product model

## Product

DROIDEX is a local-first Electron workspace for running and managing Factory
Droid agent sessions across projects, chats, terminals, and browser workflows.
It is currently a single-user desktop product without DROIDEX accounts,
organizations, billing, or a server-side product database.

## Value and entities

The primary value is completing useful work through a local agent session. The
runtime entities are a local profile, app session, project, and agent session.
Only local-profile and app-session health belong in the current operational
telemetry system.

## Measurement boundary

- Destination: private Sentry Electron project.
- Purpose: crashes, manual feedback, Release Health, and release adoption.
- Identity: one random pseudonymous `USR-…` ID stored per local Electron profile.
- Direct identity policy: no account identity, email, name, or other direct PII.
- Groups: none.
- Internal policy: production usage views exclude the `development` environment.
- Never collect prompts, commands, chats, files or paths, project names, browser
  activity, credentials, environment variables, or diagnostic logs as usage
  telemetry.

Automatic crash intake can include exception stacks, technical Sentry contexts,
and native minidumps that may contain incidental sensitive process data. Users
can disable automatic diagnostics and reset the local profile ID in Settings.
Sentry is not the product-analytics destination. Feature adoption, funnels, and
retention require a separate privacy-reviewed analytics system and tracking plan.
