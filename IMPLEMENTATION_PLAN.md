# Implementation Plan — Address All 18 Feature Gaps

This plan is organized into **5 phases**, ordered by dependency chain and severity.
Each phase lists the gaps addressed, the exact file changes, new config fields,
new/modified types, hook changes, and required tests.

---

## Phase 1 — Core Budget Accuracy (Gaps 1, 2, 3, 8, 11, 16)

These gaps directly affect budget correctness and must land first because later
phases (chained fallbacks, forecasting, degradation strategies) depend on
accurate per-call cost tracking and proper subject scoping.

### Gap 1: LLM Call Reservations

**Goal:** Reserve budget before every model call, not just tool calls.

**Config changes (`types.ts` → `BudgetGuardConfig`):**
- Add `modelBaseCosts: Record<string, number>` — maps model name → estimated
  cost per completion in the configured currency. Default `{}`.
- Add `defaultModelCost: number` — fallback cost when a model is not in
  `modelBaseCosts`. Default `500_000` (0.005 USD in microcents).

**Config resolution (`config.ts`):**
- Parse `modelBaseCosts` with `asNumberRecord()`, default `{}`.
- Parse `defaultModelCost` with `asNumber()`, default `500_000`.

**Plugin manifest (`openclaw.plugin.json`):**
- Add `modelBaseCosts` (object, additionalProperties number) and
  `defaultModelCost` (number) to `configSchema.properties`.

**Types (`types.ts`):**
- Extend `ActiveReservation` with an optional `kind: "model" | "tool"` field
  so `agentEnd` cleanup can distinguish reservation types.
- Add `ModelResolveResult.reservationId?: string` if OpenClaw supports
  round-tripping opaque data. If not, store model reservations in
  `activeReservations` keyed by a synthetic ID (e.g., `model:<uuid>`).

**Cycles changes (`cycles.ts`):**
- `reserveBudget` already accepts arbitrary `actionKind`/`actionName` — no
  changes needed. Callers will pass `config.defaultModelActionKind` and the
  model name.

**Hook changes (`hooks.ts`):**
- **`beforeModelResolve`:** After determining the final model (original or
  fallback), call `reserveBudget()` with:
  - `actionKind`: `config.defaultModelActionKind` (`llm.completion`)
  - `actionName`: resolved model name
  - `estimate`: `config.modelBaseCosts[model] ?? config.defaultModelCost`
  - Store the reservation in `activeReservations` with a synthetic key
    `model:<uuid>` and `kind: "model"`.
  - If reservation is DENIED and `failClosed`, throw `BudgetExhaustedError`.
  - If reservation is DENIED and `!failClosed`, log warning and continue.
  - Increment `totalReservationsMade`.
  - Invalidate snapshot cache.

- **New: `afterModelResolve` or equivalent settlement.** If OpenClaw provides
  an `after_model_resolve` or `after_completion` hook, register it to commit
  actual usage. If not available, commit the estimate immediately after
  reservation (same as phase-1 tool behavior — estimate = actual). Track this
  decision with a code comment noting it can be improved when OpenClaw adds
  post-completion hooks with token counts.

- **`agentEnd`:** Already releases orphaned reservations — model reservations
  stored with `model:*` keys will be cleaned up automatically.

**New module-level state (`hooks.ts`):**
- Add `modelReservationsByCtx: Map<string, ActiveReservation>` or reuse
  `activeReservations` with the `model:<uuid>` key convention. Reusing is
  simpler; prefer it.

**Index (`index.ts`):**
- If a new `after_completion` hook is registered, add the `api.on()` call.

**Tests (`tests/hooks.test.ts`):**
- Test model reservation created on healthy/low budget.
- Test model reservation denied → `BudgetExhaustedError` when `failClosed`.
- Test model reservation denied → warn-and-continue when `!failClosed`.
- Test `modelBaseCosts` lookup and `defaultModelCost` fallback.
- Test model reservations appear in `agentEnd` orphan cleanup.
- Test `totalReservationsMade` incremented for model calls.

**Tests (`tests/config.test.ts`):**
- Test `modelBaseCosts` defaults to `{}`.
- Test `defaultModelCost` defaults to `500_000`.

---

### Gap 2: Actual Cost Tracking

**Goal:** Use real cost data when available instead of always committing the estimate.

**Config changes (`types.ts` → `BudgetGuardConfig`):**
- Add `costEstimator?: (context: CostEstimatorContext) => number | undefined`.
  This is a callback, not JSON-serializable, so it must be set programmatically
  (not via `openclaw.plugin.json`). Document this in README.

**New type (`types.ts`):**
```typescript
export interface CostEstimatorContext {
  toolName: string;
  estimate: number;
  durationMs?: number;
  result?: unknown;
}
```

**Hook changes (`hooks.ts` → `afterToolCall`):**
- After looking up the active reservation, compute actual cost:
  ```typescript
  let actual = reservation.estimate;
  if (config.costEstimator) {
    const computed = config.costEstimator({
      toolName: reservation.toolName,
      estimate: reservation.estimate,
      durationMs: event.durationMs,
      result: event.result,
    });
    if (computed !== undefined) actual = computed;
  }
  ```
- Pass `actual` to `commitUsage()` instead of `reservation.estimate`.

**Config resolution (`config.ts`):**
- Accept `raw.costEstimator` if it is a function, otherwise `undefined`.
  Add helper: `asFunction(v: unknown): Function | undefined`.

**Tests (`tests/hooks.test.ts`):**
- Test `afterToolCall` uses `costEstimator` return value when provided.
- Test `afterToolCall` falls back to estimate when `costEstimator` returns
  `undefined`.
- Test `afterToolCall` falls back to estimate when `costEstimator` is not set.

---

### Gap 3: Per-User / Per-Session Budget Scoping

**Goal:** Thread user and session identifiers into Cycles subjects.

**Config changes (`types.ts` → `BudgetGuardConfig`):**
- Add `userId?: string` — optional, can also be read from `ctx.metadata.userId`.
- Add `sessionId?: string` — optional, can also be read from `ctx.metadata.sessionId`.

**Config resolution (`config.ts`):**
- Parse both with `asString()`, default `undefined`.

**Plugin manifest (`openclaw.plugin.json`):**
- Add `userId` (string) and `sessionId` (string) to `configSchema.properties`.

**Cycles changes (`cycles.ts`):**
- Modify `reserveBudget` to accept optional `userId` and `sessionId` in the
  subject:
  ```typescript
  subject: {
    tenant: config.tenant,
    ...(config.budgetId ? { app: config.budgetId } : {}),
    ...(userId ? { user: userId } : {}),
    ...(sessionId ? { session: sessionId } : {}),
  }
  ```
- Similarly update `fetchBudgetState` to pass `user` and `session` params.

**Hook changes (`hooks.ts`):**
- In `initHooks`, resolve `userId` and `sessionId` from config. Store as
  module-level state.
- In each hook that receives `ctx`, check `ctx.metadata?.userId` and
  `ctx.metadata?.sessionId` as runtime overrides (config values are defaults).
- Pass resolved userId/sessionId to `reserveBudget` and `fetchBudgetState`.

**Interface changes (`cycles.ts`):**
- Add `userId?: string` and `sessionId?: string` to `ReserveOptions`.
- Add same to `fetchBudgetState` params.

**Tests:**
- Test subject includes `user` when `userId` is set.
- Test subject includes `session` when `sessionId` is set.
- Test `ctx.metadata.userId` overrides config `userId`.
- Test balance fetch scoped by user/session.

---

### Gap 8: Configurable Reservation TTL

**Goal:** Make the 60s TTL configurable.

**Config changes (`types.ts` → `BudgetGuardConfig`):**
- Add `reservationTtlMs: number` — default `60_000`.
- Add `toolReservationTtls?: Record<string, number>` — per-tool overrides.

**Config resolution (`config.ts`):**
- Parse `reservationTtlMs` with `asNumber()`, default `60_000`.
- Parse `toolReservationTtls` with `asNumberRecord()`, default `undefined`.

**Plugin manifest (`openclaw.plugin.json`):**
- Add both fields to `configSchema.properties`.

**Cycles changes (`cycles.ts` → `reserveBudget`):**
- Add `ttlMs?: number` to `ReserveOptions`.
- Use `opts.ttlMs ?? 60_000` instead of hard-coded `60_000`.

**Hook changes (`hooks.ts` → `beforeToolCall`):**
- Compute TTL: `config.toolReservationTtls?.[toolName] ?? config.reservationTtlMs`.
- Pass to `reserveBudget({ ..., ttlMs })`.

**Tests:**
- Test custom TTL passed to Cycles API.
- Test per-tool TTL override.
- Test default 60s when not configured.

---

### Gap 11: Configurable Snapshot Cache TTL

**Goal:** Replace the hard-coded 5s cache TTL with a config field.

**Config changes (`types.ts` → `BudgetGuardConfig`):**
- Add `snapshotCacheTtlMs: number` — default `5_000`.

**Config resolution (`config.ts`):**
- Parse with `asNumber()`, default `5_000`.

**Plugin manifest (`openclaw.plugin.json`):**
- Add `snapshotCacheTtlMs` (number, default 5000).

**Hook changes (`hooks.ts`):**
- Remove `const SNAPSHOT_TTL_MS = 5_000`.
- In `getSnapshot()`, use `config.snapshotCacheTtlMs` instead.

**Tests:**
- Test shorter TTL causes more frequent fetches.
- Test longer TTL serves cached snapshot.

---

### Gap 16: Overage Policy Configuration

**Goal:** Make the hard-coded `"ALLOW_IF_AVAILABLE"` overage policy configurable.

**Config changes (`types.ts` → `BudgetGuardConfig`):**
- Add `overagePolicy: string` — default `"ALLOW_IF_AVAILABLE"`. Valid: `"REJECT"`,
  `"ALLOW"`, `"ALLOW_WITH_CAPS"`.
- Add `toolOveragePolicies?: Record<string, string>` — per-tool overrides.

**Config resolution (`config.ts`):**
- Parse `overagePolicy` with `asString()`, default `"ALLOW_IF_AVAILABLE"`.
- Parse `toolOveragePolicies` with `asStringRecord()`, default `undefined`.

**Cycles changes (`cycles.ts` → `reserveBudget`):**
- Add `overagePolicy?: string` to `ReserveOptions`.
- Use `opts.overagePolicy ?? "ALLOW_IF_AVAILABLE"` instead of hard-coded `"ALLOW_IF_AVAILABLE"`.

**Hook changes (`hooks.ts` → `beforeToolCall`):**
- Compute policy: `config.toolOveragePolicies?.[toolName] ?? config.overagePolicy`.
- Pass to `reserveBudget({ ..., overagePolicy })`.

**Tests:**
- Test custom overage policy in reservation body.
- Test per-tool override.
- Test default ALLOW_IF_AVAILABLE.

---

### Phase 1 Summary — Files Modified

| File | Changes |
|------|---------|
| `src/types.ts` | +6 config fields, +`CostEstimatorContext`, +`kind` on `ActiveReservation` |
| `src/config.ts` | +6 parsers, +`asFunction` helper |
| `src/cycles.ts` | +`ttlMs`, +`overagePolicy`, +`userId`/`sessionId` in `ReserveOptions` and subject |
| `src/hooks.ts` | Model reservation in `beforeModelResolve`, cost estimator in `afterToolCall`, TTL/policy pass-through in `beforeToolCall`, configurable cache TTL |
| `src/budget.ts` | No changes |
| `src/index.ts` | Possibly register `after_completion` hook |
| `openclaw.plugin.json` | +8 config schema properties |
| `tests/hooks.test.ts` | ~25 new test cases |
| `tests/config.test.ts` | ~8 new test cases |
| `tests/cycles.test.ts` | ~6 new test cases |
| `tests/helpers.ts` | Update `makeConfig()` defaults |

---

## Phase 2 — Access Control & Observability (Gaps 5, 6, 7, 12)

These are medium-severity, low-effort gaps that improve visibility and control.
They have no dependencies on each other and can be implemented in any order
within this phase.

### Gap 5: Budget Transition Alerts

**Goal:** Detect level transitions and notify external systems.

**Config changes (`types.ts` → `BudgetGuardConfig`):**
- Add `onBudgetTransition?: (event: BudgetTransitionEvent) => void` — callback,
  programmatic only.
- Add `budgetTransitionWebhookUrl?: string` — optional HTTP POST endpoint.

**New type (`types.ts`):**
```typescript
export interface BudgetTransitionEvent {
  previousLevel: BudgetLevel;
  currentLevel: BudgetLevel;
  remaining: number;
  timestamp: number;
}
```

**Hook changes (`hooks.ts`):**
- Add module-level `lastKnownLevel: BudgetLevel | undefined`.
- After every `getSnapshot()` call, compare `snapshot.level` to `lastKnownLevel`.
- If changed:
  - Call `config.onBudgetTransition?.({ previousLevel, currentLevel, remaining, timestamp })`.
  - If `config.budgetTransitionWebhookUrl` is set, fire a non-blocking
    `fetch(url, { method: "POST", body: JSON.stringify(event) })`. Log errors
    at warn level but never throw.
  - Update `lastKnownLevel`.
- Initialize `lastKnownLevel` in `initHooks()`.

**Tests:**
- Test callback fired on healthy → low transition.
- Test callback NOT fired when level unchanged.
- Test webhook POST on transition (mock fetch).
- Test webhook failure logged but does not throw.

---

### Gap 6: Per-Tool / Per-Model Cost Breakdown

**Goal:** Track itemized costs by component for the session summary.

**New module-level state (`hooks.ts`):**
```typescript
const costBreakdown = new Map<string, { count: number; totalCost: number }>();
```

**Hook changes (`hooks.ts`):**
- **`beforeToolCall`:** After successful reservation, update
  `costBreakdown.get(toolName)` (increment count, add estimate).
- **`beforeModelResolve`:** After model reservation (gap 1), update
  `costBreakdown.get("model:" + modelName)`.
- **`afterToolCall`:** If `costEstimator` (gap 2) adjusts the actual cost,
  update the breakdown entry to reflect the delta.
- **`agentEnd`:** Include `costBreakdown` as `Record<string, { count, totalCost }>`
  in the session summary and metadata attachment.

**Tests:**
- Test breakdown tracks multiple tools correctly.
- Test breakdown appears in `agentEnd` summary metadata.
- Test breakdown resets across `initHooks` calls.

---

### Gap 7: Tool Allowlist / Blocklist

**Goal:** Block or permit specific tools regardless of budget.

**Config changes (`types.ts` → `BudgetGuardConfig`):**
- Add `toolAllowlist?: string[]` — if set, only these tools are permitted.
- Add `toolBlocklist?: string[]` — these tools are always blocked.

**Config resolution (`config.ts`):**
- Parse both with a new `asStringArray()` helper.

**Plugin manifest (`openclaw.plugin.json`):**
- Add both fields (array of strings).

**New utility (`budget.ts` or new `tools.ts`):**
```typescript
export function isToolPermitted(
  toolName: string,
  allowlist?: string[],
  blocklist?: string[],
): { permitted: boolean; reason?: string }
```
- Support simple glob matching (`*` wildcard) for patterns like `code_*`.
- Logic: if `blocklist` contains a match → `{ permitted: false, reason }`.
  If `allowlist` is set and does NOT contain a match → `{ permitted: false, reason }`.
  Otherwise → `{ permitted: true }`.

**Hook changes (`hooks.ts` → `beforeToolCall`):**
- Before creating a reservation, call `isToolPermitted()`.
- If not permitted, return `{ block: true, blockReason }` immediately.

**Tests:**
- Test blocklisted tool blocked.
- Test tool not on allowlist blocked.
- Test tool on allowlist permitted.
- Test wildcard matching.
- Test no lists configured → all permitted.

---

### Gap 12: End-User Budget Visibility

**Goal:** Surface budget status to the human user, not just the AI model.

**Hook changes (`hooks.ts`):**
- In **every hook that calls `getSnapshot()`**, after getting the snapshot:
  ```typescript
  if (ctx.metadata) {
    ctx.metadata["cycles-budget-guard-status"] = {
      level: snapshot.level,
      remaining: snapshot.remaining,
      allocated: snapshot.allocated,
      percentRemaining: snapshot.allocated
        ? Math.round((snapshot.remaining / snapshot.allocated) * 100)
        : undefined,
    };
  }
  ```
- This makes budget status available to OpenClaw frontends on every hook
  invocation, not just `agent_end`.

**New type (`types.ts`):**
```typescript
export interface BudgetStatusMetadata {
  level: BudgetLevel;
  remaining: number;
  allocated?: number;
  percentRemaining?: number;
}
```

**Tests:**
- Test `ctx.metadata["cycles-budget-guard-status"]` set in `beforeModelResolve`.
- Test `ctx.metadata["cycles-budget-guard-status"]` set in `beforeToolCall`.
- Test not set when `ctx.metadata` is undefined.

---

### Phase 2 Summary — Files Modified

| File | Changes |
|------|---------|
| `src/types.ts` | +`BudgetTransitionEvent`, +`BudgetStatusMetadata`, +allowlist/blocklist config fields, +webhook config |
| `src/config.ts` | +`asStringArray` helper, parse new fields |
| `src/hooks.ts` | Transition detection, cost breakdown tracking, tool permission check, user-facing metadata |
| `src/budget.ts` or new `src/tools.ts` | `isToolPermitted()` with glob matching |
| `openclaw.plugin.json` | +4 config schema properties |
| `tests/hooks.test.ts` | ~20 new test cases |
| `tests/config.test.ts` | ~4 new test cases |
| New `tests/tools.test.ts` | ~10 test cases for `isToolPermitted` |

---

## Phase 3 — Smart Behavior (Gaps 4, 9, 13, 17)

These gaps add intelligence to budget decisions. They depend on phase 1
(model costs, accurate tracking) being in place.

### Gap 4: Chained Model Fallbacks

**Goal:** Support multi-step model downgrade chains.

**Config changes (`types.ts` → `BudgetGuardConfig`):**
- Change `modelFallbacks` type from `Record<string, string>` to
  `Record<string, string | string[]>`.

**Config resolution (`config.ts`):**
- Change `asStringRecord` usage to a new `asModelFallbacks()` parser that
  accepts both string and string[] values.

**Plugin manifest (`openclaw.plugin.json`):**
- Update `modelFallbacks` schema: `additionalProperties` becomes
  `oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }]`.

**Hook changes (`hooks.ts` → `beforeModelResolve`):**
- When budget is low:
  ```typescript
  const fallbacks = config.modelFallbacks[event.model];
  if (!fallbacks) return undefined;

  const candidates = Array.isArray(fallbacks) ? fallbacks : [fallbacks];
  for (const candidate of candidates) {
    const cost = config.modelBaseCosts[candidate] ?? config.defaultModelCost;
    if (cost <= snapshot.remaining) {
      return { modelOverride: candidate };
    }
  }
  // No affordable fallback found
  if (config.failClosed) throw new BudgetExhaustedError(snapshot.remaining);
  ```

**Tests:**
- Test array fallback selects first affordable model.
- Test array fallback skips too-expensive models.
- Test array fallback exhausts all options → error when `failClosed`.
- Test single-string fallback still works (backwards compatible).

---

### Gap 9: Budget Forecast / Projection

**Goal:** Tell the model and user how many more operations are affordable.

**New module-level state (`hooks.ts`):**
```typescript
let totalToolCost = 0;
let totalToolCalls = 0;
let totalModelCost = 0;
let totalModelCalls = 0;
```

**Budget changes (`budget.ts`):**
- Add `formatBudgetForecast()`:
  ```typescript
  export function formatBudgetForecast(
    remaining: number,
    avgToolCost: number,
    avgModelCost: number,
  ): string
  ```
  Returns e.g., `"~10 tool calls and ~5 model calls remaining at current rate."`
  Returns empty string if no data yet.

- Modify `formatBudgetHint()` to accept an optional forecast string and
  append it.

**Hook changes (`hooks.ts`):**
- Track running totals in `afterToolCall` and after model commit.
- In `beforePromptBuild`, compute averages and pass to `formatBudgetHint`.

**Metadata (`hooks.ts` → `agentEnd`):**
- Include forecast data in session summary:
  ```typescript
  avgToolCost: totalToolCalls > 0 ? totalToolCost / totalToolCalls : 0,
  avgModelCost: totalModelCalls > 0 ? totalModelCost / totalModelCalls : 0,
  estimatedRemainingToolCalls: ...,
  estimatedRemainingModelCalls: ...,
  ```

**Tests:**
- Test forecast with known averages.
- Test forecast empty when no calls made yet.
- Test forecast in prompt hint.
- Test forecast in session summary.

---

### Gap 13: Graceful Degradation Strategies

**Goal:** Composable strategies beyond model downgrade.

**Config changes (`types.ts` → `BudgetGuardConfig`):**
- Add `lowBudgetStrategies: string[]` — ordered list of strategies to apply
  when budget is low. Default `["downgrade_model"]`.
  Valid values: `"downgrade_model"`, `"reduce_max_tokens"`,
  `"disable_expensive_tools"`, `"limit_remaining_calls"`.
- Add `maxTokensWhenLow?: number` — max output tokens to request when
  `reduce_max_tokens` is active. Default `1024`.
- Add `expensiveToolThreshold?: number` — tools with cost above this
  are disabled when `disable_expensive_tools` is active.
  Default same as `lowBudgetThreshold / 10`.
- Add `maxRemainingCallsWhenLow?: number` — hard cap on remaining tool calls.
  Default `10`.

**Hook changes (`hooks.ts` → `beforeModelResolve`):**
- If budget is low and strategies include `"reduce_max_tokens"`:
  - Return `{ modelOverride, maxTokens: config.maxTokensWhenLow }` if the
    OpenClaw `ModelResolveResult` supports a `maxTokens` field.
  - If not supported, inject a "limit your response to N tokens" hint via
    the prompt (coordinate with `beforePromptBuild`).

**Hook changes (`hooks.ts` → `beforeToolCall`):**
- If budget is low and strategies include `"disable_expensive_tools"`:
  - Check tool cost against `config.expensiveToolThreshold`.
  - Block if above threshold.
- If strategies include `"limit_remaining_calls"`:
  - Track `remainingCallsAllowed` counter, decrement on each allowed call.
  - Block when counter reaches 0.

**Tests:**
- Test each strategy in isolation.
- Test strategy composition (downgrade + reduce tokens + disable expensive).
- Test `limit_remaining_calls` counter.
- Test default `["downgrade_model"]` preserves current behavior.

---

### Gap 17: Retry on Denied Tool Calls

**Goal:** Optionally retry a denied reservation after a short delay.

**Config changes (`types.ts` → `BudgetGuardConfig`):**
- Add `retryOnDeny: boolean` — default `false`.
- Add `retryDelayMs: number` — default `2_000`.
- Add `maxRetries: number` — default `1`.

**Hook changes (`hooks.ts` → `beforeToolCall`):**
- After a DENY decision, if `config.retryOnDeny`:
  ```typescript
  for (let attempt = 0; attempt < config.maxRetries; attempt++) {
    await sleep(config.retryDelayMs);
    invalidateSnapshotCache();
    const retry = await reserveBudget(client, config, { ... });
    if (isAllowed(retry.decision)) {
      // proceed as normal
      break;
    }
  }
  // still denied → block
  ```

**Utility (`hooks.ts`):**
- Add `function sleep(ms: number): Promise<void>`.

**Tests:**
- Test retry succeeds on second attempt.
- Test retry exhausts max retries then blocks.
- Test no retry when `retryOnDeny` is false (default).

---

### Phase 3 Summary — Files Modified

| File | Changes |
|------|---------|
| `src/types.ts` | Widen `modelFallbacks` type, +strategy config fields, +retry config fields |
| `src/config.ts` | +`asModelFallbacks` parser, parse strategy/retry fields |
| `src/hooks.ts` | Chained fallback loop, forecast tracking, strategy dispatch, retry loop |
| `src/budget.ts` | +`formatBudgetForecast()`, modify `formatBudgetHint()` |
| `openclaw.plugin.json` | +7 config schema properties |
| `tests/hooks.test.ts` | ~30 new test cases |
| `tests/budget.test.ts` | ~6 new test cases |
| `tests/config.test.ts` | ~6 new test cases |

---

## Phase 4 — Simulation & Analytics (Gaps 10, 15)

### Gap 10: Dry-Run / Simulation Mode

**Goal:** Full plugin behavior without a live Cycles server.

**Config changes (`types.ts` → `BudgetGuardConfig`):**
- Add `dryRun: boolean` — default `false`.
- Add `dryRunBudget: number` — simulated starting balance. Default `100_000_000`.

**New module (`src/dry-run.ts`):**
```typescript
export class DryRunClient {
  private remaining: number;

  constructor(initialBudget: number) { ... }

  async getBalances(params): Promise<...> { /* return simulated balance */ }
  async createReservation(body): Promise<...> { /* decrement remaining, return ALLOW or DENY */ }
  async commitReservation(id, body): Promise<...> { /* no-op success */ }
  async releaseReservation(id, body): Promise<...> { /* refund to remaining */ }
}
```
- Implements the same interface as `CyclesClient` so it can be used as a
  drop-in replacement.

**Hook changes (`hooks.ts` → `initHooks`):**
- If `config.dryRun`:
  ```typescript
  client = new DryRunClient(config.dryRunBudget) as unknown as CyclesClient;
  ```
- All other hook logic remains identical — classification, reservation,
  commit, release all work against the simulated client.

**Logger prefix:**
- When dry-run is active, prefix log messages with `[DRY-RUN]`.

**Tests (`new tests/dry-run.test.ts`):**
- Test simulated balance decrements on reservation.
- Test DENY when simulated balance insufficient.
- Test release refunds balance.
- Test commit is no-op.
- Test full hook lifecycle in dry-run mode.

---

### Gap 15: Cross-Session Budget Analytics

**Goal:** Allow session summaries to be persisted externally.

**Config changes (`types.ts` → `BudgetGuardConfig`):**
- Add `onSessionEnd?: (summary: SessionSummary) => void | Promise<void>` —
  programmatic callback.
- Add `analyticsWebhookUrl?: string` — HTTP POST endpoint for session summary.

**New type (`types.ts`):**
```typescript
export interface SessionSummary {
  tenant: string;
  budgetId?: string;
  userId?: string;
  sessionId?: string;
  remaining: number;
  spent: number;
  reserved: number;
  allocated?: number;
  level: BudgetLevel;
  totalReservationsMade: number;
  costBreakdown: Record<string, { count: number; totalCost: number }>;
  startedAt: number;
  endedAt: number;
}
```

**Hook changes (`hooks.ts` → `agentEnd`):**
- Record `sessionStartedAt` in `initHooks()`.
- Build `SessionSummary` object with all fields.
- Call `config.onSessionEnd?.(summary)` (await if it returns a promise).
- If `config.analyticsWebhookUrl`, POST the summary. Best-effort — log
  errors, never throw.

**Tests:**
- Test `onSessionEnd` callback receives complete summary.
- Test webhook POST fires with correct body.
- Test webhook failure does not throw.

---

### Phase 4 Summary — Files Modified

| File | Changes |
|------|---------|
| `src/types.ts` | +`SessionSummary`, +dry-run config fields, +analytics config fields |
| `src/config.ts` | Parse new fields |
| New `src/dry-run.ts` | `DryRunClient` class (~80 lines) |
| `src/hooks.ts` | Dry-run client swap in `initHooks`, session timing, analytics dispatch in `agentEnd` |
| `openclaw.plugin.json` | +3 config schema properties |
| New `tests/dry-run.test.ts` | ~15 test cases |
| `tests/hooks.test.ts` | ~10 new test cases |

---

## Phase 5 — Advanced / Multi-Tenant (Gaps 14, 18)

These are lower-severity, higher-effort gaps that add enterprise capabilities.

### Gap 14: Multi-Currency Support

**Goal:** Support different currency units for different action types.

**Config changes (`types.ts` → `BudgetGuardConfig`):**
- Add `toolCurrencies?: Record<string, string>` — per-tool currency overrides.
- Add `modelCurrency?: string` — currency for model reservations (defaults
  to `currency`).

**Cycles changes (`cycles.ts`):**
- `reserveBudget` already accepts the estimate unit via `config.currency`.
  Modify to accept an explicit `unit` in `ReserveOptions`, falling back to
  `config.currency`.

**Hook changes (`hooks.ts`):**
- In `beforeToolCall`, resolve currency:
  `config.toolCurrencies?.[toolName] ?? config.currency`.
- In `beforeModelResolve`, use `config.modelCurrency ?? config.currency`.

**Budget changes (`budget.ts` / `cycles.ts`):**
- `fetchBudgetState` may need to return balances for multiple currencies.
  Modify `BudgetSnapshot` to optionally include
  `balancesByCurrency?: Record<string, { remaining, reserved, spent }>`.
- Classification uses the primary `currency` balance.

**Session summary:**
- Breakdown per currency in `agentEnd`.

**Tests:**
- Test per-tool currency override in reservation body.
- Test model currency override.
- Test multi-currency session summary.

---

### Gap 18: Budget Pools / Shared Quotas

**Goal:** Surface hierarchical budget structure.

**Config changes (`types.ts` → `BudgetGuardConfig`):**
- Add `parentBudgetId?: string` — maps to a parent scope in Cycles subjects.

**Cycles changes (`cycles.ts` → `fetchBudgetState`):**
- If `parentBudgetId` is set, also fetch balances for the parent scope.
- Return both in `BudgetSnapshot`:
  ```typescript
  poolRemaining?: number;
  poolAllocated?: number;
  ```

**Budget changes (`budget.ts`):**
- `formatBudgetHint`: If pool data is available, append
  `"Team pool: X remaining."`.
- Classification uses the individual balance, but logs pool status.

**Cycles changes (`cycles.ts` → subject):**
- Reservations target the individual scope (tenant + budgetId + userId).
  The Cycles server handles hierarchical deduction from the pool.
  No additional reservation logic needed — this is a read-side enhancement.

**Tests:**
- Test pool balance fetched and included in snapshot.
- Test pool info in budget hint.
- Test pool info in session summary.

---

### Phase 5 Summary — Files Modified

| File | Changes |
|------|---------|
| `src/types.ts` | +`BudgetSnapshot` pool fields, +currency config fields, +`parentBudgetId` |
| `src/config.ts` | Parse new fields |
| `src/cycles.ts` | Multi-currency in `ReserveOptions`, pool balance fetch |
| `src/hooks.ts` | Currency resolution per tool/model, pool data pass-through |
| `src/budget.ts` | Pool info in hint, multi-currency classification |
| `openclaw.plugin.json` | +3 config schema properties |
| `tests/cycles.test.ts` | ~8 new test cases |
| `tests/budget.test.ts` | ~4 new test cases |
| `tests/hooks.test.ts` | ~6 new test cases |

---

## Cross-Cutting Concerns

### Backwards Compatibility

- All new config fields have defaults that preserve existing behavior.
- `modelFallbacks` change from `Record<string, string>` to
  `Record<string, string | string[]>` is backwards compatible — existing
  string values work unchanged.
- `costEstimator`, `onBudgetTransition`, and `onSessionEnd` are optional
  callbacks that cannot be expressed in JSON config — they require
  programmatic setup. Document this clearly.

### Config Schema Versioning

- The `openclaw.plugin.json` version should be bumped:
  - Phase 1 → `0.2.0`
  - Phase 2 → `0.3.0`
  - Phase 3 → `0.4.0`
  - Phase 4 → `0.5.0`
  - Phase 5 → `0.6.0`

### Test Coverage

- Maintain 90% line / 80% branch coverage after each phase.
- Each phase should pass `npm run typecheck && npm run test` before merging.

### Documentation

- Update `README.md` Config Reference table after each phase.
- Add examples for new config fields to the Full Configuration Example.
- Update the Architecture diagram if new hooks are registered.
- Update AUDIT.md after each phase to validate new hook behaviors.

---

## Implementation Order Summary

```
Phase 1 (Gaps 1,2,3,8,11,16)  ── Core accuracy & configurability
  │
  ├── Gap 11: Configurable cache TTL      (standalone, ~15 min)
  ├── Gap 8:  Configurable reservation TTL (standalone, ~20 min)
  ├── Gap 16: Overage policy config        (standalone, ~20 min)
  ├── Gap 3:  Per-user/session scoping     (standalone, ~30 min)
  ├── Gap 1:  LLM call reservations        (core, ~45 min)
  └── Gap 2:  Actual cost tracking         (depends on gap 1 pattern, ~30 min)

Phase 2 (Gaps 5,6,7,12)  ── Observability & access control
  │
  ├── Gap 7:  Tool allowlist/blocklist     (standalone, ~30 min)
  ├── Gap 12: End-user budget visibility   (standalone, ~20 min)
  ├── Gap 6:  Per-tool cost breakdown      (depends on gap 1, ~25 min)
  └── Gap 5:  Budget transition alerts     (standalone, ~30 min)

Phase 3 (Gaps 4,9,13,17)  ── Smart behavior
  │
  ├── Gap 4:  Chained model fallbacks      (depends on gap 1, ~25 min)
  ├── Gap 17: Retry on denied tool calls   (standalone, ~20 min)
  ├── Gap 9:  Budget forecast              (depends on gaps 1,2,6, ~30 min)
  └── Gap 13: Graceful degradation         (depends on gaps 1,7, ~45 min)

Phase 4 (Gaps 10,15)  ── Simulation & analytics
  │
  ├── Gap 10: Dry-run mode                 (standalone, ~40 min)
  └── Gap 15: Cross-session analytics      (depends on gap 6, ~30 min)

Phase 5 (Gaps 14,18)  ── Enterprise / multi-tenant
  │
  ├── Gap 14: Multi-currency               (depends on gaps 1,6, ~50 min)
  └── Gap 18: Budget pools                 (depends on gap 3, ~35 min)
```

### New Config Fields Summary (all phases)

| Phase | Field | Type | Default |
|-------|-------|------|---------|
| 1 | `modelBaseCosts` | `Record<string, number>` | `{}` |
| 1 | `defaultModelCost` | `number` | `500_000` |
| 1 | `costEstimator` | `function` | `undefined` |
| 1 | `userId` | `string` | `undefined` |
| 1 | `sessionId` | `string` | `undefined` |
| 1 | `reservationTtlMs` | `number` | `60_000` |
| 1 | `toolReservationTtls` | `Record<string, number>` | `undefined` |
| 1 | `snapshotCacheTtlMs` | `number` | `5_000` |
| 1 | `overagePolicy` | `string` | `"ALLOW_IF_AVAILABLE"` |
| 1 | `toolOveragePolicies` | `Record<string, string>` | `undefined` |
| 2 | `onBudgetTransition` | `function` | `undefined` |
| 2 | `budgetTransitionWebhookUrl` | `string` | `undefined` |
| 2 | `toolAllowlist` | `string[]` | `undefined` |
| 2 | `toolBlocklist` | `string[]` | `undefined` |
| 3 | `lowBudgetStrategies` | `string[]` | `["downgrade_model"]` |
| 3 | `maxTokensWhenLow` | `number` | `1024` |
| 3 | `expensiveToolThreshold` | `number` | `lowBudgetThreshold / 10` |
| 3 | `maxRemainingCallsWhenLow` | `number` | `10` |
| 3 | `retryOnDeny` | `boolean` | `false` |
| 3 | `retryDelayMs` | `number` | `2_000` |
| 3 | `maxRetries` | `number` | `1` |
| 4 | `dryRun` | `boolean` | `false` |
| 4 | `dryRunBudget` | `number` | `100_000_000` |
| 4 | `onSessionEnd` | `function` | `undefined` |
| 4 | `analyticsWebhookUrl` | `string` | `undefined` |
| 5 | `toolCurrencies` | `Record<string, string>` | `undefined` |
| 5 | `modelCurrency` | `string` | `undefined` |
| 5 | `parentBudgetId` | `string` | `undefined` |

### New Files

| Phase | File | Purpose |
|-------|------|---------|
| 2 | `src/tools.ts` | `isToolPermitted()` with glob matching |
| 2 | `tests/tools.test.ts` | Tool permission tests |
| 4 | `src/dry-run.ts` | `DryRunClient` simulated Cycles client |
| 4 | `tests/dry-run.test.ts` | Dry-run client tests |

### Estimated Total New Test Cases: ~140
### Estimated Total New Lines of Production Code: ~500
### Estimated Total New Lines of Test Code: ~800
