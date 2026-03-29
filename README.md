# cycles-openclaw-budget-guard

[![CI](https://github.com/runcycles/cycles-openclaw-budget-guard/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/runcycles/cycles-openclaw-budget-guard/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@runcycles/openclaw-budget-guard)](https://www.npmjs.com/package/@runcycles/openclaw-budget-guard)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](https://www.typescriptlang.org/)
[![Coverage](https://img.shields.io/badge/coverage-100%25-brightgreen)](https://github.com/runcycles/cycles-openclaw-budget-guard/actions)

OpenClaw plugin for budget-aware model and tool execution using [Cycles](https://github.com/runcycles).

## Why use this plugin?

AI agents make autonomous decisions — calling models, invoking tools, retrying on failure — with no human in the loop. Without runtime enforcement, several things go wrong:

**Runaway spend.** A single agent stuck in a tool loop or retrying failed calls can burn through hundreds of dollars in minutes. Provider spending caps are account-wide and too coarse. Rate limits don't account for cost. In-app counters don't survive restarts or coordinate across concurrent agents.

**Uncontrolled side-effects.** An agent can send 100 emails, trigger 50 deployments, or call dangerous APIs with nothing to stop it. Cost limits alone don't help — some actions are consequential regardless of price.

**Noisy neighbors.** In multi-tenant or multi-user setups, one agent can consume the entire team or tenant budget, starving other users. Without per-user scoping, there's no isolation.

**No session-level cost visibility.** When an agent session ends, you have no idea what it spent, which tools it called most, or whether it was cost-efficient. Debugging cost overruns after the fact is painful.

**Abrupt failure.** When budget runs out, the agent crashes instead of adapting — switching to cheaper models, reducing output length, or disabling expensive tools.

This plugin addresses those failure modes by checking model and tool execution before it runs, then degrading or blocking when budget conditions require it. It also tracks session-level cost breakdowns, tool usage, and budget transitions for debugging and operations.

Beyond enforcement, the plugin monitors for problems as they develop:

- **Burn rate anomaly detection** catches runaway tool loops — if spending spikes 3x above the session average, `onBurnRateAnomaly` fires immediately
- **Predictive exhaustion warnings** estimate when budget will run out and fire `onExhaustionForecast` before it happens
- **Automatic retry with backoff** on transient Cycles server errors (429/503) prevents spurious denials under load
- **Reservation heartbeat** auto-extends long-running tool reservations so cost tracking doesn't silently break
- **Observability** via `metricsEmitter` (Datadog, Prometheus, Grafana, OTLP) and opt-in session event logs

In typical OpenClaw setups, you can add enforcement without changing agent logic.

> For deeper background, see [Why Rate Limits Are Not Enough](https://runcycles.io/concepts/why-rate-limits-are-not-enough-for-autonomous-systems) and [Runaway Agents and Tool Loops](https://runcycles.io/incidents/runaway-agents-tool-loops-and-budget-overruns-the-incidents-cycles-is-designed-to-prevent).

## Overview

A comprehensive OpenClaw plugin that integrates with a live Cycles server to enforce budget boundaries during agent execution. It hooks into the OpenClaw plugin lifecycle to:

- **Reserve budget for model and tool calls** using the reserve → commit → release protocol
- **Downgrade models** when budget is low (configurable fallback chains)
- **Block execution** when budget is exhausted (fail-closed by default)
- **Inject budget hints** into prompts so the model is budget-aware
- **Detect budget transitions** and fire callbacks/webhooks on level changes
- **Control tool access** with allowlists, blocklists, and per-tool call limits
- **Apply graceful degradation** strategies when budget is low
- **Retry denied reservations** and transient server errors with configurable backoff
- **Keep long-running tools alive** with automatic reservation heartbeat
- **Detect anomalies** — burn rate spikes and predictive exhaustion warnings
- **Emit metrics** to Datadog, Prometheus, Grafana, or any OTLP-compatible backend
- **Record an event log** of every budget decision for debugging and compliance
- **Report unconfigured tools** so you know which tools are using default cost estimates
- **Support dry-run mode** for testing without a live Cycles server
- **Track per-tool cost breakdowns** and session analytics with model cost reconciliation
- **Support multi-currency** budgets with per-tool/model overrides
- **Support budget pools/hierarchies** via parent budget visibility

The plugin uses the [`runcycles`](https://github.com/runcycles/cycles-client-typescript) TypeScript client to communicate with a Cycles server.

> **Important:** Budget exhaustion is enforced fail-closed by default, but Cycles server connectivity failures are handled fail-open — the plugin assumes healthy budget and allows execution to continue. See [Fail-Open Behavior](#fail-open-behavior) for details.

## Prerequisites

- **OpenClaw** >= 0.1.0 with plugin support
- **Node.js** >= 20.0.0
- A running **Cycles server** with:
  - A base URL (e.g. `http://localhost:7878`)
  - An API key
  - A tenant configured with a budget scope

If you don't have a Cycles server yet, see the [Cycles quickstart](https://github.com/runcycles) to set one up. Alternatively, use **dry-run mode** to test without a server.

> To see budget enforcement in action before wiring up your own agent, run the [Cycles Runaway Demo](https://github.com/runcycles/cycles-runaway-demo) — it shows the exact failure mode this plugin prevents, with a live before/after comparison.

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
openclaw plugins enable openclaw-budget-guard
```

### 3. Add minimal configuration

Add the following to your OpenClaw config file (typically `openclaw.json` or `openclaw.config.json`):

```json
{
  "plugins": {
    "entries": {
      "openclaw-budget-guard": {
        "config": {
          "cyclesBaseUrl": "http://localhost:7878",
          "cyclesApiKey": "cyc_your_api_key_here",
          "tenant": "my-org"
        }
      }
    }
  }
}
```

That's it — the plugin uses sensible defaults for everything else. The agent will now enforce budget limits on every run.

> **Need an API key?** API keys are created via the Cycles Admin Server (port 7979). See the [deployment guide](https://runcycles.io/quickstart/deploying-the-full-cycles-stack#step-3-create-an-api-key) to create one, or see [API Key Management](https://runcycles.io/how-to/api-key-management-in-cycles) for details.

### 4. (Optional) Keep secrets out of config files

Use OpenClaw's env var interpolation to avoid hardcoding API keys:

```json
{
  "plugins": {
    "entries": {
      "openclaw-budget-guard": {
        "config": {
          "cyclesBaseUrl": "${CYCLES_BASE_URL}",
          "cyclesApiKey": "${CYCLES_API_KEY}",
          "tenant": "my-org"
        }
      }
    }
  }
}
```

Then set the env vars in your shell or CI:

```bash
export CYCLES_BASE_URL="http://localhost:7878"
export CYCLES_API_KEY="cyc_your_api_key_here"
```

### 5. (Optional) Try dry-run mode

To test without a live Cycles server:

```json
{
  "plugins": {
    "entries": {
      "openclaw-budget-guard": {
        "config": {
          "tenant": "my-org",
          "cyclesBaseUrl": "http://unused",
          "cyclesApiKey": "unused",
          "dryRun": true,
          "dryRunBudget": 100000000
        }
      }
    }
  }
}
```

### 6. Verify it's working

After restarting OpenClaw, check the logs for:

```
  Cycles Budget Guard for OpenClaw v0.6.1
  https://runcycles.io
  tenant: my-org
  cyclesBaseUrl: http://localhost:7878
  ...
```

Run your agent and look for budget activity:

```
[openclaw-budget-guard] before_model_resolve: model=claude-sonnet-4-20250514 level=healthy
```

If you see this, the plugin is actively checking budget on every model and tool call.

## Understanding the cost model

The plugin uses a simple model: every model call and tool call reserves a fixed cost from the budget.

**Currency.** The default is `USD_MICROCENTS` — 1 unit = $0.00001 (one hundred-thousandth of a dollar). So:

| Amount (units) | USD equivalent |
|----------------|---------------|
| 100,000 | $0.001 (0.1 cents) |
| 1,000,000 | $0.01 (1 cent) |
| 10,000,000 | $0.10 (10 cents) |
| 100,000,000 | $1.00 |

**Example.** With a $5 budget (500,000,000 units):
- `claude-opus` at 1,500,000/call = ~333 calls before exhaustion
- `claude-sonnet` at 300,000/call = ~1,666 calls
- `web_search` at 500,000/call = ~1,000 calls
- `lowBudgetThreshold: 10000000` triggers model downgrade when $0.10 remains

**Setting toolBaseCosts.** Start with the default (100,000 units per call). After your first session, check the `unconfiguredTools` list in the session summary — it tells you which tools need explicit costs. For tools that call external APIs, estimate higher (500K-1M). For lightweight tools, estimate lower (10K-50K).

## Full Configuration Example

```json
{
  "plugins": {
    "entries": {
      "openclaw-budget-guard": {
        "config": {
          "enabled": true,
          "cyclesBaseUrl": "http://localhost:7878",
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
          "toolCallLimits": {
            "send_email": 10,
            "deploy": 3
          },
          "injectPromptBudgetHint": true,
          "maxPromptHintChars": 200,
          "failClosed": true,
          "logLevel": "info",
          "reservationTtlMs": 60000,
          "overagePolicy": "ALLOW_IF_AVAILABLE",
          "lowBudgetStrategies": ["downgrade_model"],
          "maxTokensWhenLow": 1024,
          "retryOnDeny": false,
          "dryRun": false
        }
      }
    }
  }
}
```

## Config Presets

Common starting configurations for typical deployment scenarios.

### Strict Enforcement

For production agents handling real spend. Blocks on exhaustion, downgrades models, caps tool calls:

```json
{
  "plugins": {
    "entries": {
      "openclaw-budget-guard": {
        "config": {
          "tenant": "my-org",
          "failClosed": true,
          "lowBudgetStrategies": ["downgrade_model", "disable_expensive_tools", "limit_remaining_calls"],
          "modelFallbacks": {
            "claude-opus-4-20250514": ["claude-sonnet-4-20250514", "claude-haiku-4-5-20251001"]
          },
          "modelBaseCosts": {
            "claude-opus-4-20250514": 1500000,
            "claude-sonnet-4-20250514": 300000,
            "claude-haiku-4-5-20251001": 100000
          },
          "toolBaseCosts": {
            "web_search": 500000,
            "code_execution": 1000000
          },
          "toolCallLimits": {
            "send_email": 10,
            "deploy": 3
          },
          "maxRemainingCallsWhenLow": 5
        }
      }
    }
  }
}
```

### Development / Testing

Dry-run mode with generous budget. No Cycles server needed:

```json
{
  "plugins": {
    "entries": {
      "openclaw-budget-guard": {
        "config": {
          "tenant": "dev",
          "cyclesBaseUrl": "http://unused",
          "cyclesApiKey": "unused",
          "dryRun": true,
          "dryRunBudget": 500000000,
          "logLevel": "debug"
        }
      }
    }
  }
}
```

### Cost-Conscious

Aggressive cost savings. Low thresholds, model downgrade with token limits, expensive tools disabled early:

```json
{
  "plugins": {
    "entries": {
      "openclaw-budget-guard": {
        "config": {
          "tenant": "my-org",
          "lowBudgetThreshold": 5000000,
          "exhaustedThreshold": 100000,
          "lowBudgetStrategies": ["downgrade_model", "reduce_max_tokens", "disable_expensive_tools"],
          "maxTokensWhenLow": 512,
          "expensiveToolThreshold": 200000,
          "modelFallbacks": {
            "claude-opus-4-20250514": "claude-haiku-4-5-20251001",
            "gpt-4o": "gpt-4o-mini"
          }
        }
      }
    }
  }
}
```

## Configure for your use case

Most users only need 5-10 config properties. Start with what you need:

**I just want to stop runaway agents** (3 required fields only):
```json
{ "tenant": "my-org", "cyclesBaseUrl": "...", "cyclesApiKey": "..." }
```
The defaults (`failClosed: true`, `lowBudgetThreshold: 10000000`) will block agents that exhaust their budget and warn when it gets low.

**I want cost-aware model selection** — add:
```json
{
  "modelFallbacks": { "claude-opus-4-20250514": ["claude-sonnet-4-20250514", "claude-haiku-4-5-20251001"] },
  "modelBaseCosts": { "claude-opus-4-20250514": 1500000, "claude-sonnet-4-20250514": 300000, "claude-haiku-4-5-20251001": 100000 }
}
```

**I want to cap dangerous tool calls** — add:
```json
{ "toolCallLimits": { "send_email": 10, "deploy": 3, "delete_data": 1 } }
```

**I want observability** — add:
```json
{ "otlpMetricsEndpoint": "http://localhost:4318/v1/metrics" }
```

**I want to catch runaway loops** — add:
```json
{ "burnRateAlertThreshold": 3.0, "onBurnRateAnomaly": "..." }
```

**I want full debugging** — add:
```json
{ "enableEventLog": true, "logLevel": "debug" }
```

## Config Reference

### Core Settings

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Master switch — set to `false` to disable the plugin |
| `cyclesBaseUrl` | string | — | Cycles server URL (required) |
| `cyclesApiKey` | string | — | Cycles API key (required) |
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
| `toolCallLimits` | object | — | Map: tool name → max invocations per session (e.g. `{"send_email": 10}`) |

### Prompt Hints

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `injectPromptBudgetHint` | boolean | `true` | Inject budget status into the system prompt |
| `maxPromptHintChars` | number | `200` | Max characters for the injected budget hint |

### Reservation Settings

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `reservationTtlMs` | number | `60000` | Default TTL for tool reservations (ms) |
| `overagePolicy` | string | `ALLOW_IF_AVAILABLE` | Default overage policy (`REJECT`, `ALLOW_IF_AVAILABLE`, `ALLOW_WITH_OVERDRAFT`) |
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

### Model Cost Reconciliation (v0.5.0)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `modelCostEstimator` | function | — | Callback `(ctx: { model, estimatedCost, turnIndex }) => number | undefined` to reconcile model cost at commit time |

### Observability (v0.5.0)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `metricsEmitter` | object | — | Object with `gauge`/`counter`/`histogram` methods for observability pipeline integration |
| `aggressiveCacheInvalidation` | boolean | `true` | Proactively refetch budget snapshot after every commit/release for fresher data |
| `otlpMetricsEndpoint` | string | — | OTLP HTTP endpoint for auto metrics export (e.g. `http://localhost:4318/v1/metrics`) |
| `otlpMetricsHeaders` | object | — | Custom HTTP headers for OTLP requests |

### Resilience (v0.6.0)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `heartbeatIntervalMs` | number | `30000` | Interval for auto-extending long-running tool reservations (ms). Set 0 to disable. |
| `retryableStatusCodes` | number[] | `[429, 503, 504]` | HTTP status codes that trigger automatic retry with exponential backoff |
| `transientRetryMaxAttempts` | number | `2` | Max retry attempts for transient Cycles server errors |
| `transientRetryBaseDelayMs` | number | `500` | Base delay for exponential backoff on retries (ms) |

### Anomaly Detection (v0.6.0)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `burnRateWindowMs` | number | `60000` | Time window for burn rate anomaly detection (ms) |
| `burnRateAlertThreshold` | number | `3.0` | Alert when current window burn rate exceeds this multiple of the previous window |
| `onBurnRateAnomaly` | function | — | Callback `(event: BurnRateAnomalyEvent) => void` on burn rate spike |
| `exhaustionWarningThresholdMs` | number | `120000` | Warn when estimated time-to-exhaustion drops below this (ms) |
| `onExhaustionForecast` | function | — | Callback `(event: ExhaustionForecastEvent) => void` on exhaustion forecast |

### Debugging (v0.6.0)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enableEventLog` | boolean | `false` | Record every reserve/commit/deny/block decision in `sessionSummary.eventLog` |

## How It Works

### Budget Levels

| Level | Condition | What Happens |
|-------|-----------|--------------|
| **healthy** | `remaining > lowBudgetThreshold` | Pass through — no intervention |
| **low** | `exhaustedThreshold < remaining <= lowBudgetThreshold` | Apply low-budget strategies, inject warnings |
| **exhausted** | `remaining <= exhaustedThreshold` | Block execution (`failClosed=true`) or warn (`failClosed=false`) |

### Hook: `before_model_resolve`

Fetches budget state and reserves budget for the model call. The reservation is held open and committed later (in `before_prompt_build` or at `agent_end`), allowing the optional `modelCostEstimator` callback to reconcile estimated vs actual costs. When budget is low:
- Applies model fallbacks (including chained fallbacks like `opus → [sonnet, haiku]`)
- Enforces `limit_remaining_calls` if configured
- Attaches budget status metadata to `ctx.metadata["openclaw-budget-guard-status"]`

When budget is exhausted and `failClosed=true`, the plugin blocks the model call by overriding the model name to `__cycles_budget_exhausted__`, which causes the LLM provider to reject the request. The user sees "Unknown model: openai/cycles_budget_exhausted" — this is intentional. OpenClaw's `before_model_resolve` hook does not support `{ block: true }` like `before_tool_call` does ([feature request](https://github.com/openclaw/openclaw/issues/55771)), so this workaround is the only way to prevent model execution when budget runs out.

### Hook: `before_prompt_build`

Commits any pending model reservation from the previous turn (with `modelCostEstimator` reconciliation if configured). When `injectPromptBudgetHint` is enabled, injects a system context hint with:
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
5. Attaches summary to `ctx.metadata["openclaw-budget-guard"]`

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

### Tool Call Limits

Cap the number of times a specific tool can be invoked per session. Useful for consequential actions like sending emails or triggering deployments:

```json
{
  "toolCallLimits": {
    "send_email": 10,
    "deploy": 3
  }
}
```

Once a tool reaches its limit, further calls are blocked with a descriptive reason. Tools without a limit are unrestricted. Limits reset on each new agent session.

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

- **`BudgetExhaustedError`** (`code: "BUDGET_EXHAUSTED"`) — thrown when budget is exhausted and `failClosed=true`. Includes `remaining`, `tenant`, and `budgetId` properties. The error message includes an actionable hint to increase budget via the Cycles API.
- **`ToolBudgetDeniedError`** (`code: "TOOL_BUDGET_DENIED"`) — available as a structured error type for tool denials. Includes `toolName` property.

### Fail-Open Behavior

- If the Cycles server is **unreachable**, the plugin assumes healthy budget (fail-open)
- If a **commit fails**, execution continues (logged but non-blocking)
- `failClosed` only controls behavior when budget is **confirmed exhausted**

## Troubleshooting

**"Skipping registration" warning during install**
- This is normal. OpenClaw loads the plugin during install before your config is written. The plugin detects the missing config, logs a warning, and skips registration. After you add your config and restart the gateway, the plugin will register normally.

**Plugin not loading**
- Verify the plugin is enabled: `openclaw plugins list`
- Check that `openclaw.plugin.json` is included in the installed package

**"Unknown model: openai/\_\_cycles\_budget\_exhausted\_\_" or "Budget exhausted"**

Your budget has run out. To resume:

1. **Fund the budget** via the Cycles Admin API:
   ```bash
   curl -X POST "http://localhost:7979/v1/admin/budgets/fund?scope=tenant:my-org&unit=USD_MICROCENTS" \
     -H "X-Cycles-API-Key: your-admin-key" \
     -H "Content-Type: application/json" \
     -d '{"operation": "CREDIT", "amount": 50000000, "idempotency_key": "topup-001"}'
   ```
   This adds 50,000,000 units ($0.50) to the budget. Adjust the `scope` to match your `tenant` (and `budgetId` if set).

2. **Start a new agent session** — the plugin fetches fresh budget state at the start of each session.

For details on budget management, see [Budget Allocation and Management](https://runcycles.io/how-to/budget-allocation-and-management-in-cycles).

**"cyclesBaseUrl is required" error**
- Set `cyclesBaseUrl` in your plugin config (use `"${CYCLES_BASE_URL}"` for env var interpolation)

**Budget always shows "healthy"**
- Verify `currency`, `tenant`, and `budgetId` match your Cycles setup
- Set `logLevel: "debug"` to see raw balance responses

**Tools not being blocked**
- Check `toolBaseCosts` includes your tool (default cost is 100,000 units)
- Check `failClosed` is `true` (default)

**Model not being downgraded**
- The exact model name must match a key in `modelFallbacks`
- Check model costs in `modelBaseCosts` — fallback must be cheaper than remaining budget

## Production checklist

Before deploying to production:

- [ ] API key stored as env var (`CYCLES_API_KEY`), not in config file
- [ ] `failClosed: true` (default — blocks on exhausted budget)
- [ ] `dryRun: false` (default — uses real Cycles server)
- [ ] `modelBaseCosts` set for each model your agent uses
- [ ] `toolBaseCosts` set for at least your top 5 tools by usage
- [ ] `toolCallLimits` set for dangerous tools (`send_email`, `deploy`, etc.)
- [ ] `lowBudgetThreshold` calibrated for your session duration (default 10M = $0.10)
- [ ] Budget transition monitoring via `onBudgetTransition` callback or `budgetTransitionWebhookUrl`
- [ ] Session analytics via `onSessionEnd` callback or `analyticsWebhookUrl`
- [ ] Run one test session with `logLevel: "debug"` and `enableEventLog: true` to verify costs

## Known Limitations

| Limitation | Impact | Workaround |
|---|---|---|
| **Model cost is estimated by default.** OpenClaw has no `after_model_resolve` hook, so model costs are based on `modelBaseCosts` estimates. The `modelCostEstimator` callback can reconcile costs if you have a proxy or gateway with token counts. | Cost tracking for models is approximate unless you provide a `modelCostEstimator`. The plugin will never *overspend* — it may *under-track* slightly. | Use `modelCostEstimator` to reconcile costs. Or buffer `modelBaseCosts` estimates 10–20% higher than expected. |
| **`ALLOW_WITH_CAPS` decisions are not enforced.** If the Cycles server returns caps (max_tokens, tool allowlist) alongside an ALLOW decision, the plugin stores them but does not apply them downstream. | Low risk — v0 Cycles servers rarely return caps. | Monitor Cycles protocol updates. |
| **Per-user/session scoping uses custom dimensions.** User and session IDs are passed as `dimensions.user` / `dimensions.session` in the reservation subject. v0 Cycles servers may ignore custom dimensions for balance filtering. | Per-user budget isolation depends on server support for dimensions. | Verify scoping works with your Cycles server version before relying on it in production. |
| **Heartbeat requires client support.** Reservation auto-extension (`heartbeatIntervalMs`) calls `client.extendReservation()`. If the Cycles client does not implement this method, heartbeats are silently skipped. | Long-running tools may still lose cost tracking if the client lacks `extendReservation`. | Use per-tool TTL overrides via `toolReservationTtls` as fallback. |
| **Model blocking uses a provider-error workaround.** OpenClaw's `before_model_resolve` hook does not support `{ block: true }` ([feature request](https://github.com/openclaw/openclaw/issues/55771)). When budget is exhausted, the plugin overrides the model to `__cycles_budget_exhausted__`, causing the provider to reject the call. The user sees "Unknown model" instead of a clean budget error. | Model calls are effectively blocked, but the error message is a provider error rather than a budget message. Tool blocking via `before_tool_call` works cleanly with `{ block: true }`. | Pending OpenClaw adding `block` support to `before_model_resolve`. |
| **OpenClaw does not pass model name in hook events.** The `before_model_resolve` event only contains `{ prompt }` — no model name ([feature request](https://github.com/openclaw/openclaw/issues/55771)). The plugin auto-detects the model from system config or falls back to `defaultModelName`. | Model-specific cost tracking requires `defaultModelName` to be set in plugin config. | Set `defaultModelName` to your agent's model (e.g. `"openai/gpt-5-nano"`). |

For project structure, architecture diagrams, and development workflow, see [ARCHITECTURE.md](./ARCHITECTURE.md).
## Documentation

- [Cycles Documentation](https://runcycles.io) — full docs site
- [OpenClaw Integration Guide](https://runcycles.io/how-to/integrating-cycles-with-openclaw) — detailed integration guide
- [API Key Management](https://runcycles.io/how-to/api-key-management-in-cycles) — creating and managing API keys

## License

Apache-2.0
