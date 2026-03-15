# Feature Gaps — cycles-openclaw-budget-guard

Analysis of missing capabilities that OpenClaw users would benefit from.
Each gap includes a description, the user impact, and suggested implementation approach.

---

## 1. No Budget Reservation for LLM Calls

**Current behavior:** `before_model_resolve` checks the budget level and can downgrade or block models, but it never creates a Cycles reservation for the LLM call itself. Only tool calls go through the reserve → commit → release cycle. The `defaultModelActionKind` config field (`llm.completion`) exists but is completely unused in phase 1.

**User impact:** LLM inference is typically the largest cost in an agent session, yet it is unmetered. Users cannot enforce hard budget caps on model usage — a single expensive completion could blow past the budget between snapshot cache refreshes.

**Suggested approach:** Add a `reserveBudget()` call in `beforeModelResolve` using `defaultModelActionKind`. Introduce a `modelBaseCosts` config map (similar to `toolBaseCosts`) mapping model names to estimated per-call costs. Commit actual usage in a new `after_model_resolve` or `after_completion` hook if OpenClaw exposes one, or commit the estimate immediately.

---

## 2. Actual Cost Tracking (Estimate ≠ Actual)

**Current behavior:** `afterToolCall` commits `reservation.estimate` as the actual cost. The `ToolResultEvent` provides a `durationMs` field that is ignored. There is no mechanism to compute or receive actual token/cost data.

**User impact:** Budget accounting is always approximate. Users who run many tool calls accumulate drift between estimated and real costs, leading to either premature budget exhaustion or overspend.

**Suggested approach:** If OpenClaw surfaces token counts or provider billing data on the `ToolResultEvent` or a post-completion event, use those to compute actual cost. Add a `costEstimator` callback config that users can supply to map `(toolName, result, durationMs) → actualCost`. Fall back to the estimate when no better data is available.

---

## 3. No Per-User or Per-Session Budget Scoping

**Current behavior:** The Cycles `subject` only includes `tenant` and optionally `app` (from `budgetId`). All users and sessions within a tenant share a single budget pool.

**User impact:** In multi-user environments (teams, shared OpenClaw deployments), one user can exhaust the entire tenant budget. There is no way to give individual users or sessions their own budget allocation.

**Suggested approach:** Add optional `userId` and `sessionId` config fields (or read them from `ctx.metadata`). Thread these into the Cycles subject so reservations are scoped per-user or per-session. The Cycles server already supports hierarchical subjects — this is a config/wiring gap, not a server limitation.

---

## 4. No Chained Model Fallbacks

**Current behavior:** `modelFallbacks` is a flat `Record<string, string>` — one fallback per model. If the fallback model is also too expensive for the remaining budget, there is no further downgrade.

**User impact:** Users with three-tier model strategies (e.g., opus → sonnet → haiku) cannot express the full chain. The agent either uses the single fallback or gets blocked entirely.

**Suggested approach:** Change `modelFallbacks` to accept `Record<string, string | string[]>`. When the value is an array, iterate through candidates and select the first one whose estimated cost fits within the remaining budget. Requires `modelBaseCosts` (gap #1) to evaluate affordability.

---

## 5. No Budget Alerts or Transition Notifications

**Current behavior:** Budget level transitions (healthy → low → exhausted) are logged but not emitted as events. No webhook, callback, or OpenClaw event is fired.

**User impact:** External systems (dashboards, Slack bots, billing pipelines) cannot react to budget state changes in real time. Users only discover exhaustion after it happens.

**Suggested approach:** Add an optional `onBudgetTransition` callback or emit an OpenClaw event (e.g., `budget_level_changed`) when the classified level changes from the previous snapshot. Include previous level, new level, remaining amount, and timestamp. Optionally support a `webhookUrl` config for HTTP POST notifications.

---

## 6. No Per-Tool or Per-Model Cost Breakdown in Session Summary

**Current behavior:** The `agent_end` summary includes aggregate totals (`remaining`, `spent`, `totalReservationsMade`) but no breakdown by tool or model.

**User impact:** Users cannot identify which tools or models consumed the most budget within a session. Cost optimization requires visibility into per-component spend.

**Suggested approach:** Track a `Map<string, { count: number; totalCost: number }>` for tools (and models, once gap #1 is addressed). Include the breakdown in the session summary attached to `ctx.metadata["cycles-budget-guard"]`.

---

## 7. No Tool Allowlist / Blocklist

**Current behavior:** All tools are permitted (subject to budget). There is no way to block specific tools regardless of budget availability, or to restrict which tools are allowed.

**User impact:** Users who want to prevent expensive or risky tools (e.g., `code_execution`, external API calls) from running — even when budget is available — have no mechanism within this plugin.

**Suggested approach:** Add `toolAllowlist` and `toolBlocklist` config fields (arrays of tool name patterns, supporting wildcards). In `beforeToolCall`, check these lists before attempting a reservation. Blocked tools return `{ block: true, blockReason }` immediately.

---

## 8. No Configurable Reservation TTL

**Current behavior:** Reservation TTL is hard-coded to 60,000 ms (60 seconds) in `cycles.ts:131`.

**User impact:** Some tool calls (large code executions, long-running API calls) may exceed 60 seconds, causing the reservation to expire before `afterToolCall` can commit it. Conversely, short tool calls hold reservations longer than necessary.

**Suggested approach:** Add a `reservationTtlMs` config field (default 60,000). Optionally support per-tool TTL overrides via a `toolReservationTtls: Record<string, number>` config.

---

## 9. No Budget Forecast / Projection

**Current behavior:** The prompt hint shows remaining budget and percentage, but no projection of how many more operations the agent can afford.

**User impact:** Neither the AI model nor the end user can make informed decisions about remaining capacity. "5,000,000 microcents remaining" is not actionable without knowing the average cost per operation.

**Suggested approach:** Track a running average cost per tool call and per model call. In `formatBudgetHint`, append an estimate like "~10 more tool calls at current rate." Expose the projection in the session summary.

---

## 10. No Dry-Run / Simulation Mode

**Current behavior:** The plugin either talks to a live Cycles server or is completely disabled. There is no middle ground.

**User impact:** Users cannot test budget guard behavior during development without a running Cycles server. Integration testing requires real infrastructure.

**Suggested approach:** Add a `dryRun: boolean` config. In dry-run mode, skip all Cycles API calls but still run classification logic, log decisions, and return the same hook results. Use a configurable `dryRunBudget: number` as the simulated remaining balance that decrements locally with each reservation.

---

## 11. No Configurable Snapshot Cache TTL

**Current behavior:** The budget snapshot cache TTL is hard-coded to 5,000 ms in `hooks.ts:55`.

**User impact:** Users in high-throughput scenarios may want a shorter TTL for more accurate budget state. Users with low-frequency agents may prefer a longer TTL to reduce API calls to the Cycles server.

**Suggested approach:** Add a `snapshotCacheTtlMs: number` config field (default 5,000). Use it in `getSnapshot()` instead of the constant.

---

## 12. No End-User Budget Visibility

**Current behavior:** Budget hints are injected into the AI model's system prompt via `before_prompt_build`. The end user (human operating the agent) receives no direct notification about budget status.

**User impact:** End users are unaware of budget constraints until the agent is blocked or starts behaving differently (model downgrade). There is no proactive warning surface for the human.

**Suggested approach:** If OpenClaw supports user-facing messages or status events, emit budget warnings through that channel. Alternatively, add a `ctx.metadata["cycles-budget-guard-user-hint"]` field that OpenClaw frontends can render. At minimum, expose budget level via the existing metadata attachment so UIs can read it.

---

## 13. No Graceful Degradation Beyond Model Downgrade

**Current behavior:** When budget is low, the only intervention is model downgrade (via `modelFallbacks`). When exhausted, the only options are block or warn-and-continue.

**User impact:** Users may want intermediate strategies: reduce max output tokens, disable certain tool categories, switch to cached/local tools, or limit the number of remaining tool calls rather than blocking entirely.

**Suggested approach:** Add a `lowBudgetStrategy` config that accepts a list of actions: `["downgrade_model", "reduce_max_tokens", "disable_expensive_tools", "limit_remaining_calls"]`. Implement each strategy as a composable behavior in `beforeModelResolve` and `beforeToolCall`.

---

## 14. No Multi-Currency Support

**Current behavior:** A single `currency` string is used for all reservations and balance lookups. Only one currency unit is supported per plugin instance.

**User impact:** Organizations using multiple budget units (e.g., USD for external APIs, tokens for internal models) cannot track both within a single plugin configuration.

**Suggested approach:** Support a `currencies` array or per-tool/per-model currency overrides. When reserving, use the appropriate currency for the action kind. Aggregate the session summary per currency.

---

## 15. No Cross-Session Budget Analytics

**Current behavior:** Each agent session is independent. The session summary is attached to `ctx.metadata` but is ephemeral — it is lost when the session ends unless the caller persists it.

**User impact:** Users cannot track budget trends across sessions, identify cost spikes, or generate reports without building their own persistence layer.

**Suggested approach:** Add an optional `analyticsWebhookUrl` or `onSessionEnd` callback that POSTs the session summary to an external endpoint. Alternatively, if Cycles supports querying historical usage, add a utility function that retrieves cross-session spend data.

---

## 16. No Overage Policy Configuration

**Current behavior:** Reservation `overage_policy` is hard-coded to `"REJECT"` in `cycles.ts:132`.

**User impact:** Some users may want `"ALLOW"` (soft limit) or `"ALLOW_WITH_CAPS"` behavior for certain tools or in certain budget levels. There is no way to configure this.

**Suggested approach:** Add an `overagePolicy` config field (default `"REJECT"`). Optionally support per-tool overrides via `toolOveragePolicies: Record<string, string>`.

---

## 17. No Retry or Queue for Denied Tool Calls

**Current behavior:** When a tool reservation is denied, the tool call is immediately blocked with no option for retry or deferral.

**User impact:** In scenarios where budget is being replenished (e.g., rate-based allocations), a brief wait might allow the tool call to succeed. Currently, the agent must completely give up on the tool.

**Suggested approach:** Add optional `retryOnDeny: boolean` and `retryDelayMs: number` config fields. When a reservation is denied and retry is enabled, wait and retry once before returning `{ block: true }`.

---

## 18. No Support for Budget Pools or Shared Quotas

**Current behavior:** Budget scoping uses a single `tenant` + optional `budgetId`. There is no concept of shared pools, team budgets, or hierarchical quota inheritance.

**User impact:** Teams that want to share a budget pool while maintaining individual sub-limits cannot express this through the plugin config alone (even though Cycles may support it server-side).

**Suggested approach:** Support a `budgetPool` or `parentBudgetId` config that maps to Cycles' hierarchical subject model. Surface pool-level remaining balance alongside individual balance in the prompt hint and session summary.

---

## Summary Table

| # | Gap | Severity | Effort |
|---|-----|----------|--------|
| 1 | No LLM call reservations | **High** | Medium |
| 2 | Estimate ≠ actual cost | **High** | Medium |
| 3 | No per-user/session scoping | **High** | Low |
| 4 | No chained model fallbacks | Medium | Low |
| 5 | No budget transition alerts | Medium | Low |
| 6 | No per-tool cost breakdown | Medium | Low |
| 7 | No tool allowlist/blocklist | Medium | Low |
| 8 | No configurable reservation TTL | Low | Low |
| 9 | No budget forecast/projection | Medium | Medium |
| 10 | No dry-run mode | Medium | Medium |
| 11 | No configurable cache TTL | Low | Low |
| 12 | No end-user budget visibility | Medium | Low |
| 13 | No graceful degradation strategies | Medium | High |
| 14 | No multi-currency support | Low | High |
| 15 | No cross-session analytics | Low | Medium |
| 16 | No overage policy config | Low | Low |
| 17 | No retry on denied tool calls | Low | Low |
| 18 | No budget pool support | Low | Medium |

**Recommended priority order:** Gaps 1, 2, 3 (high-severity, direct budget accuracy impact) → 4, 5, 6, 7 (medium-severity, quick wins) → 9, 10, 12 (medium-severity, moderate effort) → remainder.
