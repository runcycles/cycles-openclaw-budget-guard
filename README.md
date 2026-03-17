# cycles-openclaw-budget-guard

OpenClaw plugin for budget-aware model and tool execution using [Cycles](https://github.com/runcycles).

## Overview

A comprehensive OpenClaw plugin that integrates with a live Cycles server to enforce budget boundaries during agent execution. It hooks into the OpenClaw plugin lifecycle to:

- **Reserve budget for model and tool calls** using the reserve → commit → release protocol
- **Downgrade models** when budget is low (configurable fallback chains)
- **Block execution** when budget is exhausted (fail-closed by default)
- **Inject budget hints** into prompts so the model is budget-aware
- **Detect budget transitions** and fire callbacks/webhooks on level changes
- **Control tool access** with allowlists and blocklists
- **Apply graceful degradation** strategies when budget is low
- **Retry denied reservations** with configurable backoff
- **Support dry-run mode** for testing without a live Cycles server
- **Track per-tool cost breakdowns** and session analytics
- **Support multi-currency** budgets with per-tool/model overrides
- **Support budget pools/hierarchies** via parent budget visibility
- **Emit a budget summary** at the end of each agent session

The plugin uses the [`runcycles`](https://github.com/runcycles/cycles-client-typescript) TypeScript client to communicate with a Cycles server.

## Prerequisites

- **OpenClaw** >= 0.1.0 with plugin support
- **Node.js** >= 20.0.0
- A running **Cycles server** with:
  - A base URL (e.g. `https://cycles.example.com`)
  - An API key
  - A tenant configured with a budget scope

If you don't have a Cycles server yet, see the [Cycles quickstart](https://github.com/runcycles) to set one up. Alternatively, use **dry-run mode** to test without a server.

>To see budget enforcement in action before wiring up your own agent, run the 
[Cycles Runaway Demo](https://github.com/runcycles/cycles-runaway-demo) — 
it shows the exact failure mode this plugin prevents, with a live before/after comparison.

## Quick Start

### 1. Install the plugin

```bash
openclaw plugins install @runcycles/openclaw-budget-guard
```

For local development:

```bash
openclaw plugins install -l ./cycles-openclaw-budget-guard
```

### 2. Enable the plugin

```bash
openclaw plugins enable cycles-openclaw-budget-guard
```

### 3. Add minimal configuration

```json
{
  "plugins": {
    "entries": {
      "cycles-openclaw-budget-guard": {
        "cyclesBaseUrl": "https://cycles.example.com",
        "cyclesApiKey": "cyc_your_api_key_here",
        "tenant": "my-org"
      }
    }
  }
}
```

That's it — the plugin uses sensible defaults for everything else. The agent will now enforce budget limits on every run.

> **Need an API key?** API keys are created via the Cycles Admin Server (port 7979). See the [deployment guide](https://runcycles.io/quickstart/deploying-the-full-cycles-stack#step-3-create-an-api-key) to create one, or see [API Key Management](https://runcycles.io/how-to/api-key-management-in-cycles) for details.

### 4. (Optional) Use environment variables for secrets

```bash
export CYCLES_BASE_URL="https://cycles.example.com"
export CYCLES_API_KEY="cyc_your_api_key_here"
```

Then your config only needs `"tenant": "my-org"`.

### 5. (Optional) Try dry-run mode

To test without a live Cycles server:

```json
{
  "plugins": {
    "entries": {
      "cycles-openclaw-budget-guard": {
        "tenant": "my-org",
        "cyclesBaseUrl": "http://unused",
        "cyclesApiKey": "unused",
        "dryRun": true,
        "dryRunBudget": 100000000
      }
    }
  }
}
```

## Full Configuration Example

```json
{
  "plugins": {
    "entries": {
      "cycles-openclaw-budget-guard": {
        "enabled": true,
        "cyclesBaseUrl": "https://cycles.example.com",
        "cyclesApiKey": "cyc_your_api_key_here",
        "tenant": "my-org",
        "budgetId": "my-app",
        "currency": "USD_MICROCENTS",
        "lowBudgetThreshold": 10000000,
        "exhaustedThreshold": 0,
        "modelFallbacks": {
          "claude-opus-4-20250514": ["claude-sonnet-4-20250514", "claude-haiku-4-5-20251001"],
          "gpt-4o": "gpt-4o-mini"
        },
        "modelBaseCosts": {
          "claude-opus-4-20250514": 1500000,
          "claude-sonnet-4-20250514": 300000,
          "gpt-4o": 1000000,
          "gpt-4o-mini": 100000
        },
        "toolBaseCosts": {
          "web_search": 500000,
          "code_execution": 1000000
        },
        "injectPromptBudgetHint": true,
        "maxPromptHintChars": 200,
        "failClosed": true,
        "logLevel": "info",
        "reservationTtlMs": 60000,
        "overagePolicy": "REJECT",
        "lowBudgetStrategies": ["downgrade_model"],
        "maxTokensWhenLow": 1024,
        "retryOnDeny": false,
        "dryRun": false
      }
    }
  }
}
```

## Config Reference

### Core Settings

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Master switch — set to `false` to disable the plugin |
| `cyclesBaseUrl` | string | — | Cycles server URL (required, or `CYCLES_BASE_URL` env var) |
| `cyclesApiKey` | string | — | Cycles API key (required, or `CYCLES_API_KEY` env var) |
| `tenant` | string | — | Cycles tenant identifier (required) |
| `budgetId` | string | — | Optional app-level scope for balance queries and reservations |
| `currency` | string | `USD_MICROCENTS` | Default budget unit for all reservations |
| `failClosed` | boolean | `true` | Block on exhausted budget (`false` = warn and continue) |
| `logLevel` | string | `info` | `debug` / `info` / `warn` / `error` |

### Budget Thresholds

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `lowBudgetThreshold` | number | `10000000` | Remaining budget at or below this triggers "low" mode |
| `exhaustedThreshold` | number | `0` | Remaining budget at or below this triggers "exhausted" mode |

> **Note:** `exhaustedThreshold` must be strictly less than `lowBudgetThreshold`.

### Model Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `modelFallbacks` | object | `{}` | Map: model → fallback model or chain of fallbacks (string or string[]) |
| `modelBaseCosts` | object | `{}` | Map: model name → estimated cost per call |
| `defaultModelCost` | number | `500000` | Fallback cost when a model isn't in `modelBaseCosts` |
| `defaultModelActionKind` | string | `llm.completion` | Action kind for model reservations |
| `modelCurrency` | string | — | Override currency for model reservations (defaults to `currency`) |

### Tool Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `toolBaseCosts` | object | `{}` | Map: tool name → estimated cost per call |
| `defaultToolActionKindPrefix` | string | `tool.` | Prefix for tool action kinds (e.g. `tool.web_search`) |
| `toolAllowlist` | string[] | — | Only these tools are permitted (supports `*` wildcards) |
| `toolBlocklist` | string[] | — | These tools are blocked (supports `*` wildcards, takes precedence over allowlist) |
| `toolCurrencies` | object | — | Map: tool name → currency override |
| `toolReservationTtls` | object | — | Map: tool name → TTL override in ms |
| `toolOveragePolicies` | object | — | Map: tool name → overage policy override |

### Prompt Hints

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `injectPromptBudgetHint` | boolean | `true` | Inject budget status into the system prompt |
| `maxPromptHintChars` | number | `200` | Max characters for the injected budget hint |

### Reservation Settings

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `reservationTtlMs` | number | `60000` | Default TTL for tool reservations (ms) |
| `overagePolicy` | string | `REJECT` | Default overage policy (`REJECT`, `ALLOW_IF_AVAILABLE`, `ALLOW_WITH_OVERDRAFT`) |
| `snapshotCacheTtlMs` | number | `5000` | How long to cache budget snapshots (ms) |

### Low Budget Strategies

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `lowBudgetStrategies` | string[] | `["downgrade_model"]` | Strategies to apply when budget is low |
| `maxTokensWhenLow` | number | `1024` | Token limit hint when `reduce_max_tokens` strategy is active |
| `expensiveToolThreshold` | number | — | Cost threshold for `disable_expensive_tools` strategy |
| `maxRemainingCallsWhenLow` | number | `10` | Max calls when `limit_remaining_calls` strategy is active |

Available strategies:
- **`downgrade_model`** — Use cheaper fallback models from `modelFallbacks`
- **`reduce_max_tokens`** — Append token limit guidance to prompt hints
- **`disable_expensive_tools`** — Block tools exceeding `expensiveToolThreshold`
- **`limit_remaining_calls`** — Cap total tool/model calls while budget is low

### Retry on Deny

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `retryOnDeny` | boolean | `false` | Retry tool reservations after denial |
| `retryDelayMs` | number | `2000` | Delay between retries (ms) |
| `maxRetries` | number | `1` | Maximum retry attempts |

### Dry-Run Mode

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `dryRun` | boolean | `false` | Use in-memory simulated budget (no Cycles server needed) |
| `dryRunBudget` | number | `100000000` | Starting budget for dry-run mode |

### Cost Estimation

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `costEstimator` | function | — | Custom callback `(context) => number \| undefined` for dynamic tool cost estimation |

The `costEstimator` receives a context object with `toolName`, `durationMs`, `estimate`, and `result` and should return the actual cost or `undefined` to use the estimate.

### Budget Transitions

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `onBudgetTransition` | function | — | Callback fired when budget level changes (e.g. healthy → low) |
| `budgetTransitionWebhookUrl` | string | — | POST webhook URL for budget level transitions |

### Per-User/Session Scoping

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `userId` | string | — | User ID for budget scoping (can be overridden via `ctx.metadata.userId`) |
| `sessionId` | string | — | Session ID for budget scoping (can be overridden via `ctx.metadata.sessionId`) |

### Session Analytics

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `onSessionEnd` | function | — | Callback with session summary at agent end |
| `analyticsWebhookUrl` | string | — | POST webhook URL for session summary data |

### Budget Pools

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `parentBudgetId` | string | — | Parent budget ID — when set, pool balance is included in hints |

## How It Works

### Budget Levels

| Level | Condition | What Happens |
|-------|-----------|--------------|
| **healthy** | `remaining > lowBudgetThreshold` | Pass through — no intervention |
| **low** | `exhaustedThreshold < remaining <= lowBudgetThreshold` | Apply low-budget strategies, inject warnings |
| **exhausted** | `remaining <= exhaustedThreshold` | Block execution (`failClosed=true`) or warn (`failClosed=false`) |

### Hook: `before_model_resolve`

Fetches budget state, reserves budget for the model call, and commits immediately (since there's no `after_model_resolve` hook). When budget is low:
- Applies model fallbacks (including chained fallbacks like `opus → [sonnet, haiku]`)
- Enforces `limit_remaining_calls` if configured
- Attaches budget status metadata to `ctx.metadata["cycles-budget-guard-status"]`

When budget is exhausted and `failClosed=true`, throws `BudgetExhaustedError`.

### Hook: `before_prompt_build`

When `injectPromptBudgetHint` is enabled, injects a system context hint with:
- Current remaining balance and percentage
- Budget level warnings
- Forecast projections (estimated remaining tool/model calls based on average costs)
- Team pool balance (when `parentBudgetId` is configured)
- Token limit guidance (when `reduce_max_tokens` strategy is active)

Example hint:
```
Budget: 5000000 USD_MICROCENTS remaining. Budget is low — prefer cheaper models and avoid expensive tools. 50% of budget remaining. Est. ~10 tool calls and ~5 model calls remaining at current rate. Team pool: 50000000 remaining.
```

### Hook: `before_tool_call`

1. Checks tool permissions against allowlist/blocklist
2. Applies `disable_expensive_tools` and `limit_remaining_calls` strategies
3. Creates a Cycles reservation with configured TTL, overage policy, and currency
4. On denial, optionally retries (when `retryOnDeny=true`)
5. Blocks or allows based on the reservation decision

### Hook: `after_tool_call`

Commits the reservation with actual cost. Uses the `costEstimator` callback if configured, otherwise uses the original estimate. Tracks per-tool cost breakdowns for the session summary.

### Hook: `agent_end`

1. Releases orphaned reservations (defensive cleanup)
2. Fetches final budget state
3. Builds session summary with cost breakdown, forecasts, and timing
4. Calls `onSessionEnd` callback and fires analytics webhook if configured
5. Attaches summary to `ctx.metadata["cycles-budget-guard"]`

### Chained Model Fallbacks

Model fallbacks support both single values and ordered chains:

```json
{
  "modelFallbacks": {
    "opus": ["sonnet", "haiku"],
    "gpt-4o": "gpt-4o-mini"
  }
}
```

When budget is low, the plugin tries each candidate in order and selects the first one whose cost fits within the remaining budget.

### Tool Allowlists and Blocklists

Control which tools can be called using glob-style patterns:

```json
{
  "toolAllowlist": ["web_search", "code_*"],
  "toolBlocklist": ["dangerous_*"]
}
```

- Blocklist takes precedence over allowlist
- Supports exact names and `*` wildcards (prefix: `code_*`, suffix: `*_tool`, all: `*`)

### Budget Transition Alerts

Configure callbacks or webhooks to be notified when budget level changes:

```json
{
  "budgetTransitionWebhookUrl": "https://hooks.example.com/budget-alert"
}
```

Or programmatically:

```typescript
{
  onBudgetTransition: (event) => {
    console.log(`Budget changed: ${event.previousLevel} → ${event.currentLevel}`);
  }
}
```

### Error Handling

The plugin exports two structured error types:

```typescript
import { BudgetExhaustedError, ToolBudgetDeniedError } from "@runcycles/openclaw-budget-guard";
```

- **`BudgetExhaustedError`** (`code: "BUDGET_EXHAUSTED"`) — thrown when budget is exhausted and `failClosed=true`
- **`ToolBudgetDeniedError`** (`code: "TOOL_BUDGET_DENIED"`) — available as a structured error type for tool denials

### Fail-Open Behavior

- If the Cycles server is **unreachable**, the plugin assumes healthy budget (fail-open)
- If a **commit fails**, execution continues (logged but non-blocking)
- `failClosed` only controls behavior when budget is **confirmed exhausted**

## Troubleshooting

**Plugin not loading**
- Verify the plugin is enabled: `openclaw plugins list`
- Check that `openclaw.plugin.json` is included in the installed package

**"cyclesBaseUrl is required" error**
- Set `cyclesBaseUrl` in config or export `CYCLES_BASE_URL` env var

**Budget always shows "healthy"**
- Verify `currency`, `tenant`, and `budgetId` match your Cycles setup
- Set `logLevel: "debug"` to see raw balance responses

**Tools not being blocked**
- Check `toolBaseCosts` includes your tool (default cost is 100,000 units)
- Check `failClosed` is `true` (default)

**Model not being downgraded**
- The exact model name must match a key in `modelFallbacks`
- Check model costs in `modelBaseCosts` — fallback must be cheaper than remaining budget

## Project Structure

```
cycles-openclaw-budget-guard/
├── openclaw.plugin.json         # Plugin manifest with configSchema and extensions
├── package.json                 # npm package with openclaw.extensions
├── tsconfig.json                # TypeScript configuration
├── tsup.config.ts               # Build configuration (ESM output)
├── vitest.config.ts             # Test runner configuration with v8 coverage
├── LICENSE                      # Apache-2.0
├── README.md                    # This file
├── FEATURE_GAPS.md              # Analysis of 18 identified feature gaps
├── IMPLEMENTATION_PLAN.md       # 5-phase implementation plan
├── AUDIT.md                     # Code audit and correctness review
├── src/
│   ├── index.ts                 # Plugin entrypoint — exports types and default function
│   ├── types.ts                 # Config, event, snapshot, and error type definitions
│   ├── config.ts                # Config validation with defaults and env-var fallbacks
│   ├── logger.ts                # Leveled logger with [cycles-budget-guard] prefix
│   ├── cycles.ts                # Wrappers around runcycles CyclesClient
│   ├── budget.ts                # Budget classification, hint formatting, tool permissions
│   ├── hooks.ts                 # All 5 hook implementations with reservation tracking
│   └── dry-run.ts               # In-memory simulated Cycles client for dry-run mode
└── tests/
    ├── helpers.ts               # Shared test utilities (makeConfig, makeSnapshot, etc.)
    ├── hooks.test.ts            # Hook implementation tests (79 tests)
    ├── budget.test.ts           # Budget classification and hint formatting tests (24 tests)
    ├── config.test.ts           # Config resolution and validation tests (29 tests)
    ├── cycles.test.ts           # Cycles API wrapper tests (32 tests)
    ├── dry-run.test.ts          # DryRunClient simulation tests (11 tests)
    ├── logger.test.ts           # Logger level filtering tests (8 tests)
    ├── index.test.ts            # Plugin entrypoint export tests (8 tests)
    └── types.test.ts            # Error class and type tests (9 tests)
```

### Architecture

```
OpenClaw Runtime
  │
  ├─ before_model_resolve ──→ hooks.ts ──→ cycles.ts (reserve + commit) ──→ Cycles Server
  │                                     └→ budget.ts (classify, fallbacks)
  │
  ├─ before_prompt_build  ──→ hooks.ts ──→ budget.ts (formatHint + forecast)
  │
  ├─ before_tool_call     ──→ hooks.ts ──→ budget.ts (isToolPermitted)
  │                                     └→ cycles.ts (createReservation) ──→ Cycles Server
  │
  ├─ after_tool_call      ──→ hooks.ts ──→ cycles.ts (commitReservation) ──→ Cycles Server
  │                                     └→ costEstimator callback (if configured)
  │
  └─ agent_end            ──→ hooks.ts ──→ cycles.ts (releaseReservation) ──→ Cycles Server
                                        └→ onSessionEnd callback / analytics webhook
```

In dry-run mode, `Cycles Server` is replaced by the in-memory `DryRunClient`.

## Local Development

> **Note:** These commands are for developing the plugin itself. End users install via `openclaw plugins install` (see [Quick Start](#quick-start)).

```bash
npm install              # Install dependencies
npm run build            # Build to dist/ (ESM + declarations)
npm run typecheck        # Type-check without emitting
npm test                 # Run all tests
npm run test:watch       # Run tests in watch mode
npm run test:coverage    # Run tests with v8 coverage report
```

Output is written to `dist/index.js` (ESM) with TypeScript declarations in `dist/index.d.ts`.

## CI & Publishing

CI runs automatically on push and pull requests to `main` (typecheck, build, test).

To publish a new version to npm:

```bash
# Update version in package.json and openclaw.plugin.json
npm version patch   # or minor / major

# Push the tag — triggers the publish workflow
git push origin main --follow-tags
```

The publish workflow:
- Triggers on `v*` tags (e.g. `v0.1.0`, `v0.2.0`)
- Runs the full build pipeline first
- Publishes to npm with `--provenance --access public`
- Requires the `NPM_TOKEN` secret in repository settings

After publishing, users install via:

```bash
openclaw plugins install @runcycles/openclaw-budget-guard
```

## License

Apache-2.0
