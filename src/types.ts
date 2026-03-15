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
  modelFallbacks: Record<string, string>;
  toolBaseCosts: Record<string, number>;
  injectPromptBudgetHint: boolean;
  maxPromptHintChars: number;
  failClosed: boolean;
  logLevel: "debug" | "info" | "warn" | "error";
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
}

// ---------------------------------------------------------------------------
// Reservation tracking
// ---------------------------------------------------------------------------

export interface ActiveReservation {
  reservationId: string;
  estimate: number;
  toolName: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// OpenClaw plugin API types
//
// These types represent the OpenClaw plugin registration API.
// Plugins export a default function receiving the api object, and register
// hooks via api.on(hookName, handler, opts).
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
  /** Plugin configuration from the OpenClaw config file. */
  config: Record<string, unknown>;
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

  constructor(remaining: number) {
    super(
      `Budget exhausted (remaining: ${remaining}). Execution blocked by cycles-openclaw-budget-guard.`,
    );
    this.name = "BudgetExhaustedError";
    this.remaining = remaining;
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
