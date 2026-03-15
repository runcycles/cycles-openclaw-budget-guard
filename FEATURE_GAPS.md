# Feature Gaps — cycles-openclaw-budget-guard

Analysis of 18 feature gaps identified in the v0.1.0 plugin. All gaps have been implemented in v0.2.0.

---

## Status: All Implemented

| # | Gap | Severity | Effort | Status | Implemented In |
|---|-----|----------|--------|--------|----------------|
| 1 | No LLM call reservations | **High** | Medium | **Done** | `hooks.ts` (beforeModelResolve) |
| 2 | Estimate ≠ actual cost | **High** | Medium | **Done** | `hooks.ts` (afterToolCall + costEstimator) |
| 3 | No per-user/session scoping | **High** | Low | **Done** | `hooks.ts`, `cycles.ts` |
| 4 | No chained model fallbacks | Medium | Low | **Done** | `hooks.ts` (beforeModelResolve) |
| 5 | No budget transition alerts | Medium | Low | **Done** | `hooks.ts` (getSnapshot) |
| 6 | No per-tool cost breakdown | Medium | Low | **Done** | `hooks.ts` (trackCost) |
| 7 | No tool allowlist/blocklist | Medium | Low | **Done** | `budget.ts` (isToolPermitted) |
| 8 | No configurable reservation TTL | Low | Low | **Done** | `config.ts`, `hooks.ts`, `cycles.ts` |
| 9 | No budget forecast/projection | Medium | Medium | **Done** | `hooks.ts` (buildForecast), `budget.ts` |
| 10 | No dry-run mode | Medium | Medium | **Done** | `dry-run.ts` (DryRunClient) |
| 11 | No configurable cache TTL | Low | Low | **Done** | `config.ts`, `hooks.ts` |
| 12 | No end-user budget visibility | Medium | Low | **Done** | `hooks.ts` (attachBudgetStatus) |
| 13 | No graceful degradation strategies | Medium | High | **Done** | `hooks.ts` (4 strategies) |
| 14 | No multi-currency support | Low | High | **Done** | `config.ts`, `cycles.ts`, `hooks.ts` |
| 15 | No cross-session analytics | Low | Medium | **Done** | `hooks.ts` (agentEnd) |
| 16 | No overage policy config | Low | Low | **Done** | `config.ts`, `cycles.ts`, `hooks.ts` |
| 17 | No retry on denied tool calls | Low | Low | **Done** | `hooks.ts` (beforeToolCall retry loop) |
| 18 | No budget pool support | Low | Medium | **Done** | `cycles.ts`, `budget.ts` |

---

## Gap Details

### 1. No Budget Reservation for LLM Calls — IMPLEMENTED

**Problem:** `before_model_resolve` checked budget level but never created a Cycles reservation for the LLM call. Only tool calls went through reserve → commit → release.

**Solution:** Added `reserveBudget()` call in `beforeModelResolve` using `defaultModelActionKind`. Introduced `modelBaseCosts` config map and `defaultModelCost` fallback. Model reservations are committed immediately since OpenClaw has no `after_model_resolve` hook.

**Config fields added:** `modelBaseCosts`, `defaultModelCost`

---

### 2. Actual Cost Tracking (Estimate ≠ Actual) — IMPLEMENTED

**Problem:** `afterToolCall` always committed `reservation.estimate` as actual cost, ignoring `durationMs` and any real cost data.

**Solution:** Added `costEstimator` callback config. When provided, it receives `{ toolName, estimate, durationMs, result }` and returns actual cost or `undefined` to use the estimate. Wrapped in try-catch for safety.

**Config fields added:** `costEstimator`

---

### 3. Per-User/Session Budget Scoping — IMPLEMENTED

**Problem:** Cycles subject only included `tenant` and `app`. All users shared a single budget pool.

**Solution:** Added `userId` and `sessionId` config fields. These are also readable from `ctx.metadata.userId` / `ctx.metadata.sessionId` (ctx overrides config). Threaded into Cycles balance queries and reservation subjects.

**Config fields added:** `userId`, `sessionId`

---

### 4. Chained Model Fallbacks — IMPLEMENTED

**Problem:** `modelFallbacks` was `Record<string, string>` — one fallback per model.

**Solution:** Changed to `Record<string, string | string[]>`. When the value is an array, iterates through candidates and selects the first one whose cost (from `modelBaseCosts`) fits within remaining budget.

**Config fields changed:** `modelFallbacks` type updated

---

### 5. Budget Transition Alerts — IMPLEMENTED

**Problem:** Budget level transitions were logged but not emitted as events.

**Solution:** Added transition detection in `getSnapshot()`. When level changes from the previous snapshot, fires `onBudgetTransition` callback and POSTs to `budgetTransitionWebhookUrl` if configured. Includes previous/current level, remaining, and timestamp.

**Config fields added:** `onBudgetTransition`, `budgetTransitionWebhookUrl`

---

### 6. Per-Tool Cost Breakdown — IMPLEMENTED

**Problem:** Session summary only included aggregates, no per-component breakdown.

**Solution:** Added `costBreakdown` Map tracking `{ count, totalCost }` per tool and model. Included in session summary at `agent_end` and attached to `ctx.metadata["cycles-budget-guard"]`.

**No new config fields** — automatic tracking.

---

### 7. Tool Allowlist/Blocklist — IMPLEMENTED

**Problem:** All tools were permitted regardless of policy; no way to block specific tools.

**Solution:** Added `toolAllowlist` and `toolBlocklist` config fields with glob matching (`*` prefix/suffix wildcards). `isToolPermitted()` checks these before attempting a reservation. Blocklist takes precedence over allowlist.

**Config fields added:** `toolAllowlist`, `toolBlocklist`

---

### 8. Configurable Reservation TTL — IMPLEMENTED

**Problem:** Reservation TTL was hard-coded to 60,000 ms.

**Solution:** Added `reservationTtlMs` config (default 60,000) and `toolReservationTtls` for per-tool overrides. Passed through to Cycles reservation requests.

**Config fields added:** `reservationTtlMs`, `toolReservationTtls`

---

### 9. Budget Forecast/Projection — IMPLEMENTED

**Problem:** Prompt hints showed remaining budget but no projection of remaining capacity.

**Solution:** Track running averages of tool and model call costs. `buildForecast()` computes `avgToolCost`, `avgModelCost`, and estimated remaining calls. Appended to `formatBudgetHint()` output (e.g., "~10 tool calls and ~5 model calls remaining at current rate"). Included in session summary.

**No new config fields** — automatic tracking.

---

### 10. Dry-Run / Simulation Mode — IMPLEMENTED

**Problem:** Plugin required a live Cycles server or was completely disabled.

**Solution:** Added `DryRunClient` class (`dry-run.ts`) that simulates budget tracking in memory. When `dryRun: true`, replaces the real `CyclesClient`. Supports reserve → commit → release lifecycle, ALLOW/DENY decisions, and balance queries.

**Config fields added:** `dryRun`, `dryRunBudget`

---

### 11. Configurable Snapshot Cache TTL — IMPLEMENTED

**Problem:** Cache TTL was hard-coded to 5,000 ms.

**Solution:** Added `snapshotCacheTtlMs` config (default 5,000). Used in `getSnapshot()` freshness check.

**Config fields added:** `snapshotCacheTtlMs`

---

### 12. End-User Budget Visibility — IMPLEMENTED

**Problem:** Budget status was only injected into the AI's system prompt, not visible to end users.

**Solution:** Added `attachBudgetStatus()` that writes budget level, remaining, allocated, and percentage to `ctx.metadata["cycles-budget-guard-status"]`. OpenClaw frontends can read this for UI display.

**No new config fields** — automatic metadata attachment.

---

### 13. Graceful Degradation Strategies — IMPLEMENTED

**Problem:** Only model downgrade was available when budget was low.

**Solution:** Added `lowBudgetStrategies` config accepting a list of composable strategies:
- `downgrade_model` — Use fallback models (existing behavior)
- `reduce_max_tokens` — Append token limit guidance to prompts
- `disable_expensive_tools` — Block tools exceeding `expensiveToolThreshold`
- `limit_remaining_calls` — Cap total calls via `maxRemainingCallsWhenLow`

Applied across `beforeModelResolve`, `beforePromptBuild`, and `beforeToolCall`.

**Config fields added:** `lowBudgetStrategies`, `maxTokensWhenLow`, `expensiveToolThreshold`, `maxRemainingCallsWhenLow`

---

### 14. Multi-Currency Support — IMPLEMENTED

**Problem:** Single `currency` for all reservations.

**Solution:** Added per-tool currency overrides via `toolCurrencies` and per-model override via `modelCurrency`. Each reservation uses the appropriate currency. Cost tracking respects the currency unit.

**Config fields added:** `toolCurrencies`, `modelCurrency`

---

### 15. Cross-Session Analytics — IMPLEMENTED

**Problem:** Session summaries were ephemeral — lost when the session ends.

**Solution:** Added `onSessionEnd` callback that receives the full `SessionSummary` (tenant, userId, remaining, spent, costBreakdown, timing, forecasts). Added `analyticsWebhookUrl` for HTTP POST delivery. Both fire at `agent_end`.

**Config fields added:** `onSessionEnd`, `analyticsWebhookUrl`

---

### 16. Overage Policy Configuration — IMPLEMENTED

**Problem:** Overage policy was hard-coded to `"REJECT"`.

**Solution:** Added `overagePolicy` config (default `"REJECT"`) and `toolOveragePolicies` for per-tool overrides. Passed through to Cycles reservation requests.

**Config fields added:** `overagePolicy`, `toolOveragePolicies`

---

### 17. Retry on Denied Tool Calls — IMPLEMENTED

**Problem:** Denied tool reservations were immediately blocked with no retry option.

**Solution:** Added `retryOnDeny`, `retryDelayMs`, and `maxRetries` config. When enabled and a reservation is denied, waits and retries up to `maxRetries` times before blocking.

**Config fields added:** `retryOnDeny`, `retryDelayMs`, `maxRetries`

---

### 18. Budget Pool/Hierarchy Support — IMPLEMENTED

**Problem:** No concept of shared budget pools or hierarchical quotas.

**Solution:** Added `parentBudgetId` config. When set, `fetchBudgetState` extracts the pool balance from the Cycles response and includes it in the `BudgetSnapshot`. `formatBudgetHint` appends pool remaining to the prompt hint (e.g., "Team pool: 50000000 remaining.").

**Config fields added:** `parentBudgetId`

---

## Test Coverage

All 18 gaps are covered by 183 tests with 100% line coverage. See `AUDIT.md` for detailed coverage breakdown and code review findings.
