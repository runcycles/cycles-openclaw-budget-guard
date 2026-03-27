# Architecture & Development

Internal design details, project structure, and development workflow for contributors.

## Project Structure

```
cycles-openclaw-budget-guard/
├── openclaw.plugin.json         # Plugin manifest with configSchema and extensions
├── package.json                 # npm package with openclaw.extensions
├── tsconfig.json                # TypeScript configuration
├── tsup.config.ts               # Build configuration (ESM output)
├── vitest.config.ts             # Test runner configuration with v8 coverage
├── LICENSE                      # Apache-2.0
├── README.md                    # User-facing documentation
├── ARCHITECTURE.md              # This file
├── FEATURE_GAPS.md              # Analysis of 18 identified feature gaps
├── IMPLEMENTATION_PLAN.md       # 5-phase implementation plan
├── AUDIT.md                     # Code audit and correctness review
├── src/
│   ├── index.ts                 # Plugin entrypoint — exports types and default function
│   ├── types.ts                 # Config, event, snapshot, and error type definitions
│   ├── config.ts                # Config validation with defaults and env-var fallbacks
│   ├── logger.ts                # Leveled logger with [openclaw-budget-guard] prefix
│   ├── cycles.ts                # Wrappers around runcycles CyclesClient
│   ├── budget.ts                # Budget classification, hint formatting, tool permissions
│   ├── hooks.ts                 # All 5 hook implementations with reservation tracking
│   ├── metrics-otlp.ts          # Lightweight OTLP HTTP metrics adapter
│   └── dry-run.ts               # In-memory simulated Cycles client for dry-run mode
└── tests/
    ├── helpers.ts               # Shared test utilities (makeConfig, makeSnapshot, etc.)
    ├── hooks.test.ts            # Hook implementation tests
    ├── budget.test.ts           # Budget classification and hint formatting tests
    ├── config.test.ts           # Config resolution and validation tests
    ├── cycles.test.ts           # Cycles API wrapper tests
    ├── dry-run.test.ts          # DryRunClient simulation tests
    ├── logger.test.ts           # Logger level filtering tests
    ├── index.test.ts            # Plugin entrypoint export tests
    ├── metrics-otlp.test.ts     # OTLP adapter tests
    └── types.test.ts            # Error class and type tests
```

## Architecture

```
OpenClaw Runtime
  │
  ├─ before_model_resolve ──→ hooks.ts ──→ cycles.ts (reserve) ──→ Cycles Server
  │                                     └→ budget.ts (classify, fallbacks)
  │
  ├─ before_prompt_build  ──→ hooks.ts ──→ cycles.ts (commit pending model)
  │                                     └→ budget.ts (formatHint + forecast)
  │
  ├─ before_tool_call     ──→ hooks.ts ──→ budget.ts (isToolPermitted)
  │                                     └→ cycles.ts (createReservation) ──→ Cycles Server
  │
  ├─ after_tool_call      ──→ hooks.ts ──→ cycles.ts (commitReservation) ──→ Cycles Server
  │                                     └→ costEstimator callback (if configured)
  │
  └─ agent_end            ──→ hooks.ts ──→ cycles.ts (commit model + releaseReservation) ──→ Cycles Server
                                        └→ onSessionEnd callback / analytics webhook
```

In dry-run mode, `Cycles Server` is replaced by the in-memory `DryRunClient`.

## Local Development

> **Note:** These commands are for developing the plugin itself. End users install via `openclaw plugins install` (see [Quick Start](./README.md#quick-start)).

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
- Triggers on `v*` tags (e.g. `v0.1.0`, `v0.6.0`)
- Runs the full build pipeline first
- Publishes to npm with `--provenance --access public`
- Requires the `NPM_TOKEN` secret in repository settings

After publishing, users install via:

```bash
openclaw plugins install @runcycles/openclaw-budget-guard
```
