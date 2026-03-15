# cycles-openclaw-budget-guard

OpenClaw plugin for budget-aware model and tool execution using [Cycles](https://github.com/runcycles).

## What This Is (Phase 1)

A thin OpenClaw plugin that integrates with a live Cycles server to enforce budget boundaries during agent execution. It hooks into the OpenClaw plugin lifecycle to:

- **Downgrade models** when budget is low (configurable fallback map)
- **Block execution** when budget is exhausted (fail-closed by default)
- **Reserve budget** before tool calls and commit usage afterward
- **Inject budget hints** into prompts so the model is budget-aware
- **Emit a budget summary** at the end of each agent session

The plugin uses the [`runcycles`](https://github.com/runcycles/cycles-client-typescript) TypeScript client to communicate with a Cycles server via the reserve → commit → release protocol.

## What This Does Not Do (Yet)

- **No per-token LLM enforcement** — there is no proxy or provider layer. Token-level metering requires a gateway-level integration (planned for phase 2).
- **No streaming cost tracking** — tool costs are estimated upfront via the `toolBaseCosts` config map.
- **No multi-currency support** — a single `currency` unit is used for all reservations.

## Prerequisites

- **OpenClaw** >= 0.1.0 with plugin support
- **Node.js** >= 20.0.0
- A running **Cycles server** with:
  - A base URL (e.g. `https://cycles.example.com`)
  - An API key
  - A tenant configured with a budget scope

If you don't have a Cycles server yet, see the [Cycles quickstart](https://github.com/runcycles) to set one up.

## Quick Start

### 1. Install the plugin

```bash
openclaw plugins install @runcycles/openclaw-budget-guard
```

This fetches the package from npm, extracts it into `~/.openclaw/extensions/cycles-openclaw-budget-guard/`, and registers it with OpenClaw.

For local development, install from a checkout instead:

```bash
openclaw plugins install -l ./cycles-openclaw-budget-guard
```

### 2. Enable the plugin in OpenClaw

```bash
openclaw plugins enable cycles-openclaw-budget-guard
```

### 3. Add minimal configuration

Add the plugin to your OpenClaw configuration file (typically `openclaw.config.json` or the `plugins` section of your project config):

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

### 4. Verify it's working

Run an OpenClaw agent with `logLevel: "debug"` to see budget guard activity:

```json
{
  "plugins": {
    "entries": {
      "cycles-openclaw-budget-guard": {
        "cyclesBaseUrl": "https://cycles.example.com",
        "cyclesApiKey": "cyc_your_api_key_here",
        "tenant": "my-org",
        "logLevel": "debug"
      }
    }
  }
}
```

You should see log lines prefixed with `[cycles-budget-guard]`:

```
[cycles-budget-guard] Plugin initialized { tenant: 'my-org' }
[cycles-budget-guard] before_model_resolve: model=claude-sonnet-4-20250514 level=healthy
[cycles-budget-guard] before_prompt_build: injecting hint (142 chars)
[cycles-budget-guard] before_tool_call: tool=web_search callId=abc123 estimate=500000
[cycles-budget-guard] after_tool_call: committed 500000 for tool=web_search
[cycles-budget-guard] Agent session budget summary: { remaining: 9500000, spent: 500000, totalReservationsMade: 1 }
```

### 5. (Optional) Use environment variables for secrets

Instead of putting API credentials in your config file, set them as environment variables:

```bash
export CYCLES_BASE_URL="https://cycles.example.com"
export CYCLES_API_KEY="cyc_your_api_key_here"
```

Then your config only needs:

```json
{
  "plugins": {
    "entries": {
      "cycles-openclaw-budget-guard": {
        "tenant": "my-org"
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
          "claude-opus-4-20250514": "claude-sonnet-4-20250514",
          "gpt-4o": "gpt-4o-mini"
        },
        "toolBaseCosts": {
          "web_search": 500000,
          "code_execution": 1000000
        },
        "injectPromptBudgetHint": true,
        "maxPromptHintChars": 200,
        "failClosed": true,
        "logLevel": "info"
      }
    }
  }
}
```

### Config Reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Master switch — set to `false` to disable the plugin without removing config |
| `cyclesBaseUrl` | string | — | Cycles server URL (required, or set `CYCLES_BASE_URL` env var) |
| `cyclesApiKey` | string | — | Cycles API key (required, or set `CYCLES_API_KEY` env var) |
| `tenant` | string | — | Cycles tenant identifier (required) |
| `budgetId` | string | — | Optional budget scope — maps to app-level scope in Cycles |
| `currency` | string | `USD_MICROCENTS` | Budget unit used for all reservations |
| `defaultModelActionKind` | string | `llm.completion` | Action kind sent to Cycles for model calls |
| `defaultToolActionKindPrefix` | string | `tool.` | Prefix prepended to tool names to form the action kind |
| `lowBudgetThreshold` | number | `10000000` | Remaining budget below this triggers model downgrade |
| `exhaustedThreshold` | number | `0` | Remaining budget at or below this blocks execution |
| `modelFallbacks` | object | `{}` | Map: expensive model → cheaper fallback model |
| `toolBaseCosts` | object | `{}` | Map: tool name → estimated cost in currency units |
| `injectPromptBudgetHint` | boolean | `true` | Inject budget status into the system prompt |
| `maxPromptHintChars` | number | `200` | Max characters for the injected budget hint |
| `failClosed` | boolean | `true` | Block on exhausted budget (`false` = warn and continue) |
| `logLevel` | string | `info` | `debug` / `info` / `warn` / `error` |

> **Note:** `exhaustedThreshold` must be strictly less than `lowBudgetThreshold`. The plugin validates this at startup and throws an error if misconfigured.

## How It Works

### Budget Levels

The plugin classifies budget into three levels based on the remaining balance from the Cycles server:

| Level | Condition | What Happens |
|-------|-----------|--------------|
| **healthy** | `remaining > lowBudgetThreshold` | Pass through — no intervention |
| **low** | `exhaustedThreshold < remaining <= lowBudgetThreshold` | Downgrade models via `modelFallbacks`, inject budget warning into prompts |
| **exhausted** | `remaining <= exhaustedThreshold` | Block execution (`failClosed=true`) or warn and continue (`failClosed=false`) |

### Hook: `before_model_resolve`

Fetches budget state from the Cycles `/v1/balances` endpoint. If budget is healthy, passes through. If low, checks `modelFallbacks` for a cheaper alternative and returns `{ modelOverride }`. If exhausted and `failClosed` is true, throws `BudgetExhaustedError`.

### Hook: `before_prompt_build`

When `injectPromptBudgetHint` is enabled, returns `{ prependSystemContext }` with a compact deterministic hint. Example:

```
Budget: 5000000 USD_MICROCENTS remaining. Budget is low — prefer cheaper models and avoid expensive tools. 50% of budget remaining.
```

### Hook: `before_tool_call`

Looks up the tool's estimated cost from `toolBaseCosts` (defaults to 100,000 units if not configured). Creates a Cycles reservation via `POST /v1/reservations`. If the reservation is denied (`DENY` decision), returns `{ block: true, blockReason: "..." }` to block the tool call. Otherwise stores the reservation for settlement in `after_tool_call`.

### Hook: `after_tool_call`

Commits the reserved amount as actual usage via `POST /v1/reservations/{id}/commit`. In phase 1, actual cost equals the estimate since there is no proxy to measure real token usage. Commit is best-effort — failures are logged but never block execution.

### Hook: `agent_end`

Releases any orphaned reservations (defensive cleanup), fetches final budget state, and logs a session summary including total spent, remaining balance, and number of reservations made. Attaches the summary to `ctx.metadata["cycles-budget-guard"]`.

### Error Handling

The plugin defines two structured error types:

- **`BudgetExhaustedError`** (`code: "BUDGET_EXHAUSTED"`) — thrown by `before_model_resolve` when budget is exhausted and `failClosed` is true.
- **`ToolBudgetDeniedError`** (`code: "TOOL_BUDGET_DENIED"`) — available as a structured error type. The `before_tool_call` hook returns `{ block: true, blockReason }` to OpenClaw when a reservation is denied.

### Fail-Open Behavior

- If the Cycles server is **unreachable** during a balance check, the plugin assumes healthy budget (fail-open) to avoid blocking agents on transient infrastructure issues.
- If a **commit fails** in `after_tool_call`, the failure is logged but execution continues.
- The `failClosed` config only controls behavior when budget is **confirmed exhausted** — not when the budget service is down.

## Troubleshooting

**Plugin not loading**
- Verify the plugin is enabled: `openclaw plugins list` should show `cycles-openclaw-budget-guard` as enabled.
- Check that `openclaw.plugin.json` is included in the installed package.

**"cyclesBaseUrl is required" error at startup**
- Either set `cyclesBaseUrl` in the plugin config or export `CYCLES_BASE_URL` as an environment variable.
- Same applies to `cyclesApiKey` / `CYCLES_API_KEY`.

**"exhaustedThreshold must be less than lowBudgetThreshold" error**
- Check your threshold values. Default `lowBudgetThreshold` is `10000000` and `exhaustedThreshold` is `0`.

**Budget always shows "healthy" even when low**
- Verify the `currency` config matches the unit used in your Cycles budget scope.
- Verify the `tenant` and `budgetId` match your Cycles setup.
- Set `logLevel: "debug"` to see the raw balance response.

**Tools not being blocked when budget is exhausted**
- Tool blocking uses the Cycles reservation system. If `toolBaseCosts` doesn't include your tool, the default cost of 100,000 units is used.
- Check that `failClosed` is `true` (default).

**Model not being downgraded**
- The exact model name from the agent request must match a key in `modelFallbacks`. Check for version suffixes.

**Config changes not taking effect**
- Most plugin config changes require **restarting the OpenClaw gateway**.

## Important Notes

- Budget state is cached for **5 seconds** to reduce API calls. The cache is invalidated after reservations and commits.
- Tool costs are **estimates** — without a proxy layer, exact token-level costs are not available in phase 1.
- This phase does **not** provide hard per-token LLM enforcement because there is no proxy/provider layer yet.

## Project Structure

```
cycles-openclaw-budget-guard/
├── openclaw.plugin.json         # Plugin manifest with configSchema and extensions
├── package.json                 # npm package with openclaw.extensions
├── tsconfig.json
├── tsup.config.ts
└── src/
    ├── index.ts                 # Plugin entrypoint — exports default function(api)
    ├── types.ts                 # Config interface, OpenClaw API types, error classes
    ├── config.ts                # Config validation with defaults and env-var fallbacks
    ├── logger.ts                # Fallback leveled logger ([cycles-budget-guard] prefix)
    ├── cycles.ts                # Thin wrappers around runcycles CyclesClient
    ├── budget.ts                # Budget classification (healthy/low/exhausted) and hint formatting
    └── hooks.ts                 # All 5 hook implementations with reservation tracking
```

### Architecture

```
OpenClaw Runtime
  │
  ├─ before_model_resolve ──→ hooks.ts ──→ cycles.ts (getBalances) ──→ Cycles Server
  │                                     └→ budget.ts (classify)
  │
  ├─ before_prompt_build  ──→ hooks.ts ──→ budget.ts (formatHint)
  │
  ├─ before_tool_call     ──→ hooks.ts ──→ cycles.ts (createReservation) ──→ Cycles Server
  │
  ├─ after_tool_call      ──→ hooks.ts ──→ cycles.ts (commitReservation) ──→ Cycles Server
  │
  └─ agent_end            ──→ hooks.ts ──→ cycles.ts (releaseReservation) ──→ Cycles Server
```

## Local Development

> **Note:** These commands are for developing the plugin itself. End users install via `openclaw plugins install` (see [Quick Start](#quick-start)).

```bash
# Install dependencies
npm install

# Build
npm run build

# Type-check without emitting
npm run typecheck
```

Output is written to `dist/index.js` (ESM) with TypeScript declarations.

## CI & Publishing

CI runs automatically on push and pull requests to `main` (typecheck, build, verify).

To publish a new version to npm:

```bash
# Update version in package.json and openclaw.plugin.json
npm version patch   # or minor / major

# Push the tag — this triggers the publish workflow
git push origin main --follow-tags
```

The publish workflow:
- Triggers on `v*` tags (e.g. `v0.1.0`, `v0.2.0`)
- Runs the full build pipeline first
- Publishes to npm with `--provenance --access public`
- Requires the `NPM_TOKEN` secret to be set in the repository settings

After publishing, users install via the OpenClaw plugin manager:

```bash
openclaw plugins install @runcycles/openclaw-budget-guard
```

## License

Apache-2.0
