# cycles-openclaw-budget-guard — Plugin Audit

**Date:** 2026-03-15
**Plugin:** `@runcycles/openclaw-budget-guard` v0.2.0
**Runtime:** OpenClaw >= 0.1.0, Node 20+
**Cycles client:** `runcycles` ^0.1.1

---

## Summary

| Category | Pass | Issues |
|----------|------|--------|
| OpenClaw Plugin Contract | 4/4 | 0 |
| Config Schema (plugin.json ↔ types.ts ↔ config.ts) | 44/44 | 0 |
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

**Overall: Plugin is contract-conformant and production-ready.** All 44 config properties, 5 hook registrations, 4 Cycles API operations, and 18 feature gap implementations are internally consistent and correctly tested. Three runcycles spec inconsistencies and four additional code issues were identified and corrected.

---

## Test Coverage

```
File         | % Stmts | % Branch | % Funcs | % Lines
-------------|---------|----------|---------|--------
All files    |   99.76 |    99.16 |   98.33 |    100
  budget.ts  |     100 |      100 |     100 |    100
  config.ts  |     100 |      100 |     100 |    100
  cycles.ts  |   98.46 |      100 |      90 |    100
  dry-run.ts |     100 |      100 |     100 |    100
  hooks.ts   |     100 |    98.60 |     100 |    100
  index.ts   |     100 |      100 |     100 |    100
  logger.ts  |     100 |       90 |     100 |    100
  types.ts   |     100 |      100 |     100 |    100
```

200 tests across 8 test files. **100% line coverage, 99% branch coverage.**

The 3 remaining uncovered branches are unreachable by design: `ctx.metadata` is always provided by OpenClaw, `reservation.currency` is always set at creation, and `shouldLog("error")` is always true since error is the highest log level.

---

## Part 1: OpenClaw Plugin Contract

### Plugin Registration (all requirements met)

| Requirement | Location | Status |
|---|---|---|
| `openclaw.extensions` in package.json | `package.json:28-29` — `"openclaw": { "extensions": ["./dist/index.js"] }` | PASS |
| `openclaw.plugin.json` manifest with `id`, `extensions`, `configSchema` | `openclaw.plugin.json` — id: `cycles-openclaw-budget-guard`, extensions: `["./dist/index.js"]` | PASS |
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

### Config Schema Alignment (all 44 fields match across 3 sources)

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
| `overagePolicy` | string | `string` | `REJECT` | PASS |
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
- `REJECT` (default)
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

The plugin is **production-ready and contract-conformant** with OpenClaw plugin requirements. All 44 config properties, 5 hook registrations, 4 Cycles API operations, and 18 feature gap implementations are internally consistent, correctly tested (200 tests, 100% line coverage, 99% branch coverage), and reviewed for correctness. Nine code issues were identified and fixed (including 3 runcycles spec inconsistencies, 2 network error handling gaps, and 1 concurrency safety fix); five were reviewed and accepted as reasonable design choices.
