# cycles-openclaw-budget-guard — Plugin Audit

**Date:** 2026-04-03
**Plugin:** `@runcycles/openclaw-budget-guard` v0.8.1
**Runtime:** OpenClaw >= 0.1.0, Node 20+
**Cycles client:** `runcycles` ^0.2.0

---

## Summary

| Category | Pass | Issues |
|----------|------|--------|
| OpenClaw Plugin Contract | 4/4 | 0 |
| Config Schema (plugin.json ↔ types.ts ↔ config.ts) | 62/62 | 0 |
| Config Validation & Defaults | 5/5 | 0 |
| Hook Registrations (index.ts ↔ hooks.ts) | 5/5 | 0 |
| Hook Return Types | 5/5 | 0 |
| Cycles API Usage (endpoints & wire format) | 4/4 | 0 |
| Budget Classification Logic | 3/3 | 0 |
| Error Types & Codes | 2/2 | 0 |
| Fail-Open / Fail-Closed Behavior | 4/4 | 0 |
| Reservation Lifecycle (reserve → commit → release) | — | 0 |
| Snapshot Caching & Invalidation | — | 0 |
| Prompt Hint Formatting | — | 0 |
| Session Summary & Metadata | — | 0 |
| Published Package Contents (`files` field) | — | 0 |
| Code Review (logic, safety, types) | 14 found | 9 fixed, 5 accepted |

**Overall: Plugin is contract-conformant and production-ready.** All 62 config properties (54 JSON-serializable + 8 callbacks), 5 hook registrations, 4 Cycles API operations, and 18 feature gap implementations are internally consistent and correctly tested. v0.5.0 adds model reserve-then-commit, MetricsEmitter, StandardMetrics, aggressive cache invalidation, and OTLP adapter. v0.6.0 adds heartbeat, retry, burn rate detection, event log, unconfigured tool report, and exhaustion forecast. v0.7.x adds branded startup, consistent naming, single-source version, process.env removal, model name auto-detection, and reservation lifecycle fixes. v0.7.6–v0.7.9 fix budget enforcement bugs, config validation gaps, and documentation. v0.7.10 fixes glob matching, record validation, webhook timeout, metrics flush, event log performance, DryRunClient ID isolation, model reservation cleanup, null cost estimator handling, budget fetch timeout, config validation for strategies/fallbacks/negative costs, error prefix consistency, and prompt hint truncation edge case.

---

## v0.8.1 Changes (2026-04-03)

### Bug fix

| Fix | Description | Location |
|---|---|---|
| Case-insensitive scope matching | The Cycles server lowercases all scope values at creation time (e.g. `riderApp` → `riderapp`). `findMatchingBalance` used case-sensitive `String.includes()`, so mixed-case `budgetScope` values failed to match. Now lowercases both sides before comparison. Fixes #70. | `src/cycles.ts:findMatchingBalance` |

---

## v0.8.0 Changes (2026-04-03)

### New feature: `budgetScope`

Replaces `budgetId` with a generic `budgetScope` object that supports the full Cycles scope hierarchy (`workspace`, `app`, `workflow`, `agent`, `toolset`). This fixes issue #70 where budgets with intermediate scope segments (e.g. `tenant:rider/workspace:road/app:lane`) were not correctly targeted by reservations.

| Change | Description | Location |
|---|---|---|
| `budgetScope` config field | New `Record<string, string>` field for targeting any combination of Cycles scope segments. Replaces `budgetId`. | `src/types.ts`, `src/config.ts`, `openclaw.plugin.json` |
| `budgetId` deprecated | Still works — converted to `budgetScope: { app: budgetId }` internally. Warns at startup. | `src/config.ts`, `src/index.ts` |
| Balance query uses `budgetScope` | `fetchBudgetState` spreads `budgetScope` into query params instead of only `app`. | `src/cycles.ts` |
| Reservation subject uses `budgetScope` | `reserveBudget` spreads `budgetScope` into subject instead of only `app`. | `src/cycles.ts` |
| Balance matching uses `budgetScope` | `findMatchingBalance` checks all scope values match, not just `budgetId`. | `src/cycles.ts` |
| Metrics tags use `budgetScope` | Scope keys emitted as individual metric tags instead of single `budgetId` tag. | `src/hooks.ts` |
| Session summary includes `budgetScope` | `SessionSummary` type includes `budgetScope` field. | `src/types.ts`, `src/hooks.ts` |

### Test coverage

| Metric | v0.7.10 | v0.8.0 |
|---|---|---|
| Test count | 341 | 349 |
| Statement coverage | 98.85% | 98.99% |
| Branch coverage | 96.60% | 96.69% |
| Line coverage | 99.50% | 99.51% |

---

## v0.7.10 Changes (2026-04-03)

### Bug fixes

| Fix | Description | Location |
|---|---|---|
| `matchGlob` only supports prefix/suffix wildcards | Patterns like `aws_*_tool` did not match `aws_s3_tool`. Rewrote to convert glob patterns to regex, supporting `*` anywhere in the pattern. | `src/budget.ts:matchGlob` |
| Module-level `nextId` in DryRunClient | Counter was shared across all DryRunClient instances. Moved to instance field so each client has independent IDs. | `src/dry-run.ts` |
| Event log O(n) `shift()` for eviction | `eventLog.shift()` is O(n) on a 10,000-element array. Changed to drop new entries when cap is reached. Logs a warning on first drop. | `src/hooks.ts:logEvent` |
| `asStringRecord`/`asNumberRecord` skip value validation | Cast objects without checking individual values were the correct type. Added `.every()` checks matching the pattern used by `asStringArray`/`asNumberArray`. | `src/config.ts` |
| `fireWebhook` has no timeout | Webhook fetch calls had no timeout, risking indefinitely held connections. Added `AbortSignal.timeout(10_000)`. | `src/hooks.ts:fireWebhook` |
| OTLP metrics not flushed at `agentEnd` | Buffered metrics could be lost on process exit. Added optional `flush?()` to `MetricsEmitter` interface and call it at end of `agentEnd`. | `src/types.ts`, `src/hooks.ts:agentEnd` |
| Model reservation not released on commit failure | `agentEnd` called `commitPendingModelReservation()` without try-catch. If commit failed, the reservation stayed locked until TTL. Now catches and releases. | `src/hooks.ts:agentEnd` |
| `costEstimator`/`modelCostEstimator` null return not handled | If either returned `null` (not `undefined`), null was assigned as the actual cost. Now uses `!= null` check to reject both null and undefined. | `src/hooks.ts` |
| Inconsistent error prefix in `BudgetExhaustedError` | Message said `"cycles-openclaw-budget-guard"` while all other strings use `"openclaw-budget-guard"`. Fixed to be consistent. | `src/types.ts` |
| `lowBudgetStrategies` accepts invalid names | Invalid values like `"teleport_model"` were silently ignored. Now validates against known strategies and throws on unknown values. | `src/config.ts` |
| `asModelFallbacks` doesn't validate values | `{ "gpt-4o": 123 }` was accepted as valid. Now validates that values are `string \| string[]` and throws on invalid types. | `src/config.ts` |
| No timeout on `fetchBudgetState` | A hung Cycles server could block hook execution indefinitely. Added 10s timeout via `Promise.race` with fail-open fallback. | `src/hooks.ts:getSnapshot` |
| Negative cost values not validated | `toolBaseCosts`, `modelBaseCosts`, and `defaultModelCost` accepted negative values, corrupting budget tracking. Now throws on negative costs. | `src/config.ts` |
| Truncation with small `maxPromptHintChars` | When `maxPromptHintChars < 3`, `slice(0, n - 3)` produced a negative index. Now uses `Math.max(0, n - 3)`. | `src/budget.ts`, `src/hooks.ts` |

### Startup validation

| Warning | Trigger |
|---|---|
| Fallback model has no `modelBaseCosts` entry | `modelFallbacks` includes a model not in `modelBaseCosts` — it defaults to `defaultModelCost` which may be higher than the original |

### Test coverage

| Metric | v0.7.9 | v0.7.10 |
|---|---|---|
| Test count | 314 | 341 |
| Statement coverage | 99.14% | 98.85% |
| Branch coverage | 96.88% | 96.60% |
| Line coverage | 100% | 99.50% |

---

## v0.7.6–v0.7.9 Changes (2026-03-30 – 2026-03-31)

### Bug fixes

| Fix | Description | Location |
|---|---|---|
| Model reservation denial ignored when failClosed=true | When the Cycles server denied a model reservation (e.g., estimate exceeds remaining budget), the plugin logged a warning but allowed the call to proceed. Now respects `failClosed`: when true, denied model reservations block the call with `modelOverride: "__cycles_budget_exhausted__"`, consistent with tool denial behavior. | `src/hooks.ts:beforeModelResolve` |
| No cost tracking when failClosed=false and reservation denied | When `failClosed=false` allowed a denied model call to proceed, the estimated cost was never tracked. Session summaries and forecasting undercounted actual usage. Now tracks cost locally via `costBreakdown`, `totalModelCost`, and `totalModelCalls`. | `src/hooks.ts:beforeModelResolve` |
| Wrong-currency balance used as fallback | `findMatchingBalance` returned `balances[0]` when no balance matched the configured currency, causing budget decisions based on wrong-currency amounts. Now returns `undefined`, triggering the existing fail-open path. | `src/cycles.ts:findMatchingBalance` |
| `toolCallLimits` never enforced | OpenClaw calls the plugin entrypoint multiple times per session (once per channel/worker). Each call ran `initHooks()` which reset `toolCallCounts` to empty, so `toolCallLimits` could never trigger. Now `initHooks` only resets session state on the first call; subsequent calls preserve accumulated counters. | `src/hooks.ts:initHooks` |
| `modelFallbacks` not gated by `lowBudgetStrategies` | Model downgrade logic ran whenever budget was "low", ignoring whether `"downgrade_model"` was in `lowBudgetStrategies`. Every other strategy was properly gated. Now consistent — removing `"downgrade_model"` from strategies disables model downgrading. | `src/hooks.ts:beforeModelResolve` |
| `limit_remaining_calls` didn't count model calls | `remainingCallsAllowed` was only decremented by tool calls, never model calls. An agent making only model calls while budget was "low" would never hit the limit. Now both model and tool calls decrement the shared counter. | `src/hooks.ts:beforeModelResolve` |
| `modelOverride` double-prefixed by OpenClaw | When `modelFallbacks` values used `provider/model` format, OpenClaw prepended the provider again (e.g., `openai/openai/gpt-5-nano`). Now strips the provider prefix from `modelOverride` before returning to OpenClaw. | `src/hooks.ts:beforeModelResolve` |
| `logLevel` config had no effect | The plugin always used OpenClaw's `api.logger` directly, bypassing the configured `logLevel`. Now wraps `api.logger` with level filtering so `logLevel: "error"` actually suppresses debug/info/warn. | `src/index.ts`, `src/logger.ts` |
| No warning when `budgetId` doesn't match any scope | When `budgetId` was set but no matching app scope existed in Cycles, the plugin silently fell back to `remaining: Infinity`. Now logs a warning explaining that `budgetId` is the app scope name, not the `ledger_id`. | `src/cycles.ts:fetchBudgetState` |

### Startup config validation

Added warnings for common silent misconfigurations:

| Warning | Trigger |
|---|---|
| `maxRemainingCallsWhenLow` has no effect | Set without `"limit_remaining_calls"` in `lowBudgetStrategies` |
| `maxTokensWhenLow` has no effect | Set without `"reduce_max_tokens"` in `lowBudgetStrategies` |
| `expensiveToolThreshold` has no effect | Set without `"disable_expensive_tools"` in `lowBudgetStrategies` |

Added `lowBudgetStrategies` and `maxRemainingCallsWhenLow` to the startup banner.

### Documentation

- README: Added dedicated `failClosed` behavior section with comparison table
- README: All config examples use `provider/model` format (e.g., `openai/gpt-4o`, `anthropic/claude-opus-4-20250514`)
- README: Added note explaining model names must match OpenClaw's `provider/model` format
- README: Updated `failClosed` config table description with link to behavior section
- README: Expanded `lowBudgetStrategies` section with full descriptions, examples, and execution order
- README: Added `budgetId` scoping section with Cycles scope hierarchy, setup steps, and examples
- README: Added function-type config section explaining JSON alternatives and OpenClaw limitations
- README: Added cost tuning workflow using session summaries
- docs repo: Fixed model names in `how-to/integrating-cycles-with-openclaw.md`, homepage snippet, and 2 blog posts
- CI: Added `npm install -g npm@latest` to publish job to fix missing README on npmjs.com

### Test coverage

| Metric | v0.7.5 | v0.7.9 |
|---|---|---|
| Test count | 300 | 314 |
| Test files | 10 | 10 |
| Statement coverage | 99.47% | 99.02% |
| Branch coverage | 97.74% | 96.73% |
| Line coverage | 100% | 99.86% |

---

## v0.7.x Changes (2026-03-27)

### New features

| Feature | Description | Location |
|---|---|---|
| Branded startup | `Cycles Budget Guard for OpenClaw` banner with URL at plugin init. Short one-liner on subsequent inits. | `src/index.ts` |
| Consistent naming | Internal prefix renamed from `cycles-budget-guard` to `openclaw-budget-guard` across logs, metadata keys, hook names, error prefixes, OTLP service name | All source files |
| Single-source version | Build-time constant from `package.json` via tsup `define`. Bumping requires only `package.json` + `openclaw.plugin.json`. | `tsup.config.ts`, `src/version.ts` |
| No process.env | Removed env var fallbacks to eliminate OpenClaw installer "dangerous code patterns" warning. Users use OpenClaw env var interpolation instead. | `src/config.ts` |
| Model name auto-detect | Checks event fields, ctx.metadata, api.config, api.pluginConfig for model name. Falls back to `defaultModelName` config. Logs available keys at info level when not found. | `src/hooks.ts`, `src/index.ts` |
| `defaultModelName` config | Fallback model name for OpenClaw which doesn't pass model in hook events. | `src/types.ts`, `src/config.ts`, `openclaw.plugin.json` |
| Model blocking workaround | OpenClaw's `before_model_resolve` has no `{ block: true }` support. When budget is exhausted, returns `{ modelOverride: "__cycles_budget_exhausted__" }` causing provider rejection. [Feature request filed](https://github.com/openclaw/openclaw/issues/55771). | `src/hooks.ts:beforeModelResolve` |

### Bug fixes

| Fix | Description | Location |
|---|---|---|
| BudgetExhaustedError on healthy budget | Plugin threw "Budget exhausted" on any DENY regardless of actual budget level. Now only blocks when budget is genuinely exhausted. | `src/hooks.ts:beforeModelResolve` |
| Undefined model/tool names | Guard against undefined event fields with validation and fallbacks. | `src/hooks.ts` |
| Commit-before-delete ordering | `activeReservations.delete()` moved after `commitUsage()` so failed commits are released at agentEnd. | `src/hooks.ts:afterToolCall` |
| Release failures at debug level | Bumped to warn — operators need to see budget leak warnings. | `src/cycles.ts:releaseReservation` |
| DryRunClient double-commit | Returns 409 RESERVATION_FINALIZED matching real Cycles server behavior. | `src/dry-run.ts` |
| Division by zero guards | `checkBurnRate` guards `elapsed <= 0`, `checkExhaustionForecast` guards `burnRatePerMs <= 0`. | `src/hooks.ts` |

### Config additions

| Property | Type | Default | Description |
|---|---|---|---|
| `defaultModelName` | string | — | Fallback model name when OpenClaw doesn't pass it in hook events |

### Documentation

- README rewritten: softened claims, surfaced fail-open behavior, added cost model explainer, production checklist, use-case guide
- Content moved to `ARCHITECTURE.md`: project structure, architecture diagram, CI/publishing
- Known Limitations cleaned: removed struck-through items, added heartbeat caveat, model blocking workaround, model name limitation

### Test coverage

| Metric | v0.6.0 | v0.7.3 |
|---|---|---|
| Test count | 289 | 300 |
| Test files | 9 | 10 |
| Statement coverage | 99.45% | 99.47% |
| Branch coverage | 97.95% | 97.74% |
| Line coverage | 100% | 100% |

---

## v0.6.0 Changes (2026-03-26)

### New features

| Feature | Description | Location |
|---|---|---|
| Reservation heartbeat | Auto-extends long-running tool reservations via `heartbeatIntervalMs` timer. Closes the "no heartbeat for long-running tools" known limitation. Uses protocol `extendReservation` endpoint when available. | `src/hooks.ts:startHeartbeat/stopHeartbeat` |
| Retryable error handling | `reserveBudget` retries on transient HTTP errors (429/503/504) with exponential backoff. Configurable via `retryableStatusCodes`, `transientRetryMaxAttempts`, `transientRetryBaseDelayMs`. | `src/cycles.ts:reserveBudget` |
| Burn rate anomaly detection | Tracks cost-per-window and fires `onBurnRateAnomaly` callback when burn rate exceeds `burnRateAlertThreshold` (default 3x). Catches runaway tool loops. | `src/hooks.ts:checkBurnRate` |
| Session event log | When `enableEventLog=true`, records every reserve/commit/deny/block/release decision with timestamps. Capped at 10,000 entries. Included in `sessionSummary.eventLog`. | `src/hooks.ts:logEvent` |
| Unconfigured tool report | Session summary includes `unconfiguredTools` array listing tools without explicit `toolBaseCosts` entries, with call counts and estimated total cost. | `src/hooks.ts:agentEnd` |
| Predictive exhaustion warning | Fires `onExhaustionForecast` callback when estimated time-to-exhaustion drops below `exhaustionWarningThresholdMs` (default 120s). | `src/hooks.ts:checkExhaustionForecast` |

### Config additions

| Property | Type | Default | Description |
|---|---|---|---|
| `heartbeatIntervalMs` | number | `30000` | Heartbeat interval for long-running tools |
| `retryableStatusCodes` | number[] | `[429, 503, 504]` | HTTP codes that trigger retry |
| `transientRetryMaxAttempts` | number | `2` | Max retry attempts |
| `transientRetryBaseDelayMs` | number | `500` | Base delay for exponential backoff |
| `burnRateWindowMs` | number | `60000` | Burn rate detection window |
| `burnRateAlertThreshold` | number | `3.0` | Burn rate spike multiplier |
| `onBurnRateAnomaly` | callback | — | Fired on burn rate anomaly |
| `enableEventLog` | boolean | `false` | Enable session event log |
| `exhaustionWarningThresholdMs` | number | `120000` | Exhaustion forecast threshold |
| `onExhaustionForecast` | callback | — | Fired on exhaustion forecast |

### Test coverage

| Metric | v0.5.0 | v0.6.0 |
|---|---|---|
| Test count | 271 | 289 |
| Statement coverage | 99.67% | 99.45% |
| Branch coverage | 98.97% | 97.95% |
| Line coverage | 100% | 100% |

---

## v0.5.0 Changes (2026-03-26)

### New features

| Feature | Description | Location |
|---|---|---|
| Model reserve-then-commit | Model reservations are now held open and committed in the next `beforePromptBuild` or at `agentEnd`, allowing `modelCostEstimator` to reconcile costs. Previously model cost was committed immediately in `beforeModelResolve`. | `src/hooks.ts:269-310` |
| `modelCostEstimator` callback | New config option: `(ctx: { model, estimatedCost, turnIndex }) => number \| undefined`. Called when committing a model reservation. | `src/types.ts:128-132` |
| `MetricsEmitter` interface | New config option with `gauge`/`counter`/`histogram` methods. 12 metrics emitted at key lifecycle points (budget levels, reservations, commits, denials, downgrades, tool blocks, session summary). | `src/types.ts:142-147`, `src/hooks.ts` |
| `StandardMetrics` on commits | `commitUsage()` now accepts optional `metrics` parameter (model_version, tokens, latency). Model commits include `model_version`. | `src/cycles.ts:214-235` |
| Aggressive cache invalidation | `aggressiveCacheInvalidation` config (default: true) proactively refetches budget snapshot after every commit/release. Reduces staleness from 5s to near-zero for single-agent scenarios. | `src/hooks.ts:699-704` |
| OTLP metrics adapter | `createOtlpEmitter(opts)` exports a lightweight OTLP HTTP adapter. Auto-created when `otlpMetricsEndpoint` is set without a custom `metricsEmitter`. | `src/metrics-otlp.ts`, `src/index.ts:109-117` |

### Config additions

| Property | Type | Default | Description |
|---|---|---|---|
| `modelCostEstimator` | callback | — | Reconcile model cost at commit time |
| `metricsEmitter` | callback | — | Observability pipeline integration |
| `aggressiveCacheInvalidation` | boolean | `true` | Proactive snapshot refetch after mutations |
| `otlpMetricsEndpoint` | string | — | OTLP HTTP endpoint for auto metrics export |
| `otlpMetricsHeaders` | object | — | Custom headers for OTLP requests |

### Test coverage

| Metric | v0.4.0 | v0.5.0 |
|---|---|---|
| Test count | 217 | 252 |
| Statement coverage | 100% | 98.68% |
| Branch coverage | 99% | 97.13% |
| Line coverage | 100% | 99.12% |

---

## v0.4.0 Changes (2026-03-26)

### Critical fixes

| Issue | Root Cause | Fix | Location |
|---|---|---|---|
| Install crashes with "must have required property 'tenant'" | `configSchema.required: ["tenant"]` validated during `persistPluginInstall` before user can configure | Removed `tenant` from `required` array; runtime validation in `config.ts` still enforces it | `openclaw.plugin.json:215` |
| Plugin ID mismatch warning on every load | Manifest `id` was `cycles-openclaw-budget-guard` but OpenClaw derives `openclaw-budget-guard` from npm scope strip | Changed manifest `id` to `openclaw-budget-guard` | `openclaw.plugin.json:2` |
| Plugin never reads config — "tenant is required" even when configured | Plugin read `api.config` (full system config) instead of `api.pluginConfig` (plugin-specific config from `plugins.entries.<id>.config`) | Use `api.pluginConfig ?? api.config` with fallback for backwards compatibility | `src/index.ts:36` |
| Install shows noisy error before config is written | `resolveConfig()` throws during install when OpenClaw loads the plugin before config exists | Wrapped in try/catch; logs warning and skips registration gracefully | `src/index.ts:40-48` |

### New features

| Feature | Description | Location |
|---|---|---|
| Startup config summary | Logs resolved config (tenant, base URL, masked API key, key settings) on registration for operator verification | `src/index.ts:55-75` |

### Type changes

| Change | Details | Location |
|---|---|---|
| Added `pluginConfig` to `OpenClawPluginApi` | Optional `Record<string, unknown>` for OpenClaw SDK `api.pluginConfig` | `src/types.ts:189` |

### Code quality fixes (from audit)

| Issue | Fix | Location |
|---|---|---|
| User/session ID resolution inconsistent — `beforeModelResolve` reads `ctx.metadata.userId` but `beforeToolCall` doesn't | Added same resolution logic to `beforeToolCall` | `hooks.ts:386-387` |
| Dead code — `modelReservationCounter` stored and immediately deleted | Removed counter and simplified model reservation to direct commit | `hooks.ts` |
| No overage policy validation — invalid strings pass through to API | Added validation against `REJECT`, `ALLOW_IF_AVAILABLE`, `ALLOW_WITH_OVERDRAFT` for both global and per-tool policies | `config.ts` |
| No threshold validation — negative values or zero `maxRemainingCallsWhenLow` accepted | Added non-negative checks for thresholds and `>= 1` for `maxRemainingCallsWhenLow` | `config.ts` |

### New features (from audit)

| Feature | Description | Location |
|---|---|---|
| Tool call limits (`toolCallLimits`) | Per-tool invocation caps per session (e.g., `{"send_email": 10}`) — blocks tool when limit reached | `hooks.ts`, `config.ts`, `types.ts`, `openclaw.plugin.json` |

### Documentation fixes

- All README and docs config examples now use correct `plugins.entries.<id>.config.{...}` structure
- Plugin ID updated from `cycles-openclaw-budget-guard` to `openclaw-budget-guard` in all config keys and CLI commands
- Default `cyclesBaseUrl` changed to `http://localhost:7878` (no public default)
- Config file name (`openclaw.json` / `openclaw.config.json`) specified in Quick Start
- Troubleshooting section added for "Skipping registration" warning during install

---

## Test Coverage

```
File         | % Stmts | % Branch | % Funcs | % Lines
-------------|---------|----------|---------|--------
All files    |   99.78 |    99.25 |   98.33 |    100
  budget.ts  |     100 |      100 |     100 |    100
  config.ts  |     100 |      100 |     100 |    100
  cycles.ts  |   98.46 |      100 |      90 |    100
  dry-run.ts |     100 |      100 |     100 |    100
  hooks.ts   |     100 |    98.60 |     100 |    100
  index.ts   |     100 |      100 |     100 |    100
  logger.ts  |     100 |       90 |     100 |    100
  types.ts   |     100 |      100 |     100 |    100
```

217 tests across 8 test files. **100% line coverage, 99% branch coverage.**

The 3 remaining uncovered branches are unreachable by design: `ctx.metadata` is always provided by OpenClaw, `reservation.currency` is always set at creation, and `shouldLog("error")` is always true since error is the highest log level.

---

## Part 1: OpenClaw Plugin Contract

### Plugin Registration (all requirements met)

| Requirement | Location | Status |
|---|---|---|
| `openclaw.extensions` in package.json | `package.json:28-29` — `"openclaw": { "extensions": ["./dist/index.js"] }` | PASS |
| `openclaw.plugin.json` manifest with `id`, `extensions`, `configSchema` | `openclaw.plugin.json` — id: `openclaw-budget-guard`, extensions: `["./dist/index.js"]` | PASS |
| Default export: `function(api: OpenClawPluginApi): void` | `src/index.ts:32` | PASS |
| Named exports: error types and config types | `src/index.ts:21-30` — `BudgetExhaustedError`, `ToolBudgetDeniedError`, `BudgetGuardConfig`, `BudgetLevel`, `BudgetSnapshot`, `BudgetTransitionEvent`, `BudgetStatusMetadata`, `CostEstimatorContext`, `SessionSummary` | PASS |

### Hook Registrations (all 5 match)

| Hook Name | Priority | Return Type | Status |
|---|---|---|---|
| `before_model_resolve` | 10 | `ModelResolveResult \| undefined` | PASS |
| `before_prompt_build` | 10 | `PromptBuildResult \| undefined` | PASS |
| `before_tool_call` | 10 | `ToolCallResult \| undefined` | PASS |
| `after_tool_call` | 10 | `void` | PASS |
| `agent_end` | 100 | `void` | PASS |

### Config Schema Alignment (all 60 fields match across 3 sources — v0.4.0 baseline shown below, v0.5.0/v0.6.0 additions documented in respective sections)

**Core fields (original 16):**

| Field | plugin.json | types.ts | config.ts default | Match |
|---|---|---|---|---|
| `enabled` | boolean | `boolean` | `true` | PASS |
| `cyclesBaseUrl` | string | `string` | env fallback | PASS |
| `cyclesApiKey` | string | `string` | env fallback | PASS |
| `tenant` | string | `string` | required | PASS |
| `budgetId` | string | `string?` | `undefined` | PASS |
| `currency` | string | `string` | `USD_MICROCENTS` | PASS |
| `defaultModelActionKind` | string | `string` | `llm.completion` | PASS |
| `defaultToolActionKindPrefix` | string | `string` | `tool.` | PASS |
| `lowBudgetThreshold` | number | `number` | `10_000_000` | PASS |
| `exhaustedThreshold` | number | `number` | `0` | PASS |
| `modelFallbacks` | object | `Record<string, string \| string[]>` | `{}` | PASS |
| `toolBaseCosts` | object | `Record<string, number>` | `{}` | PASS |
| `injectPromptBudgetHint` | boolean | `boolean` | `true` | PASS |
| `maxPromptHintChars` | number | `number` | `200` | PASS |
| `failClosed` | boolean | `boolean` | `true` | PASS |
| `logLevel` | string enum | `string` | `info` | PASS |

**Gap 1 — Model reservation costs:**

| Field | plugin.json | types.ts | config.ts default | Match |
|---|---|---|---|---|
| `modelBaseCosts` | object | `Record<string, number>` | `{}` | PASS |
| `defaultModelCost` | number | `number` | `500_000` | PASS |

**Gap 2 — Custom cost estimation:**

| Field | plugin.json | types.ts | config.ts default | Match |
|---|---|---|---|---|
| `costEstimator` | — (not JSON-serializable) | `(ctx: CostEstimatorContext) => number \| undefined` | `undefined` | PASS |

**Gap 3 — Per-user/session scoping:**

| Field | plugin.json | types.ts | config.ts default | Match |
|---|---|---|---|---|
| `userId` | string | `string?` | `undefined` | PASS |
| `sessionId` | string | `string?` | `undefined` | PASS |

**Gap 5 — Budget transition alerts:**

| Field | plugin.json | types.ts | config.ts default | Match |
|---|---|---|---|---|
| `onBudgetTransition` | — (not JSON-serializable) | `(event: BudgetTransitionEvent) => void` | `undefined` | PASS |
| `budgetTransitionWebhookUrl` | string | `string?` | `undefined` | PASS |

**Gap 7 — Tool allowlist/blocklist:**

| Field | plugin.json | types.ts | config.ts default | Match |
|---|---|---|---|---|
| `toolAllowlist` | string[] | `string[]?` | `undefined` | PASS |
| `toolBlocklist` | string[] | `string[]?` | `undefined` | PASS |

**Gap 8 — Reservation TTL:**

| Field | plugin.json | types.ts | config.ts default | Match |
|---|---|---|---|---|
| `reservationTtlMs` | number | `number` | `60_000` | PASS |
| `toolReservationTtls` | object | `Record<string, number>?` | `undefined` | PASS |

**Gap 10 — Dry-run mode:**

| Field | plugin.json | types.ts | config.ts default | Match |
|---|---|---|---|---|
| `dryRun` | boolean | `boolean` | `false` | PASS |
| `dryRunBudget` | number | `number` | `100_000_000` | PASS |

**Gap 11 — Snapshot caching:**

| Field | plugin.json | types.ts | config.ts default | Match |
|---|---|---|---|---|
| `snapshotCacheTtlMs` | number | `number` | `5_000` | PASS |

**Gap 13 — Low-budget strategies:**

| Field | plugin.json | types.ts | config.ts default | Match |
|---|---|---|---|---|
| `lowBudgetStrategies` | string[] | `string[]` | `["downgrade_model"]` | PASS |
| `maxTokensWhenLow` | number | `number` | `1024` | PASS |
| `expensiveToolThreshold` | number | `number?` | `undefined` | PASS |
| `maxRemainingCallsWhenLow` | number | `number` | `10` | PASS |

**Gap 14 — Multi-currency:**

| Field | plugin.json | types.ts | config.ts default | Match |
|---|---|---|---|---|
| `toolCurrencies` | object | `Record<string, string>?` | `undefined` | PASS |
| `modelCurrency` | string | `string?` | `undefined` | PASS |

**Gap 15 — Session analytics:**

| Field | plugin.json | types.ts | config.ts default | Match |
|---|---|---|---|---|
| `onSessionEnd` | — (not JSON-serializable) | `(summary: SessionSummary) => void \| Promise<void>` | `undefined` | PASS |
| `analyticsWebhookUrl` | string | `string?` | `undefined` | PASS |

**Gap 16 — Overage policies:**

| Field | plugin.json | types.ts | config.ts default | Match |
|---|---|---|---|---|
| `overagePolicy` | string | `string` | `ALLOW_IF_AVAILABLE` | PASS |
| `toolOveragePolicies` | object | `Record<string, string>?` | `undefined` | PASS |

**Gap 17 — Retry on deny:**

| Field | plugin.json | types.ts | config.ts default | Match |
|---|---|---|---|---|
| `retryOnDeny` | boolean | `boolean` | `false` | PASS |
| `retryDelayMs` | number | `number` | `2_000` | PASS |
| `maxRetries` | number | `number` | `1` | PASS |

**Gap 18 — Budget pools:**

| Field | plugin.json | types.ts | config.ts default | Match |
|---|---|---|---|---|
| `parentBudgetId` | string | `string?` | `undefined` | PASS |

---

## Part 2: Cycles API Usage

| Operation | Client Method | Wire-Format Body Keys | Status |
|---|---|---|---|
| Fetch balances | `client.getBalances({ tenant, app? })` | Query params (no body) | PASS |
| Create reservation | `client.createReservation(body)` | `idempotency_key`, `subject`, `action`, `estimate`, `ttl_ms`, `overage_policy` | PASS |
| Commit reservation | `client.commitReservation(id, body)` | `idempotency_key`, `actual` | PASS |
| Release reservation | `client.releaseReservation(id, body)` | `idempotency_key`, `reason` | PASS |

All request bodies use snake_case wire-format keys matching the Cycles Protocol spec.

---

## Part 3: Feature Gap Implementation Audit

| Gap | Feature | Implemented In | Tested | Status |
|-----|---------|---------------|--------|--------|
| 1 | Model call budget reservations | hooks.ts (beforeModelResolve) | hooks.test.ts (7 tests) | PASS |
| 2 | Custom cost estimation callback | hooks.ts (afterToolCall) | hooks.test.ts (3 tests) | PASS |
| 3 | Per-user/session budget scoping | hooks.ts, cycles.ts | hooks.test.ts, cycles.test.ts | PASS |
| 4 | Chained model fallbacks | hooks.ts (beforeModelResolve) | hooks.test.ts (1 test) | PASS |
| 5 | Budget transition detection | hooks.ts (getSnapshot) | hooks.test.ts (3 tests) | PASS |
| 6 | Per-tool cost breakdown tracking | hooks.ts (trackCost) | hooks.test.ts (1 test) | PASS |
| 7 | Tool allowlist/blocklist | budget.ts (isToolPermitted) | budget.test.ts (10 tests), hooks.test.ts (2 tests) | PASS |
| 8 | Configurable reservation TTL | cycles.ts, hooks.ts | cycles.test.ts, hooks.test.ts (3 tests) | PASS |
| 9 | Budget forecast projections | hooks.ts (buildForecast), budget.ts (formatBudgetHint) | budget.test.ts (2 tests), hooks.test.ts (2 tests) | PASS |
| 10 | Dry-run simulation mode | dry-run.ts (DryRunClient) | dry-run.test.ts (8 tests), hooks.test.ts (1 test) | PASS |
| 11 | Configurable snapshot cache TTL | hooks.ts (getSnapshot) | hooks.test.ts (2 tests) | PASS |
| 12 | Budget status in ctx.metadata | hooks.ts (attachBudgetStatus) | hooks.test.ts (1 test) | PASS |
| 13 | Graceful degradation strategies | hooks.ts (beforeToolCall, beforePromptBuild, beforeModelResolve) | hooks.test.ts (6 tests) | PASS |
| 14 | Multi-currency support | cycles.ts, hooks.ts | cycles.test.ts, hooks.test.ts (2 tests) | PASS |
| 15 | Cross-session analytics | hooks.ts (agentEnd) | hooks.test.ts (3 tests) | PASS |
| 16 | Overage policies | cycles.ts, hooks.ts | cycles.test.ts, hooks.test.ts (2 tests) | PASS |
| 17 | Retry on reservation deny | hooks.ts (beforeToolCall) | hooks.test.ts (3 tests) | PASS |
| 18 | Budget pool/hierarchy visibility | cycles.ts, budget.ts | cycles.test.ts, budget.test.ts (1 test) | PASS |

---

## Part 4: Code Review Findings

### Issues Fixed

#### 1. costEstimator callback could crash afterToolCall

**File:** `src/hooks.ts:534-546`
**Severity:** Medium — Exception safety

The `costEstimator` user-provided callback was invoked without a try-catch. If it threw, `afterToolCall` would propagate the error, leaving the reservation uncommitted.

**Fix:** Wrapped in try-catch; on error, logs a warning and falls back to the original estimate. Test added.

#### 2. Model reservation not cleaned up if commitUsage throws

**File:** `src/hooks.ts:319-324`
**Severity:** Medium — Exception safety

If `commitUsage()` threw during immediate model commit, the reservation would remain in the `activeReservations` map and be incorrectly released during `agentEnd()` cleanup.

**Fix:** Wrapped commit in try-finally so `activeReservations.delete()` runs regardless.

#### 3. Logger called with object argument via unsafe type cast

**File:** `src/hooks.ts:101-107, 613`
**Severity:** Low — Type safety

Logger calls used `{ ... } as unknown as string` to pass structured data. This violated the `OpenClawLogger` type contract.

**Fix:** Replaced with template literal strings that embed relevant values directly.

#### 4. Network exceptions bypass fail-open logic in fetchBudgetState

**File:** `src/cycles.ts:57`
**Severity:** High — Error handling

`client.getBalances()` was called without try-catch. HTTP error responses were handled (fail-open), but raw network exceptions (DNS failure, timeout) would propagate up and crash hook handlers regardless of `failClosed` setting.

**Fix:** Wrapped `client.getBalances()` in try-catch; on network error, logs a warning and returns fail-open healthy snapshot. Test added.

#### 5. Network exceptions bypass synthetic DENY in reserveBudget

**File:** `src/cycles.ts:177`
**Severity:** High — Error handling

`client.createReservation()` was called without try-catch. A network-level exception would propagate instead of returning a synthetic DENY response.

**Fix:** Wrapped `client.createReservation()` in try-catch; on error, returns synthetic DENY with `reasonCode: "reservation_network_error"`. Test added.

#### 6. Model reservation key vulnerable to async interleaving

**File:** `src/hooks.ts:306-326`
**Severity:** Medium — Concurrency safety

The model reservation key was constructed with `++modelReservationCounter`, stored, and then re-constructed in a `finally` block using the same counter. Between the `await commitUsage()` and the `finally`, another concurrent `beforeModelResolve` call could increment the counter, causing the wrong key to be deleted.

**Fix:** Captured the key as a `const` before the async operation and reused the same variable in `finally`.

#### 7. DryRunClient hardcoded currency ignores configured currency

**File:** `src/dry-run.ts:31-34`
**Severity:** Low — Config mismatch

DryRunClient hardcoded `"USD_MICROCENTS"` for all balance units. When users configured a different currency (e.g., `"TOKENS"`), `findMatchingBalance` would fall back to the first balance regardless of currency match.

**Fix:** Added `currency` constructor parameter. `initHooks` passes `config.currency`. Test updated.

### Issues Accepted (No Fix Needed)

#### 4. Stale snapshot.level in retry success path

**File:** `src/hooks.ts:474`
**Severity:** Low

In the retry loop, `snapshot.level` from the start of `beforeToolCall` is used after cache invalidation. The budget level could have changed between retries.

**Accepted:** Retry window is short (default 2s). Worst case is one extra conservative decrement of `remainingCallsAllowed`. Not worth the complexity of re-fetching.

#### 5. fireWebhook is fire-and-forget

**File:** `src/hooks.ts:205-213`
**Severity:** Low

Webhooks are non-blocking best-effort. Errors are caught and logged but delivery is not guaranteed.

**Accepted:** Intentional design. Webhooks must not block the hot path. Users needing guaranteed delivery should use the `onBudgetTransition` callback.

#### 6. Unsafe type casts at API boundaries

**File:** `src/cycles.ts:68,178,184` and `src/dry-run.ts:42,71`
**Severity:** Low

Response bodies from runcycles are cast without runtime validation.

**Accepted:** The runcycles SDK validates responses internally. `DryRunClient` is only called by our own typed code.

#### 7. Module-level mutable state

**File:** `src/hooks.ts:48-85`
**Severity:** Low

Plugin uses module-level variables reset in `initHooks()`. Not safely reentrant for concurrent instances.

**Accepted:** OpenClaw guarantees single-instance initialization. Module-level state is the standard plugin pattern. `initHooks()` resets all state completely.

#### 8. Model costs are estimated, not actual

**File:** `src/hooks.ts:283-332`
**Severity:** Informational

Model reservations are committed with estimated cost because OpenClaw has no `after_model_resolve` hook.

**Accepted:** Known limitation. Accurate model cost tracking requires a proxy/gateway layer measuring actual token usage.

---

## Part 5: Fail-Open / Fail-Closed Behavior

| Scenario | Behavior | Location | Status |
|---|---|---|---|
| Cycles server unreachable (balance fetch) | Fail-open: `{ remaining: Infinity, level: "healthy" }` | `cycles.ts:49-54` | PASS |
| No matching balance in response | Fail-open: `{ remaining: Infinity, level: "healthy" }` | `cycles.ts:64-67` | PASS |
| Commit failure in `after_tool_call` | Best-effort: logged, never throws | `cycles.ts:159-172` | PASS |
| Budget confirmed exhausted + `failClosed=true` | Fail-closed: throws `BudgetExhaustedError` | `hooks.ts:271-277` | PASS |

---

## Part 6: Runcycles Client Spec Consistency Review

Verified all plugin API usage against the installed `runcycles` ^0.1.1 TypeScript client (`node_modules/runcycles/dist/index.d.ts`). Three spec inconsistencies were found and corrected:

### Issue 1: Subject field misuse — user/session as top-level fields (FIXED)

**File:** `src/cycles.ts` (reserveBudget)
**Severity:** High — Would cause validation failures

The `Subject` interface only supports: `tenant`, `workspace`, `app`, `workflow`, `agent`, `toolset`, `dimensions`. User and session identifiers were incorrectly passed as top-level subject fields.

**Fix:** Moved `userId` and `sessionId` into `subject.dimensions`:
```typescript
const dimensions: Record<string, string> = {};
if (userId) dimensions.user = userId;
if (sessionId) dimensions.session = sessionId;
// ...
subject: {
  tenant: config.tenant,
  ...(config.budgetId ? { app: config.budgetId } : {}),
  ...(Object.keys(dimensions).length > 0 ? { dimensions } : {}),
},
```

### Issue 2: Invalid balance query parameters (FIXED)

**File:** `src/cycles.ts` (fetchBudgetState)
**Severity:** Medium — Parameters would be silently ignored

`getBalances()` only accepts `BALANCE_FILTER_PARAMS`: `tenant`, `workspace`, `app`, `workflow`, `agent`, `toolset`. Passing `user` or `session` as query params had no effect.

**Fix:** Removed `user`/`session` from balance query params. User/session scoping is applied at reservation time only, via `dimensions`.

### Issue 3: Overage policy enum confusion (FIXED)

**Files:** `openclaw.plugin.json`, `README.md`, test files
**Severity:** Medium — Documentation/test correctness

Overage policy values used `ALLOW` and `ALLOW_WITH_CAPS` (which are `Decision` enum values). The correct `CommitOveragePolicy` enum values are:
- `ALLOW_IF_AVAILABLE` (default)
- `ALLOW_IF_AVAILABLE`
- `ALLOW_WITH_OVERDRAFT`

**Fix:** Updated all references across plugin.json, README.md, and test files.

### Verification Summary

| API Surface | Status |
|---|---|
| `CyclesConfig` constructor (baseUrl, apiKey, tenant) | CORRECT |
| `CyclesClient.getBalances(params)` — filter params | CORRECT (after fix) |
| `CyclesClient.createReservation(body)` — wire format | CORRECT (after fix) |
| `CyclesClient.commitReservation(id, body)` — wire format | CORRECT |
| `CyclesClient.releaseReservation(id, body)` — wire format | CORRECT |
| `Subject` interface — standard fields + dimensions | CORRECT (after fix) |
| `Balance` interface — field access | CORRECT |
| `ReservationCreateResponse` — decision/reservationId | CORRECT |
| `CommitOveragePolicy` enum — REJECT/ALLOW_IF_AVAILABLE/ALLOW_WITH_OVERDRAFT | CORRECT (after fix) |
| `Decision` enum — ALLOW/ALLOW_WITH_CAPS/DENY | CORRECT |
| `isAllowed()` helper usage | CORRECT |
| Wire format mappers (balanceResponseFromWire, reservationCreateResponseFromWire) | CORRECT |

---

## Part 7: Recommendations

1. **Runtime validation for Cycles API responses** — Consider zod or lightweight validator for `fetchBudgetState` to catch API contract changes early.
2. **Model cost callback** — If OpenClaw adds `after_model_resolve`, add `modelCostEstimator` similar to `costEstimator`.
3. **Structured logging** — Extend `OpenClawLogger` to accept metadata objects natively.
4. **Webhook retry** — Optional retry for critical webhooks (budget transitions), gated behind a config flag.

---

## Verdict

The plugin is **production-ready and contract-conformant** with OpenClaw plugin requirements. All 45 config properties, 5 hook registrations, 4 Cycles API operations, and 18 feature gap implementations are internally consistent, correctly tested (200 tests, 100% line coverage, 99% branch coverage), and reviewed for correctness. Nine code issues were identified and fixed (including 3 runcycles spec inconsistencies, 2 network error handling gaps, and 1 concurrency safety fix); five were reviewed and accepted as reasonable design choices.
