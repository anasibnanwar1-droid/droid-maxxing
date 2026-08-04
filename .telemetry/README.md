# DROIDEX telemetry

This folder records what DROIDEX measures, why it is measured, and the privacy
boundary. The current implementation uses Sentry only for operational
observability and Release Health. It does not contain product analytics events.

| File | Purpose |
| --- | --- |
| `product.md` | Product and privacy model |
| `current-state.yaml` | Audited implementation state |
| `tracking-plan.yaml` | Canonical measurement plan |
| `delta.md` | Current-to-target implementation status |
| `instrument.md` | Engineering guide for Sentry instrumentation |

Do not commit `.session-log.json`. Update these files whenever telemetry behavior
or collected data changes.
