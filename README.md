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
| `lowBudgetThreshold` | number | `10000000` | Remaining below this = "low" |
| `exhaustedThreshold` | number | `0` | Remaining at or below this = "exhausted" |
| `modelFallbacks` | object | `{}` | Map: expensive model → cheaper model |
| `toolBaseCosts` | object | `{}` | Map: tool name → estimated cost |
| `injectPromptBudgetHint` | boolean | `true` | Inject budget status into prompt |
| `maxPromptHintChars` | number | `200` | Max chars for budget hint |
| `failClosed` | boolean | `true` | Block on exhausted budget |
| `logLevel` | string | `info` | `debug` / `info` / `warn` / `error` |

## Behavior

### Hook: `before_model_resolve`

Fetches budget state from Cycles. If budget is healthy, passes through. If low, downgrades the model using `modelFallbacks`. If exhausted and `failClosed` is true, throws a structured `BudgetExhaustedError`.

### Hook: `before_prompt_build`

Injects a compact budget hint into the system prompt (e.g., "Budget: 5000000 USD_MICROCENTS remaining. Budget is low — prefer cheaper models and avoid expensive tools.").

### Hook: `before_tool_call`

Estimates the tool cost from `toolBaseCosts` (or a default), then creates a Cycles reservation. If the reservation is denied (budget exceeded), the tool call is blocked with a `ToolBudgetDeniedError`.

### Hook: `after_tool_call`

Commits the reserved amount as actual usage. If commit fails, releases the reservation as a fallback. Never throws.

### Hook: `agent_end`

Releases any orphaned reservations, fetches final budget state, and logs a session summary.

## Important Notes

- Most plugin config changes require **restarting the OpenClaw gateway**.
- Budget state is cached for 5 seconds to reduce API calls. The cache is invalidated after reservations and commits.
- Tool costs are estimates — without a proxy layer, exact token-level costs are not available.

## Local Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Type-check without emitting
npm run typecheck
```

## License

Apache-2.0
