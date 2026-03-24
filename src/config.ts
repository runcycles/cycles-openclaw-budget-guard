/** Resolve and validate plugin configuration with defaults and env-var fallbacks. */

import type { BudgetGuardConfig } from "./types.js";

export function resolveConfig(
  raw: Record<string, unknown>,
): BudgetGuardConfig {
  const cyclesBaseUrl =
    asString(raw.cyclesBaseUrl) ??
    process.env.CYCLES_BASE_URL;
  const cyclesApiKey =
    asString(raw.cyclesApiKey) ??
    process.env.CYCLES_API_KEY;
  const tenant = asString(raw.tenant);

  if (!cyclesBaseUrl) {
    throw new Error(
      "[cycles-budget-guard] cyclesBaseUrl is required (config or CYCLES_BASE_URL env var)",
    );
  }
  if (!cyclesApiKey) {
    throw new Error(
      "[cycles-budget-guard] cyclesApiKey is required (config or CYCLES_API_KEY env var)",
    );
  }
  if (!tenant) {
    throw new Error("[cycles-budget-guard] tenant is required in config");
  }

  const lowBudgetThreshold = asNumber(raw.lowBudgetThreshold) ?? 10_000_000;
  const exhaustedThreshold = asNumber(raw.exhaustedThreshold) ?? 0;

  if (exhaustedThreshold >= lowBudgetThreshold) {
    throw new Error(
      `[cycles-budget-guard] exhaustedThreshold (${exhaustedThreshold}) must be less than lowBudgetThreshold (${lowBudgetThreshold})`,
    );
  }

  return {
    enabled: asBool(raw.enabled) ?? true,
    cyclesBaseUrl,
    cyclesApiKey,
    tenant,
    budgetId: asString(raw.budgetId),
    currency: asString(raw.currency) ?? "USD_MICROCENTS",
    defaultModelActionKind:
      asString(raw.defaultModelActionKind) ?? "llm.completion",
    defaultToolActionKindPrefix:
      asString(raw.defaultToolActionKindPrefix) ?? "tool.",
    lowBudgetThreshold,
    exhaustedThreshold,
    modelFallbacks: asModelFallbacks(raw.modelFallbacks) ?? {},
    toolBaseCosts: asNumberRecord(raw.toolBaseCosts) ?? {},
    injectPromptBudgetHint: asBool(raw.injectPromptBudgetHint) ?? true,
    maxPromptHintChars: asNumber(raw.maxPromptHintChars) ?? 200,
    failClosed: asBool(raw.failClosed) ?? true,
    logLevel: asLogLevel(raw.logLevel) ?? "info",

    // Gap 1: LLM call reservations
    modelBaseCosts: asNumberRecord(raw.modelBaseCosts) ?? {},
    defaultModelCost: asNumber(raw.defaultModelCost) ?? 500_000,

    // Gap 2: Actual cost tracking
    costEstimator: asFunction(raw.costEstimator) as BudgetGuardConfig["costEstimator"],

    // Gap 3: Per-user/session scoping
    userId: asString(raw.userId),
    sessionId: asString(raw.sessionId),

    // Gap 8: Configurable reservation TTL
    reservationTtlMs: asNumber(raw.reservationTtlMs) ?? 60_000,
    toolReservationTtls: asNumberRecord(raw.toolReservationTtls),

    // Gap 11: Configurable snapshot cache TTL
    snapshotCacheTtlMs: asNumber(raw.snapshotCacheTtlMs) ?? 5_000,

    // Gap 16: Overage policy
    overagePolicy: asString(raw.overagePolicy) ?? "ALLOW_IF_AVAILABLE",
    toolOveragePolicies: asStringRecord(raw.toolOveragePolicies),

    // Gap 5: Budget transition alerts
    onBudgetTransition: asFunction(raw.onBudgetTransition) as BudgetGuardConfig["onBudgetTransition"],
    budgetTransitionWebhookUrl: asString(raw.budgetTransitionWebhookUrl),

    // Gap 7: Tool allowlist/blocklist
    toolAllowlist: asStringArray(raw.toolAllowlist),
    toolBlocklist: asStringArray(raw.toolBlocklist),

    // Gap 13: Graceful degradation strategies
    lowBudgetStrategies: asStringArray(raw.lowBudgetStrategies) ?? ["downgrade_model"],
    maxTokensWhenLow: asNumber(raw.maxTokensWhenLow) ?? 1024,
    expensiveToolThreshold: asNumber(raw.expensiveToolThreshold),
    maxRemainingCallsWhenLow: asNumber(raw.maxRemainingCallsWhenLow) ?? 10,

    // Gap 17: Retry on denied tool calls
    retryOnDeny: asBool(raw.retryOnDeny) ?? false,
    retryDelayMs: asNumber(raw.retryDelayMs) ?? 2_000,
    maxRetries: asNumber(raw.maxRetries) ?? 1,

    // Gap 10: Dry-run mode
    dryRun: asBool(raw.dryRun) ?? false,
    dryRunBudget: asNumber(raw.dryRunBudget) ?? 100_000_000,

    // Gap 15: Cross-session analytics
    onSessionEnd: asFunction(raw.onSessionEnd) as BudgetGuardConfig["onSessionEnd"],
    analyticsWebhookUrl: asString(raw.analyticsWebhookUrl),

    // Gap 14: Multi-currency
    toolCurrencies: asStringRecord(raw.toolCurrencies),
    modelCurrency: asString(raw.modelCurrency),

    // Gap 18: Budget pools
    parentBudgetId: asString(raw.parentBudgetId),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asBool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
function asFunction(v: unknown): Function | undefined {
  return typeof v === "function" ? v : undefined;
}

function asLogLevel(
  v: unknown,
): "debug" | "info" | "warn" | "error" | undefined {
  if (
    v === "debug" ||
    v === "info" ||
    v === "warn" ||
    v === "error"
  ) {
    return v;
  }
  return undefined;
}

function asStringRecord(
  v: unknown,
): Record<string, string> | undefined {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, string>;
  }
  return undefined;
}

function asNumberRecord(
  v: unknown,
): Record<string, number> | undefined {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, number>;
  }
  return undefined;
}

function asStringArray(v: unknown): string[] | undefined {
  if (Array.isArray(v) && v.every((item) => typeof item === "string")) {
    return v as string[];
  }
  return undefined;
}

function asModelFallbacks(
  v: unknown,
): Record<string, string | string[]> | undefined {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, string | string[]>;
  }
  return undefined;
}
