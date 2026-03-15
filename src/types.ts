/** Plugin configuration, OpenClaw hook payload types, and internal state types. */

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
// OpenClaw hook payload types (approximated)
//
// These types represent the expected shapes passed by the OpenClaw runtime.
// They may need minor adjustment depending on the exact OpenClaw version.
// ---------------------------------------------------------------------------

/** Payload for the before_model_resolve hook. */
export interface ModelResolveContext {
  /** The model identifier requested by the caller. */
  model: string;
  [key: string]: unknown;
}

/** Return value from before_model_resolve to override the model. */
export interface ModelResolveResult {
  model?: string;
}

/** A single message in the prompt message array. */
export interface PromptMessage {
  role: string;
  content: string;
  [key: string]: unknown;
}

/** Payload for the before_prompt_build hook. */
export interface PromptBuildContext {
  messages: PromptMessage[];
  [key: string]: unknown;
}

/** Payload for the before_tool_call hook. */
export interface ToolCallContext {
  tool: { name: string; [key: string]: unknown };
  callId: string;
  arguments?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Payload for the after_tool_call hook. */
export interface ToolResultContext {
  tool: { name: string; [key: string]: unknown };
  callId: string;
  result?: unknown;
  durationMs?: number;
  [key: string]: unknown;
}

/** Payload for the agent_end hook. */
export interface AgentEndContext {
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Structured error for budget exhaustion
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
