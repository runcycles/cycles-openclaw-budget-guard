# cycles-openclaw-budget-guard

OpenClaw plugin for budget-aware model and tool execution using Cycles.

## What This Is (Phase 1)

A thin OpenClaw plugin that integrates with a live [Cycles](https://github.com/runcycles) server to enforce budget boundaries during agent execution. It hooks into the OpenClaw plugin lifecycle to:

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

## Project Structure

```
cycles-openclaw-budget-guard/
├── openclaw.plugin.json         # Plugin manifest with inline configSchema
├── package.json                 # npm package with openclaw.extensions
├── tsconfig.json
├── tsup.config.ts
└── src/
    ├── index.ts                 # Plugin entrypoint — exports register()
    ├── types.ts                 # Config interface, hook payload types, error classes
    ├── config.ts                # Config validation with defaults and env-var fallbacks
    ├── logger.ts                # Simple leveled logger ([cycles-budget-guard] prefix)
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

The plugin maintains an in-memory `Map<callId, ActiveReservation>` to track in-flight tool reservations between `before_tool_call` and `after_tool_call`. Budget state is cached for 5 seconds and invalidated after mutations.

## Installation

```bash
# Install locally
openclaw plugins install -l ./cycles-openclaw-budget-guard

# Enable the plugin
openclaw plugins enable cycles-openclaw-budget-guard
```

## Configuration

Add the plugin to your OpenClaw configuration:

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
        "failClosed": true,
        "logLevel": "info"
      }
    }
  }
}
```

Connection details can also be provided via environment variables:

- `CYCLES_BASE_URL` — fallback for `cyclesBaseUrl`
- `CYCLES_API_KEY` — fallback for `cyclesApiKey`

### Config Reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Master switch |
| `cyclesBaseUrl` | string | — | Cycles server URL (required) |
| `cyclesApiKey` | string | — | Cycles API key (required) |
| `tenant` | string | — | Cycles tenant (required) |
| `budgetId` | string | — | Optional budget scope (maps to app-level) |
| `currency` | string | `USD_MICROCENTS` | Budget unit |
| `defaultModelActionKind` | string | `llm.completion` | Action kind for model calls |
| `defaultToolActionKindPrefix` | string | `tool.` | Prefix for tool action kinds |
| `lowBudgetThreshold` | number | `10000000` | Remaining below this triggers model downgrade |
| `exhaustedThreshold` | number | `0` | Remaining at or below this blocks execution |
| `modelFallbacks` | object | `{}` | Map: expensive model → cheaper fallback model |
| `toolBaseCosts` | object | `{}` | Map: tool name → estimated cost in currency units |
| `injectPromptBudgetHint` | boolean | `true` | Inject budget status into system prompt |
| `maxPromptHintChars` | number | `200` | Max characters for budget hint |
| `failClosed` | boolean | `true` | Block on exhausted budget (false = warn and continue) |
| `logLevel` | string | `info` | `debug` / `info` / `warn` / `error` |

> **Note:** `exhaustedThreshold` must be strictly less than `lowBudgetThreshold`. The plugin validates this at startup.

## Behavior

### Budget Levels

The plugin classifies budget into three levels based on the remaining balance from the Cycles server:

| Level | Condition | Behavior |
|-------|-----------|----------|
| **healthy** | `remaining > lowBudgetThreshold` | Pass through — no intervention |
| **low** | `exhaustedThreshold < remaining <= lowBudgetThreshold` | Downgrade models via `modelFallbacks`, inject budget warning into prompts |
| **exhausted** | `remaining <= exhaustedThreshold` | Block execution (`failClosed=true`) or warn and continue (`failClosed=false`) |

### Hook: `before_model_resolve`

Fetches budget state from the Cycles `/v1/balances` endpoint. If budget is healthy, passes through. If low, checks `modelFallbacks` for a cheaper alternative and returns it. If exhausted and `failClosed` is true, throws `BudgetExhaustedError`.

### Hook: `before_prompt_build`

When `injectPromptBudgetHint` is enabled, injects a compact deterministic hint into the system prompt. Example output:

```
Budget: 5000000 USD_MICROCENTS remaining. Budget is low — prefer cheaper models and avoid expensive tools. 50% of budget remaining.
```

### Hook: `before_tool_call`

Looks up the tool's estimated cost from `toolBaseCosts` (falls back to a default of 100,000 units). Creates a Cycles reservation via `POST /v1/reservations`. If the reservation is denied (`DENY` decision), throws `ToolBudgetDeniedError` to block the tool call. Stores the reservation in an in-memory map for settlement in `after_tool_call`.

### Hook: `after_tool_call`

Commits the reserved amount as actual usage via `POST /v1/reservations/{id}/commit`. In phase 1, actual cost equals the estimate since there is no proxy to measure real token usage. Commit is best-effort — failures are logged but never thrown.

### Hook: `agent_end`

Releases any orphaned reservations (defensive cleanup), fetches final budget state, and logs a session summary including total spent, remaining balance, and number of reservations made. Attaches the summary to the context metadata.

### Error Types

The plugin throws two structured error types:

- **`BudgetExhaustedError`** (`code: "BUDGET_EXHAUSTED"`) — thrown by `before_model_resolve` when budget is exhausted and `failClosed` is true.
- **`ToolBudgetDeniedError`** (`code: "TOOL_BUDGET_DENIED"`) — thrown by `before_tool_call` when a reservation is denied by the Cycles server.

### Fail-Open Behavior

- If the Cycles server is unreachable during a balance check, the plugin assumes healthy budget (fail-open) to avoid blocking agents on transient infrastructure issues.
- If a commit fails in `after_tool_call`, the failure is logged but execution continues.
- The `failClosed` config only controls behavior when budget is **confirmed exhausted** — not when the budget service is down.

## Important Notes

- Most plugin config changes require **restarting the OpenClaw gateway**.
- Budget state is cached for 5 seconds to reduce API calls. The cache is invalidated after reservations and commits.
- Tool costs are estimates — without a proxy layer, exact token-level costs are not available in phase 1.
- This phase does not provide hard per-token LLM enforcement because there is no proxy/provider layer yet.

## Local Development

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

After publishing, devs can install via:

```bash
npm install @runcycles/openclaw-budget-guard
```

## License

Apache-2.0
