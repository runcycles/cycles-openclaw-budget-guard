/** Shared test helpers and mock factories. */

import { vi, type Mock } from "vitest";
import type {
  BudgetGuardConfig,
  BudgetSnapshot,
  BudgetLevel,
  OpenClawLogger,
  HookContext,
} from "../src/types.js";

/**
 * Returns a valid BudgetGuardConfig with sensible defaults.
 * Pass overrides to customize specific fields.
 */
export function makeConfig(
  overrides?: Partial<BudgetGuardConfig>,
): BudgetGuardConfig {
  return {
    enabled: true,
    cyclesBaseUrl: "http://localhost:7878",
    cyclesApiKey: "test-api-key",
    tenant: "test-tenant",
    budgetId: undefined,
    currency: "USD_MICROCENTS",
    defaultModelActionKind: "llm.completion",
    defaultToolActionKindPrefix: "tool.",
    lowBudgetThreshold: 10_000_000,
    exhaustedThreshold: 0,
    modelFallbacks: {},
    toolBaseCosts: {},
    injectPromptBudgetHint: true,
    maxPromptHintChars: 200,
    failClosed: true,
    logLevel: "info",
    // Gap 1
    modelBaseCosts: {},
    defaultModelCost: 500_000,
    // Gap 2
    costEstimator: undefined,
    // Gap 3
    userId: undefined,
    sessionId: undefined,
    // Gap 8
    reservationTtlMs: 60_000,
    toolReservationTtls: undefined,
    // Gap 11
    snapshotCacheTtlMs: 5_000,
    // Gap 16
    overagePolicy: "ALLOW_IF_AVAILABLE",
    toolOveragePolicies: undefined,
    // Gap 5
    onBudgetTransition: undefined,
    budgetTransitionWebhookUrl: undefined,
    // Gap 7
    toolAllowlist: undefined,
    toolBlocklist: undefined,
    // Gap 13
    lowBudgetStrategies: ["downgrade_model"],
    maxTokensWhenLow: 1024,
    expensiveToolThreshold: undefined,
    maxRemainingCallsWhenLow: 10,
    // Gap 17
    retryOnDeny: false,
    retryDelayMs: 2_000,
    maxRetries: 1,
    // Gap 10
    dryRun: false,
    dryRunBudget: 100_000_000,
    // Gap 15
    onSessionEnd: undefined,
    analyticsWebhookUrl: undefined,
    // Gap 14
    toolCurrencies: undefined,
    modelCurrency: undefined,
    // Gap 18
    parentBudgetId: undefined,
    // Tool call limits
    toolCallLimits: undefined,
    // v0.5.0
    modelCostEstimator: undefined,
    metricsEmitter: undefined,
    aggressiveCacheInvalidation: true,
    otlpMetricsEndpoint: undefined,
    otlpMetricsHeaders: undefined,
    ...overrides,
  };
}

/**
 * Returns a mock logger where every method is a vi.fn().
 */
export function makeLogger(): OpenClawLogger & {
  debug: Mock;
  info: Mock;
  warn: Mock;
  error: Mock;
} {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

/**
 * Returns a BudgetSnapshot with sensible defaults.
 */
export function makeSnapshot(
  overrides?: Partial<BudgetSnapshot>,
): BudgetSnapshot {
  return {
    remaining: 50_000_000,
    reserved: 0,
    spent: 0,
    allocated: 100_000_000,
    level: "healthy" as BudgetLevel,
    ...overrides,
  };
}

/**
 * Returns a mock HookContext.
 */
export function makeHookContext(
  metadata?: Record<string, unknown>,
): HookContext {
  return { metadata: metadata ?? {} };
}
