/** Plugin configuration, OpenClaw hook event types, and internal state types. */

// ---------------------------------------------------------------------------
// Plugin config
// ---------------------------------------------------------------------------

export interface BudgetGuardConfig {
  enabled: boolean;
  cyclesBaseUrl: string;
  cyclesApiKey: string;
  tenant: string;
  budgetId?: string;
  currency: string;
  defaultModelActionKind: string;
  defaultToolActionKindPrefix: string;
  lowBudgetThreshold: number;
  exhaustedThreshold: number;
  modelFallbacks: Record<string, string | string[]>;
  toolBaseCosts: Record<string, number>;
  injectPromptBudgetHint: boolean;
  maxPromptHintChars: number;
  failClosed: boolean;
  logLevel: "debug" | "info" | "warn" | "error";

  // Phase 1 — Gap 1: LLM call reservations
  modelBaseCosts: Record<string, number>;
  defaultModelCost: number;

  // Phase 1 — Gap 2: Actual cost tracking
  costEstimator?: (context: CostEstimatorContext) => number | undefined;

  // Phase 1 — Gap 3: Per-user/session scoping
  userId?: string;
  sessionId?: string;

  // Phase 1 — Gap 8: Configurable reservation TTL
  reservationTtlMs: number;
  toolReservationTtls?: Record<string, number>;

  // Phase 1 — Gap 11: Configurable snapshot cache TTL
  snapshotCacheTtlMs: number;

  // Phase 1 — Gap 16: Overage policy config
  overagePolicy: string;
  toolOveragePolicies?: Record<string, string>;

  // Phase 2 — Gap 5: Budget transition alerts
  onBudgetTransition?: (event: BudgetTransitionEvent) => void;
  budgetTransitionWebhookUrl?: string;

  // Phase 2 — Gap 7: Tool allowlist/blocklist
  toolAllowlist?: string[];
  toolBlocklist?: string[];

  // Phase 3 — Gap 13: Graceful degradation strategies
  lowBudgetStrategies: string[];
  maxTokensWhenLow: number;
  expensiveToolThreshold?: number;
  maxRemainingCallsWhenLow: number;

  // Phase 3 — Gap 17: Retry on denied tool calls
  retryOnDeny: boolean;
  retryDelayMs: number;
  maxRetries: number;

  // Phase 4 — Gap 10: Dry-run mode
  dryRun: boolean;
  dryRunBudget: number;

  // Phase 4 — Gap 15: Cross-session analytics
  onSessionEnd?: (summary: SessionSummary) => void | Promise<void>;
  analyticsWebhookUrl?: string;

  // Phase 5 — Gap 14: Multi-currency
  toolCurrencies?: Record<string, string>;
  modelCurrency?: string;

  // Phase 5 — Gap 18: Budget pools
  parentBudgetId?: string;

  // Per-tool invocation limits per session
  toolCallLimits?: Record<string, number>;

  // v0.5.0 — Model cost reconciliation
  modelCostEstimator?: (context: ModelCostEstimatorContext) => number | undefined;

  // v0.5.0 — Metrics emitter for observability pipelines
  metricsEmitter?: MetricsEmitter;

  // v0.5.0 — Aggressive cache invalidation (refetch after every mutation)
  aggressiveCacheInvalidation: boolean;

  // v0.5.0 — OTLP metrics endpoint (auto-creates emitter if metricsEmitter not set)
  otlpMetricsEndpoint?: string;
  otlpMetricsHeaders?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Budget state
// ---------------------------------------------------------------------------

export type BudgetLevel = "healthy" | "low" | "exhausted";

export interface BudgetSnapshot {
  remaining: number;
  reserved: number;
  spent: number;
  allocated?: number;
  level: BudgetLevel;
  // Phase 5 — Gap 18: Pool balance
  poolRemaining?: number;
  poolAllocated?: number;
}

// ---------------------------------------------------------------------------
// Reservation tracking
// ---------------------------------------------------------------------------

export interface ActiveReservation {
  reservationId: string;
  estimate: number;
  toolName: string;
  createdAt: number;
  kind: "model" | "tool";
  currency?: string;
}

// ---------------------------------------------------------------------------
// Cost estimator context (Gap 2)
// ---------------------------------------------------------------------------

export interface CostEstimatorContext {
  toolName: string;
  estimate: number;
  durationMs?: number;
  result?: unknown;
}

// ---------------------------------------------------------------------------
// Model cost estimator context (v0.5.0)
// ---------------------------------------------------------------------------

export interface ModelCostEstimatorContext {
  model: string;
  estimatedCost: number;
  turnIndex: number;
}

// ---------------------------------------------------------------------------
// StandardMetrics for Cycles commit payloads (v0.5.0)
// ---------------------------------------------------------------------------

export interface StandardMetrics {
  tokens_input?: number;
  tokens_output?: number;
  latency_ms?: number;
  model_version?: string;
  custom?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// MetricsEmitter for observability pipelines (v0.5.0)
// ---------------------------------------------------------------------------

export interface MetricsEmitter {
  gauge(name: string, value: number, tags?: Record<string, string>): void;
  counter(name: string, delta: number, tags?: Record<string, string>): void;
  histogram(name: string, value: number, tags?: Record<string, string>): void;
}

// ---------------------------------------------------------------------------
// Budget transition event (Gap 5)
// ---------------------------------------------------------------------------

export interface BudgetTransitionEvent {
  previousLevel: BudgetLevel;
  currentLevel: BudgetLevel;
  remaining: number;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Budget status metadata for end-user visibility (Gap 12)
// ---------------------------------------------------------------------------

export interface BudgetStatusMetadata {
  level: BudgetLevel;
  remaining: number;
  allocated?: number;
  percentRemaining?: number;
}

// ---------------------------------------------------------------------------
// Session summary (Gap 15)
// ---------------------------------------------------------------------------

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
  /** Per-tool invocation counts for the session. */
  toolCallCounts: Record<string, number>;
  startedAt: number;
  endedAt: number;
}

// ---------------------------------------------------------------------------
// OpenClaw plugin API types
// ---------------------------------------------------------------------------

/** Logger provided by the OpenClaw runtime via api.logger. */
export interface OpenClawLogger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

/** The api object passed to the plugin's default export function. */
export interface OpenClawPluginApi {
  /** Register a hook handler. */
  on(
    hookName: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (...args: any[]) => any,
    opts?: { priority?: number; name?: string },
  ): void;
  /** Full system configuration snapshot. */
  config: Record<string, unknown>;
  /** Plugin-specific config from plugins.entries.<id>.config. */
  pluginConfig?: Record<string, unknown>;
  /** Runtime logger. */
  logger: OpenClawLogger;
}

// ---------------------------------------------------------------------------
// OpenClaw hook event types (approximated from OpenClaw docs)
// ---------------------------------------------------------------------------

/** Event for the before_model_resolve hook. */
export interface ModelResolveEvent {
  model: string;
  [key: string]: unknown;
}

/** Return value from before_model_resolve to override the model. */
export interface ModelResolveResult {
  modelOverride?: string;
}

/** Event for the before_prompt_build hook. */
export interface PromptBuildEvent {
  [key: string]: unknown;
}

/** Return value from before_prompt_build to prepend system context. */
export interface PromptBuildResult {
  prependSystemContext?: string;
}

/** Event for the before_tool_call hook. */
export interface ToolCallEvent {
  toolName: string;
  toolCallId: string;
  params?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Return value from before_tool_call to block tool execution. */
export interface ToolCallResult {
  block?: boolean;
  blockReason?: string;
  params?: Record<string, unknown>;
}

/** Event for the after_tool_call hook. */
export interface ToolResultEvent {
  toolName: string;
  toolCallId: string;
  result?: unknown;
  durationMs?: number;
  [key: string]: unknown;
}

/** Event for the agent_end hook. */
export interface AgentEndEvent {
  [key: string]: unknown;
}

/** Context object available in hook handlers. */
export interface HookContext {
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Structured errors for budget exhaustion
// ---------------------------------------------------------------------------

export class BudgetExhaustedError extends Error {
  public readonly code = "BUDGET_EXHAUSTED";
  public readonly remaining: number;
  public readonly tenant?: string;
  public readonly budgetId?: string;

  constructor(remaining: number, opts?: { tenant?: string; budgetId?: string }) {
    const scope = [
      opts?.tenant ? `tenant=${opts.tenant}` : "",
      opts?.budgetId ? `budget=${opts.budgetId}` : "",
    ].filter(Boolean).join(", ");
    super(
      `Budget exhausted (remaining: ${remaining}${scope ? `, ${scope}` : ""}). ` +
      `Execution blocked by cycles-openclaw-budget-guard. ` +
      `To resume, increase the budget via the Cycles API or contact your admin.`,
    );
    this.name = "BudgetExhaustedError";
    this.remaining = remaining;
    this.tenant = opts?.tenant;
    this.budgetId = opts?.budgetId;
  }
}

export class ToolBudgetDeniedError extends Error {
  public readonly code = "TOOL_BUDGET_DENIED";
  public readonly toolName: string;

  constructor(toolName: string, reason?: string) {
    super(
      `Tool call "${toolName}" denied by budget guard${reason ? `: ${reason}` : ""}.`,
    );
    this.name = "ToolBudgetDeniedError";
    this.toolName = toolName;
  }
}
