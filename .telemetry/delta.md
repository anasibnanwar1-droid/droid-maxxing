# Telemetry delta: current to target

The target contains zero product analytics events. Sentry is intentionally used
only for operational observability and Release Health.

## Operational change

| Change | Status | Why |
| --- | --- | --- |
| Load the stable local profile ID before Sentry initializes | Code complete; packaged smoke pending | Attributes the first Release Health session correctly |
| Start packaged app sessions with the pseudonymous user ID | Code complete; packaged smoke pending | Enables active-profile and observed release-adoption counts |
| Disclose and control automatic diagnostics | Implemented | Users can disable reporting and reset the local profile ID |
| Keep default PII, breadcrumbs, and performance tracing disabled | Retained | Preserves the documented privacy boundary |
| Add custom Sentry analytics messages | Rejected | Sentry messages are not a product analytics API |

Target event accounting: 0 add + 0 rename + 0 keep = 0 events.
