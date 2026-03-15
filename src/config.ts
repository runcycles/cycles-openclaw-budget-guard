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
    lowBudgetThreshold: asNumber(raw.lowBudgetThreshold) ?? 10_000_000,
    exhaustedThreshold: asNumber(raw.exhaustedThreshold) ?? 0,
    modelFallbacks: asStringRecord(raw.modelFallbacks) ?? {},
    toolBaseCosts: asNumberRecord(raw.toolBaseCosts) ?? {},
    injectPromptBudgetHint: asBool(raw.injectPromptBudgetHint) ?? true,
    maxPromptHintChars: asNumber(raw.maxPromptHintChars) ?? 200,
    failClosed: asBool(raw.failClosed) ?? true,
    logLevel: asLogLevel(raw.logLevel) ?? "info",
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
