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
