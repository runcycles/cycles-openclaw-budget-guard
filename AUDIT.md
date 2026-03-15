# cycles-openclaw-budget-guard — Plugin Audit

**Date:** 2026-03-15
**Plugin:** `@runcycles/openclaw-budget-guard` v0.1.0
**Runtime:** OpenClaw >= 0.1.0, Node 20+
**Cycles client:** `runcycles` ^0.1.1

---

## Summary

| Category | Pass | Issues |
|----------|------|--------|
| OpenClaw Plugin Contract | 3/3 | 0 |
| Config Schema (plugin.json ↔ types.ts ↔ config.ts) | 16/16 | 0 |
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

**Overall: Plugin is contract-conformant.** The `openclaw.plugin.json` manifest, `package.json` `openclaw.extensions` field, config schema, hook registrations, Cycles API usage, and error handling are all internally consistent and follow OpenClaw plugin conventions. No open issues.

---

## Audit Scope

Compared the following across plugin manifest, package metadata, and TypeScript source:
- OpenClaw plugin contract requirements (`openclaw.extensions`, `openclaw.plugin.json`, default export signature)
- All 16 config properties across `openclaw.plugin.json` configSchema, `BudgetGuardConfig` interface (types.ts), and `resolveConfig()` defaults (config.ts)
- All 5 hook registrations in `index.ts` against implementations in `hooks.ts`
- Cycles API calls (`getBalances`, `createReservation`, `commitReservation`, `releaseReservation`) against `runcycles` client methods
- Wire-format request bodies (snake_case keys matching Cycles Protocol spec)
- Budget classification thresholds and boundary conditions
- Error class codes and throw sites
- Fail-open behavior on Cycles server errors vs fail-closed on confirmed exhaustion
- Reservation lifecycle tracking (in-flight map, orphan cleanup at agent_end)
- Published package `files` field includes required artifacts

---

## PASS — Correctly Implemented

### OpenClaw Plugin Contract (all 3 requirements met)

| Requirement | Location | Status |
|---|---|---|
| `openclaw.extensions` in package.json | `package.json:32` — `"openclaw": { "extensions": ["./dist/index.js"] }` | PASS |
| `openclaw.plugin.json` manifest with `id`, `extensions`, `configSchema` | `openclaw.plugin.json` — id: `cycles-openclaw-budget-guard`, extensions: `["./dist/index.js"]` | PASS |
| Default export: `function(api: OpenClawPluginApi): void` | `src/index.ts:21` — `export default function (api) { ... }` | PASS |

Both `package.json` `openclaw.extensions` and `openclaw.plugin.json` `extensions` point to the same entrypoint (`./dist/index.js`). The default export receives `api` with `.config`, `.logger`, and `.on()` — matching the OpenClaw plugin registration API.

### Config Schema Alignment (all 16 fields match across 3 sources)

| Field | plugin.json type | plugin.json default | types.ts type | config.ts default | Match |
|---|---|---|---|---|---|
| `enabled` | boolean | `true` | `boolean` | `true` | PASS |
| `cyclesBaseUrl` | string | — | `string` | — (required) | PASS |
| `cyclesApiKey` | string | — | `string` | — (required) | PASS |
| `tenant` | string | — (required) | `string` | — (required) | PASS |
| `budgetId` | string | — | `string?` | `undefined` | PASS |
| `currency` | string | `USD_MICROCENTS` | `string` | `USD_MICROCENTS` | PASS |
| `defaultModelActionKind` | string | `llm.completion` | `string` | `llm.completion` | PASS |
| `defaultToolActionKindPrefix` | string | `tool.` | `string` | `tool.` | PASS |
| `lowBudgetThreshold` | number | `10000000` | `number` | `10_000_000` | PASS |
| `exhaustedThreshold` | number | `0` | `number` | `0` | PASS |
| `modelFallbacks` | object (string→string) | `{}` | `Record<string, string>` | `{}` | PASS |
| `toolBaseCosts` | object (string→number) | `{}` | `Record<string, number>` | `{}` | PASS |
| `injectPromptBudgetHint` | boolean | `true` | `boolean` | `true` | PASS |
| `maxPromptHintChars` | number | `200` | `number` | `200` | PASS |
| `failClosed` | boolean | `true` | `boolean` | `true` | PASS |
| `logLevel` | string (enum: debug/info/warn/error) | `info` | `"debug" \| "info" \| "warn" \| "error"` | `info` | PASS |

`plugin.json` `required: ["tenant"]` matches `config.ts` which throws if `tenant` is falsy. `cyclesBaseUrl` and `cyclesApiKey` are required in config.ts but not in plugin.json because they fall back to env vars (`CYCLES_BASE_URL`, `CYCLES_API_KEY`).

### Config Validation (all constraints enforced)

| Validation | Location | Status |
|---|---|---|
| `cyclesBaseUrl` required (config or env var) | `config.ts:16-20` | PASS |
| `cyclesApiKey` required (config or env var) | `config.ts:21-25` | PASS |
| `tenant` required | `config.ts:26-28` | PASS |
| `exhaustedThreshold < lowBudgetThreshold` | `config.ts:33-37` | PASS |
| Unknown config keys silently ignored (no crash) | `resolveConfig()` only reads known fields | PASS |

### Hook Registrations (all 5 match)

| Hook Name | index.ts Registration | hooks.ts Implementation | Priority | Match |
|---|---|---|---|---|
| `before_model_resolve` | `api.on("before_model_resolve", beforeModelResolve, { priority: 10 })` | `hooks.ts:104` — `async (event, ctx) => ModelResolveResult \| undefined` | 10 | PASS |
| `before_prompt_build` | `api.on("before_prompt_build", beforePromptBuild, { priority: 10 })` | `hooks.ts:145` — `async (event, ctx) => PromptBuildResult \| undefined` | 10 | PASS |
| `before_tool_call` | `api.on("before_tool_call", beforeToolCall, { priority: 10 })` | `hooks.ts:162` — `async (event, ctx) => ToolCallResult \| undefined` | 10 | PASS |
| `after_tool_call` | `api.on("after_tool_call", afterToolCall, { priority: 10 })` | `hooks.ts:212` — `async (event, ctx) => void` | 10 | PASS |
| `agent_end` | `api.on("agent_end", agentEnd, { priority: 100 })` | `hooks.ts:247` — `async (event, ctx) => void` | 100 | PASS |

Note: `agent_end` uses priority 100 (runs later) to ensure other plugins complete before cleanup. All other hooks use priority 10.

### Hook Return Types (all correct for OpenClaw contract)

| Hook | Return Value | OpenClaw Contract | Status |
|---|---|---|---|
| `before_model_resolve` | `{ modelOverride }` or `undefined` | Model override or passthrough | PASS |
| `before_prompt_build` | `{ prependSystemContext }` or `undefined` | System prompt injection or passthrough | PASS |
| `before_tool_call` | `{ block: true, blockReason }` or `undefined` | Block tool or passthrough | PASS |
| `after_tool_call` | `void` | No return value expected | PASS |
| `agent_end` | `void` | No return value expected | PASS |

### Cycles API Usage (all 4 endpoints correct)

| Operation | Client Method | Wire-Format Body Keys | Status |
|---|---|---|---|
| Fetch balances | `client.getBalances({ tenant, app? })` | Query params (no body) | PASS |
| Create reservation | `client.createReservation(body)` | `idempotency_key`, `subject`, `action`, `estimate`, `ttl_ms`, `overage_policy` | PASS |
| Commit reservation | `client.commitReservation(id, body)` | `idempotency_key`, `actual` | PASS |
| Release reservation | `client.releaseReservation(id, body)` | `idempotency_key`, `reason` | PASS |

All request bodies use snake_case wire-format keys (`idempotency_key`, `ttl_ms`, `overage_policy`) matching the Cycles Protocol spec. The `runcycles` client handles HTTP transport and response parsing.

**Reservation parameters:**
- `ttl_ms: 60_000` (60s) — reasonable timeout for tool execution
- `overage_policy: "REJECT"` — denies reservation when budget is exceeded
- `idempotency_key: randomUUID()` — unique per request via `node:crypto`

**Response handling:**
- `balanceResponseFromWire()` and `reservationCreateResponseFromWire()` from `runcycles` used for all response parsing
- `isAllowed()` from `runcycles` used for decision checking (covers `ALLOW` and `ALLOW_WITH_CAPS`)

### Budget Classification Logic (all 3 levels correct)

| Level | Condition (budget.ts:9-11) | Status |
|---|---|---|
| `exhausted` | `remaining <= exhaustedThreshold` | PASS |
| `low` | `remaining <= lowBudgetThreshold` (and not exhausted) | PASS |
| `healthy` | `remaining > lowBudgetThreshold` | PASS |

Order of evaluation is correct: exhausted is checked first, then low, then healthy. Boundary values are handled correctly — `remaining == lowBudgetThreshold` classifies as `low`, `remaining == exhaustedThreshold` classifies as `exhausted`.

### Error Types & Codes (all correct)

| Error Class | Code | Thrown By | Status |
|---|---|---|---|
| `BudgetExhaustedError` | `BUDGET_EXHAUSTED` | `hooks.ts:132` — `before_model_resolve` when exhausted and `failClosed=true` | PASS |
| `ToolBudgetDeniedError` | `TOOL_BUDGET_DENIED` | Exported for consumers; `before_tool_call` returns `{ block, blockReason }` instead of throwing | PASS |

Both extend `Error` with a typed `code` property and `name` set to the class name.

### Fail-Open / Fail-Closed Behavior (all correct)

| Scenario | Behavior | Location | Status |
|---|---|---|---|
| Cycles server unreachable (balance fetch) | Fail-open: returns `{ remaining: Infinity, level: "healthy" }` | `cycles.ts:49-54` | PASS |
| No matching balance in response | Fail-open: returns `{ remaining: Infinity, level: "healthy" }` | `cycles.ts:64-67` | PASS |
| Commit failure in `after_tool_call` | Best-effort: logged, never throws | `cycles.ts:159-172` (try/catch) | PASS |
| Budget confirmed exhausted + `failClosed=true` | Fail-closed: throws `BudgetExhaustedError` | `hooks.ts:128-133` | PASS |

The `failClosed` config only controls behavior when budget is **confirmed exhausted** by a successful Cycles API response — not when the budget service is unreachable.

### Reservation Lifecycle (correct)

- **Reserve:** `before_tool_call` creates a reservation and stores `{ reservationId, estimate, toolName, createdAt }` in an in-memory `Map` keyed by `toolCallId`
- **Commit:** `after_tool_call` looks up the reservation by `toolCallId`, commits `actual = estimate` (no proxy to measure real cost in phase 1), then deletes from map
- **Orphan cleanup:** `agent_end` releases all remaining reservations via `Promise.allSettled()`, then clears the map
- **Cache invalidation:** Snapshot cache is invalidated after every reserve and commit to ensure fresh budget state

### Snapshot Caching (correct)

- TTL: `SNAPSHOT_TTL_MS = 5_000` (5 seconds)
- Freshness check: `Date.now() - cachedSnapshotAt < SNAPSHOT_TTL_MS`
- Explicit invalidation after reservation create and commit (`invalidateSnapshotCache()`)
- Explicit invalidation at `agent_end` before fetching final summary

### Prompt Hint Formatting (correct)

- `formatBudgetHint()` builds a deterministic string: remaining amount, budget level warning, and percentage if `allocated` is available
- Truncated to `maxPromptHintChars` with `"..."` suffix if over limit
- Only injected when `injectPromptBudgetHint` is `true` (checked in `beforePromptBuild`)

### Session Summary & Metadata (correct)

- `agent_end` builds summary with: `remaining`, `spent`, `reserved`, `allocated`, `level`, `totalReservationsMade`
- Attached to `ctx.metadata["cycles-budget-guard"]` if `ctx.metadata` exists
- Summary logged at `info` level

### Published Package Contents (correct)

`package.json` `files` field: `["dist", "openclaw.plugin.json", "LICENSE", "README.md"]`

All required artifacts are included:
- `dist/index.js` — compiled plugin entrypoint (referenced by both `openclaw.extensions` and `openclaw.plugin.json`)
- `openclaw.plugin.json` — plugin manifest with config schema
- `LICENSE` — Apache-2.0
- `README.md` — documentation

---

## Verdict

The plugin is **fully contract-conformant** with OpenClaw plugin requirements and internally consistent across all configuration, hook, and Cycles API integration surfaces. The `openclaw.plugin.json` manifest, `package.json` `openclaw.extensions` field, 16 config properties, 5 hook registrations, 4 Cycles API operations, budget classification logic, error types, and fail-open/fail-closed behavior are all correct. No open issues.
