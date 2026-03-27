/** Resolve and validate plugin configuration with defaults and env-var fallbacks. */

import type { BudgetGuardConfig } from "./types.js";

export function resolveConfig(
  raw: Record<string, unknown>,
): BudgetGuardConfig {
  const cyclesBaseUrl = asString(raw.cyclesBaseUrl);
  const cyclesApiKey = asString(raw.cyclesApiKey);
  const tenant = asString(raw.tenant);

  if (!cyclesBaseUrl) {
    throw new Error(
      "[cycles-budget-guard] cyclesBaseUrl is required in plugin config",
    );
  }
  if (!cyclesApiKey) {
    throw new Error(
      "[cycles-budget-guard] cyclesApiKey is required in plugin config",
    );
  }
  if (!tenant) {
    throw new Error("[cycles-budget-guard] tenant is required in config");
  }

  const lowBudgetThreshold = asNumber(raw.lowBudgetThreshold) ?? 10_000_000;
  const exhaustedThreshold = asNumber(raw.exhaustedThreshold) ?? 0;

  if (lowBudgetThreshold < 0) {
    throw new Error(
      `[cycles-budget-guard] lowBudgetThreshold (${lowBudgetThreshold}) must be non-negative`,
    );
  }

  if (exhaustedThreshold < 0) {
    throw new Error(
      `[cycles-budget-guard] exhaustedThreshold (${exhaustedThreshold}) must be non-negative`,
    );
  }

  if (exhaustedThreshold >= lowBudgetThreshold) {
    throw new Error(
      `[cycles-budget-guard] exhaustedThreshold (${exhaustedThreshold}) must be less than lowBudgetThreshold (${lowBudgetThreshold})`,
    );
  }

  const maxRemainingCallsWhenLow = asNumber(raw.maxRemainingCallsWhenLow) ?? 10;
  if (maxRemainingCallsWhenLow < 1) {
    throw new Error(
      `[cycles-budget-guard] maxRemainingCallsWhenLow (${maxRemainingCallsWhenLow}) must be at least 1`,
    );
  }

  const VALID_OVERAGE_POLICIES = ["REJECT", "ALLOW_IF_AVAILABLE", "ALLOW_WITH_OVERDRAFT"];
  const overagePolicy = asString(raw.overagePolicy) ?? "ALLOW_IF_AVAILABLE";
  if (!VALID_OVERAGE_POLICIES.includes(overagePolicy)) {
    throw new Error(
      `[cycles-budget-guard] overagePolicy "${overagePolicy}" is invalid (must be one of: ${VALID_OVERAGE_POLICIES.join(", ")})`,
    );
  }

  // Validate per-tool overage policies
  const toolOveragePolicies = asStringRecord(raw.toolOveragePolicies);
  if (toolOveragePolicies) {
    for (const [tool, policy] of Object.entries(toolOveragePolicies)) {
      if (!VALID_OVERAGE_POLICIES.includes(policy)) {
        throw new Error(
          `[cycles-budget-guard] toolOveragePolicies["${tool}"] = "${policy}" is invalid (must be one of: ${VALID_OVERAGE_POLICIES.join(", ")})`,
        );
      }
    }
  }

  // Validate tool call limits if provided
  const toolCallLimits = asNumberRecord(raw.toolCallLimits);
  if (toolCallLimits) {
    for (const [tool, limit] of Object.entries(toolCallLimits)) {
      if (limit < 1) {
        throw new Error(
          `[cycles-budget-guard] toolCallLimits["${tool}"] = ${limit} must be at least 1`,
        );
      }
    }
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
    overagePolicy,
    toolOveragePolicies,

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
    maxRemainingCallsWhenLow,

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

    // Tool call limits (per-tool invocation caps per session)
    toolCallLimits,

    // v0.5.0: Model cost reconciliation
    modelCostEstimator: asFunction(raw.modelCostEstimator) as BudgetGuardConfig["modelCostEstimator"],

    // v0.5.0: Metrics emitter
    metricsEmitter: asFunction(raw.metricsEmitter) ? (raw.metricsEmitter as BudgetGuardConfig["metricsEmitter"]) : undefined,

    // v0.5.0: Aggressive cache invalidation
    aggressiveCacheInvalidation: asBool(raw.aggressiveCacheInvalidation) ?? true,

    // v0.5.0: OTLP metrics
    otlpMetricsEndpoint: asString(raw.otlpMetricsEndpoint),
    otlpMetricsHeaders: asStringRecord(raw.otlpMetricsHeaders),

    // v0.6.0: Reservation heartbeat
    heartbeatIntervalMs: asNumber(raw.heartbeatIntervalMs) ?? 30_000,

    // v0.6.0: Retryable error handling
    retryableStatusCodes: asNumberArray(raw.retryableStatusCodes) ?? [429, 503, 504],
    transientRetryMaxAttempts: asNumber(raw.transientRetryMaxAttempts) ?? 2,
    transientRetryBaseDelayMs: asNumber(raw.transientRetryBaseDelayMs) ?? 500,

    // v0.6.0: Burn rate anomaly detection
    burnRateWindowMs: asNumber(raw.burnRateWindowMs) ?? 60_000,
    burnRateAlertThreshold: asNumber(raw.burnRateAlertThreshold) ?? 3.0,
    onBurnRateAnomaly: asFunction(raw.onBurnRateAnomaly) as BudgetGuardConfig["onBurnRateAnomaly"],

    // v0.6.0: Session event log
    enableEventLog: asBool(raw.enableEventLog) ?? false,

    // v0.6.0: Predictive exhaustion warning
    exhaustionWarningThresholdMs: asNumber(raw.exhaustionWarningThresholdMs) ?? 120_000,
    onExhaustionForecast: asFunction(raw.onExhaustionForecast) as BudgetGuardConfig["onExhaustionForecast"],
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

function asNumberArray(v: unknown): number[] | undefined {
  if (Array.isArray(v) && v.every((item) => typeof item === "number")) {
    return v as number[];
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
