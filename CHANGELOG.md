# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Detailed per-version notes (rationale, code locations, test coverage deltas)
are in [`AUDIT.md`](AUDIT.md). This file is the summary index.

## [Unreleased]

### Added

- Repository `CODEOWNERS` for required-review routing.
- Webhook URL test tightened from substring to exact match (#82).

### Changed

- `dev`: bump `typescript` 6.0.2 → 6.0.3, `vitest` 4.1.2 → 4.1.4,
  `@vitest/coverage-v8` 4.1.2 → 4.1.4, `@types/node` 25.5.0 → 25.6.0.

## [0.8.2] — 2026-04-07

### Fixed

- Tenant-only config (no `budgetScope`) was checking the deepest matching
  budget scope instead of the tenant-level one. `findMatchingBalance` now sorts
  by shortest `scopePath` when no `budgetScope` is set. Reservations/commits
  were unaffected; only budget checks, low-budget warnings, and exhausted
  strategies were evaluating the wrong scope. Fixes #76.

## [0.8.1] — 2026-04-03

### Fixed

- Case-insensitive scope matching. The Cycles server lowercases scope values
  at creation time (e.g. `riderApp` → `riderapp`); `findMatchingBalance` now
  lowercases both sides before comparison so mixed-case `budgetScope` values
  match. Fixes #70.

## [0.8.0] — 2026-04-03

### Added

- `budgetScope` config field — a generic `Record<string, string>` for targeting
  any combination of Cycles scope segments (`workspace`, `app`, `workflow`,
  `agent`, `toolset`). Replaces `budgetId` and supports the full scope
  hierarchy (e.g. `tenant:rider/workspace:road/app:lane`). Fixes #70.
- `SessionSummary` includes `budgetScope`; metrics emit one tag per scope
  segment instead of a single `budgetId` tag.

### Deprecated

- `budgetId` — still works (converted to `budgetScope: { app: budgetId }` and
  warns at startup).

## [0.7.10] — 2026-04-03

### Fixed

- `matchGlob` now supports `*` anywhere in the pattern (not just prefix/suffix).
- `DryRunClient` reservation counter moved from module-level to instance so
  each client has independent IDs.
- Event-log eviction no longer uses O(n) `shift()` on a 10k-element array;
  drops new entries with a warning once capped.
- `asStringRecord` / `asNumberRecord` now validate individual values.
- `fireWebhook` gains a 10s `AbortSignal.timeout`.
- OTLP metrics now flush at `agentEnd` via optional `flush?()` on `MetricsEmitter`.
- Model reservation released on commit failure (previously stayed locked until TTL).
- `costEstimator` / `modelCostEstimator` null return no longer assigned as cost.
- `fetchBudgetState` now has a 10s timeout via `Promise.race` + fail-open fallback.
- Truncation with `maxPromptHintChars < 3` no longer produces a negative index.

### Changed

- `lowBudgetStrategies` rejects unknown values instead of silently ignoring them.
- `asModelFallbacks` validates that values are `string | string[]`.
- `toolBaseCosts`, `modelBaseCosts`, and `defaultModelCost` reject negative values.
- Error prefix in `BudgetExhaustedError` aligned to `"openclaw-budget-guard"`.

## [0.7.6] – [0.7.9] — 2026-03-30 … 2026-03-31

### Fixed

- Model-reservation denial is now honored when `failClosed=true` (previously
  logged a warning but allowed the call).
- Estimated cost is tracked locally when `failClosed=false` allows a denied
  model call to proceed (session summaries / forecasting were undercounting).
- `findMatchingBalance` returns `undefined` on wrong-currency balances instead
  of `balances[0]`, triggering the fail-open path.
- `toolCallLimits` now enforced across OpenClaw's multi-entry plugin init
  (state no longer reset on every channel/worker init).
- `modelFallbacks` gated by `"downgrade_model"` in `lowBudgetStrategies`.
- `limit_remaining_calls` now decremented by model calls too.
- `modelOverride` no longer double-prefixed when values use `provider/model`.
- `logLevel` config now actually filters logs (wraps OpenClaw's logger).
- Warns (instead of silently falling back to `Infinity`) when `budgetId` matches
  no scope.

### Added

- Startup warnings for silently-ineffective config: `maxRemainingCallsWhenLow`,
  `maxTokensWhenLow`, `expensiveToolThreshold` without their enabling strategy.

## [0.7.0] – [0.7.5] — 2026-03-26 … 2026-03-27

### Added

- Branded startup banner and consistent `openclaw-budget-guard` naming across
  logs, metadata keys, hook names, error prefixes, and OTLP service name.
- Single-source version (build-time constant from `package.json`).
- Model-name auto-detection across event fields, `ctx.metadata`, `api.config`,
  `api.pluginConfig` with `defaultModelName` fallback.
- Model-blocking workaround (`modelOverride: "__cycles_budget_exhausted__"`)
  since OpenClaw's `before_model_resolve` has no `{ block: true }`.

### Changed

- Removed `process.env` fallbacks to clear OpenClaw installer "dangerous code
  patterns" warning — users rely on OpenClaw env-var interpolation.

### Fixed

- `BudgetExhaustedError` only thrown on genuinely exhausted budgets (not on
  every DENY).
- Guards against undefined model/tool names.
- Commit-before-delete ordering so failed commits release at `agentEnd`.
- Release-failure logs bumped to `warn`.
- `DryRunClient` double-commit returns `409 RESERVATION_FINALIZED`.
- Division-by-zero guards in `checkBurnRate` and `checkExhaustionForecast`.

## [0.6.0] — 2026-03-26

### Added

- Reservation heartbeat (`heartbeatIntervalMs`) that auto-extends long-running
  tool reservations via the protocol's `extendReservation` endpoint.
- Retryable-error handling on `reserveBudget` (429 / 503 / 504 by default,
  configurable) with exponential backoff.
- Burn-rate anomaly detection (`onBurnRateAnomaly` callback, default 3× window
  threshold).
- Session event log (`enableEventLog=true`, capped at 10k entries) included in
  `sessionSummary.eventLog`.
- Unconfigured-tool report in session summary.
- Predictive exhaustion warning (`onExhaustionForecast` callback).

## [0.5.0] — 2026-03-26

### Added

- Model reserve-then-commit: model reservations held open and committed in the
  next `beforePromptBuild` or at `agentEnd`, allowing `modelCostEstimator` to
  reconcile costs.
- `MetricsEmitter` interface (`gauge` / `counter` / `histogram`) with 12
  metrics at key lifecycle points.
- `StandardMetrics` on commits (`model_version`, tokens, latency).
- Aggressive cache invalidation (default on) — proactive snapshot refetch after
  every commit/release.
- OTLP HTTP metrics adapter, auto-created when `otlpMetricsEndpoint` is set.

## [0.4.0] — 2026-03-26

### Fixed

- Install no longer crashes with "must have required property 'tenant'"
  (removed `tenant` from `configSchema.required`; runtime validation preserved).
- Plugin ID aligned to `openclaw-budget-guard` so OpenClaw no longer warns on
  every load.
- Plugin now reads `api.pluginConfig ?? api.config` (was reading only
  `api.config`), so configured tenants are actually picked up.
- Install-time `resolveConfig` errors are caught and logged instead of thrown
  before config is written.

### Added

- Startup config summary (tenant, base URL, masked API key, key settings).

## [0.3.0] – [0.3.4] — 2026-03-24 … 2026-03-26

Iterative protocol alignment and installer-ergonomics fixes. See `AUDIT.md`.

## [0.2.0] — 2026-03-24

Protocol-alignment refactor around the Cycles v0.1.24 terminology
(`Amount(unit, amount)`, `estimate` / `actual`).

## [0.1.0] — 2026-03-20

Initial release of the OpenClaw plugin — reserve/commit/release against Cycles
budgets, tool-cost estimation, fail-open/fail-closed policies, session summary.

[Unreleased]: https://github.com/runcycles/cycles-openclaw-budget-guard/compare/v0.8.2...HEAD
[0.8.2]: https://github.com/runcycles/cycles-openclaw-budget-guard/compare/v0.8.1...v0.8.2
[0.8.1]: https://github.com/runcycles/cycles-openclaw-budget-guard/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/runcycles/cycles-openclaw-budget-guard/compare/v0.7.10...v0.8.0
[0.7.10]: https://github.com/runcycles/cycles-openclaw-budget-guard/compare/v0.7.9...v0.7.10
[0.7.6]: https://github.com/runcycles/cycles-openclaw-budget-guard/compare/v0.7.5...v0.7.9
[0.7.0]: https://github.com/runcycles/cycles-openclaw-budget-guard/compare/v0.6.1...v0.7.5
[0.6.0]: https://github.com/runcycles/cycles-openclaw-budget-guard/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/runcycles/cycles-openclaw-budget-guard/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/runcycles/cycles-openclaw-budget-guard/compare/v0.3.4...v0.4.0
[0.3.0]: https://github.com/runcycles/cycles-openclaw-budget-guard/compare/v0.2.0...v0.3.4
[0.2.0]: https://github.com/runcycles/cycles-openclaw-budget-guard/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/runcycles/cycles-openclaw-budget-guard/releases/tag/v0.1.0
