import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveConfig } from "../src/config.js";

describe("resolveConfig", () => {
  const minValid = {
    cyclesBaseUrl: "http://localhost:7878",
    cyclesApiKey: "test-key",
    tenant: "acme",
  };

  it("returns all defaults with minimal valid config", () => {
    const cfg = resolveConfig(minValid);
    expect(cfg.enabled).toBe(true);
    expect(cfg.currency).toBe("USD_MICROCENTS");
    expect(cfg.defaultModelActionKind).toBe("llm.completion");
    expect(cfg.defaultToolActionKindPrefix).toBe("tool.");
    expect(cfg.lowBudgetThreshold).toBe(10_000_000);
    expect(cfg.exhaustedThreshold).toBe(0);
    expect(cfg.modelFallbacks).toEqual({});
    expect(cfg.toolBaseCosts).toEqual({});
    expect(cfg.injectPromptBudgetHint).toBe(true);
    expect(cfg.maxPromptHintChars).toBe(200);
    expect(cfg.failClosed).toBe(true);
    expect(cfg.logLevel).toBe("info");
  });

  it("returns new field defaults with minimal valid config", () => {
    const cfg = resolveConfig(minValid);
    // Gap 1
    expect(cfg.modelBaseCosts).toEqual({});
    expect(cfg.defaultModelCost).toBe(500_000);
    // Gap 2
    expect(cfg.costEstimator).toBeUndefined();
    // Gap 3
    expect(cfg.userId).toBeUndefined();
    expect(cfg.sessionId).toBeUndefined();
    // Gap 8
    expect(cfg.reservationTtlMs).toBe(60_000);
    expect(cfg.toolReservationTtls).toBeUndefined();
    // Gap 11
    expect(cfg.snapshotCacheTtlMs).toBe(5_000);
    // Gap 16
    expect(cfg.overagePolicy).toBe("ALLOW_IF_AVAILABLE");
    expect(cfg.toolOveragePolicies).toBeUndefined();
    // Gap 5
    expect(cfg.onBudgetTransition).toBeUndefined();
    expect(cfg.budgetTransitionWebhookUrl).toBeUndefined();
    // Gap 7
    expect(cfg.toolAllowlist).toBeUndefined();
    expect(cfg.toolBlocklist).toBeUndefined();
    // Gap 13
    expect(cfg.lowBudgetStrategies).toEqual(["downgrade_model"]);
    expect(cfg.maxTokensWhenLow).toBe(1024);
    expect(cfg.expensiveToolThreshold).toBeUndefined();
    expect(cfg.maxRemainingCallsWhenLow).toBe(10);
    // Gap 17
    expect(cfg.retryOnDeny).toBe(false);
    expect(cfg.retryDelayMs).toBe(2_000);
    expect(cfg.maxRetries).toBe(1);
    // Gap 10
    expect(cfg.dryRun).toBe(false);
    expect(cfg.dryRunBudget).toBe(100_000_000);
    // Gap 15
    expect(cfg.onSessionEnd).toBeUndefined();
    expect(cfg.analyticsWebhookUrl).toBeUndefined();
    // Gap 14
    expect(cfg.toolCurrencies).toBeUndefined();
    expect(cfg.modelCurrency).toBeUndefined();
    // Gap 18
    expect(cfg.parentBudgetId).toBeUndefined();
  });

  it("throws when cyclesBaseUrl is missing", () => {
    expect(() => resolveConfig({ cyclesApiKey: "k", tenant: "t" })).toThrow(
      "cyclesBaseUrl is required",
    );
  });

  it("throws when cyclesApiKey is missing", () => {
    expect(() =>
      resolveConfig({ cyclesBaseUrl: "http://x", tenant: "t" }),
    ).toThrow("cyclesApiKey is required");
  });

  it("throws when tenant is missing", () => {
    expect(() =>
      resolveConfig({ cyclesBaseUrl: "http://x", cyclesApiKey: "k" }),
    ).toThrow("tenant is required");
  });

  it("throws when cyclesBaseUrl is missing", () => {
    expect(() => resolveConfig({ cyclesApiKey: "k", tenant: "t" })).toThrow(
      "cyclesBaseUrl is required",
    );
  });

  it("throws when cyclesApiKey is missing", () => {
    expect(() => resolveConfig({ cyclesBaseUrl: "http://x", tenant: "t" })).toThrow(
      "cyclesApiKey is required",
    );
  });

  it("throws when exhaustedThreshold >= lowBudgetThreshold", () => {
    expect(() =>
      resolveConfig({ ...minValid, exhaustedThreshold: 10, lowBudgetThreshold: 10 }),
    ).toThrow("exhaustedThreshold");

    expect(() =>
      resolveConfig({ ...minValid, exhaustedThreshold: 20, lowBudgetThreshold: 10 }),
    ).toThrow("exhaustedThreshold");
  });

  it("applies custom thresholds", () => {
    const cfg = resolveConfig({
      ...minValid,
      lowBudgetThreshold: 5_000_000,
      exhaustedThreshold: 100,
    });
    expect(cfg.lowBudgetThreshold).toBe(5_000_000);
    expect(cfg.exhaustedThreshold).toBe(100);
  });

  it("parses modelFallbacks record (string)", () => {
    const cfg = resolveConfig({
      ...minValid,
      modelFallbacks: { "gpt-4o": "gpt-4o-mini" },
    });
    expect(cfg.modelFallbacks).toEqual({ "gpt-4o": "gpt-4o-mini" });
  });

  it("parses modelFallbacks record (array — Gap 4)", () => {
    const cfg = resolveConfig({
      ...minValid,
      modelFallbacks: { "opus": ["sonnet", "haiku"] },
    });
    expect(cfg.modelFallbacks).toEqual({ "opus": ["sonnet", "haiku"] });
  });

  it("parses toolBaseCosts record", () => {
    const cfg = resolveConfig({
      ...minValid,
      toolBaseCosts: { web_search: 500_000 },
    });
    expect(cfg.toolBaseCosts).toEqual({ web_search: 500_000 });
  });

  it("falls back to 'info' for invalid logLevel", () => {
    const cfg = resolveConfig({ ...minValid, logLevel: "verbose" });
    expect(cfg.logLevel).toBe("info");
  });

  it("accepts 'error' as valid logLevel", () => {
    const cfg = resolveConfig({ ...minValid, logLevel: "error" });
    expect(cfg.logLevel).toBe("error");
  });

  it("throws when cyclesBaseUrl is a non-string value", () => {
    expect(() =>
      resolveConfig({
        cyclesBaseUrl: 12345 as unknown as string,
        cyclesApiKey: "k",
        tenant: "t",
      }),
    ).toThrow("cyclesBaseUrl is required");
  });

  it("ignores array for record fields, uses default", () => {
    const cfg = resolveConfig({
      ...minValid,
      modelFallbacks: [1, 2, 3] as unknown as Record<string, string>,
    });
    expect(cfg.modelFallbacks).toEqual({});
  });

  it("parses costEstimator function (Gap 2)", () => {
    const fn = () => 42;
    const cfg = resolveConfig({ ...minValid, costEstimator: fn });
    expect(cfg.costEstimator).toBe(fn);
  });

  it("ignores non-function for costEstimator", () => {
    const cfg = resolveConfig({ ...minValid, costEstimator: "not-a-function" });
    expect(cfg.costEstimator).toBeUndefined();
  });

  it("parses userId and sessionId (Gap 3)", () => {
    const cfg = resolveConfig({ ...minValid, userId: "u1", sessionId: "s1" });
    expect(cfg.userId).toBe("u1");
    expect(cfg.sessionId).toBe("s1");
  });

  it("parses reservationTtlMs and toolReservationTtls (Gap 8)", () => {
    const cfg = resolveConfig({
      ...minValid,
      reservationTtlMs: 120_000,
      toolReservationTtls: { slow: 300_000 },
    });
    expect(cfg.reservationTtlMs).toBe(120_000);
    expect(cfg.toolReservationTtls).toEqual({ slow: 300_000 });
  });

  it("parses snapshotCacheTtlMs (Gap 11)", () => {
    const cfg = resolveConfig({ ...minValid, snapshotCacheTtlMs: 10_000 });
    expect(cfg.snapshotCacheTtlMs).toBe(10_000);
  });

  it("parses overagePolicy and toolOveragePolicies (Gap 16)", () => {
    const cfg = resolveConfig({
      ...minValid,
      overagePolicy: "ALLOW_IF_AVAILABLE",
      toolOveragePolicies: { risky: "ALLOW_WITH_OVERDRAFT" },
    });
    expect(cfg.overagePolicy).toBe("ALLOW_IF_AVAILABLE");
    expect(cfg.toolOveragePolicies).toEqual({ risky: "ALLOW_WITH_OVERDRAFT" });
  });

  it("parses toolAllowlist and toolBlocklist (Gap 7)", () => {
    const cfg = resolveConfig({
      ...minValid,
      toolAllowlist: ["web_search", "code_*"],
      toolBlocklist: ["dangerous_tool"],
    });
    expect(cfg.toolAllowlist).toEqual(["web_search", "code_*"]);
    expect(cfg.toolBlocklist).toEqual(["dangerous_tool"]);
  });

  it("ignores invalid array for string array fields", () => {
    const cfg = resolveConfig({
      ...minValid,
      toolAllowlist: [1, 2, 3] as unknown as string[],
    });
    expect(cfg.toolAllowlist).toBeUndefined();
  });

  it("parses lowBudgetStrategies (Gap 13)", () => {
    const cfg = resolveConfig({
      ...minValid,
      lowBudgetStrategies: ["downgrade_model", "reduce_max_tokens"],
    });
    expect(cfg.lowBudgetStrategies).toEqual(["downgrade_model", "reduce_max_tokens"]);
  });

  it("parses dryRun and dryRunBudget (Gap 10)", () => {
    const cfg = resolveConfig({ ...minValid, dryRun: true, dryRunBudget: 50_000_000 });
    expect(cfg.dryRun).toBe(true);
    expect(cfg.dryRunBudget).toBe(50_000_000);
  });

  it("parses toolCurrencies and modelCurrency (Gap 14)", () => {
    const cfg = resolveConfig({
      ...minValid,
      toolCurrencies: { token_tool: "TOKENS" },
      modelCurrency: "CREDITS",
    });
    expect(cfg.toolCurrencies).toEqual({ token_tool: "TOKENS" });
    expect(cfg.modelCurrency).toBe("CREDITS");
  });

  it("parses parentBudgetId (Gap 18)", () => {
    const cfg = resolveConfig({ ...minValid, parentBudgetId: "team-pool" });
    expect(cfg.parentBudgetId).toBe("team-pool");
  });

  // --- New validation tests ---

  it("throws when lowBudgetThreshold is negative", () => {
    expect(() =>
      resolveConfig({ ...minValid, lowBudgetThreshold: -1 }),
    ).toThrow("lowBudgetThreshold (-1) must be non-negative");
  });

  it("throws when exhaustedThreshold is negative", () => {
    expect(() =>
      resolveConfig({ ...minValid, exhaustedThreshold: -1, lowBudgetThreshold: 100 }),
    ).toThrow("exhaustedThreshold (-1) must be non-negative");
  });

  it("throws when maxRemainingCallsWhenLow is less than 1", () => {
    expect(() =>
      resolveConfig({ ...minValid, maxRemainingCallsWhenLow: 0 }),
    ).toThrow("maxRemainingCallsWhenLow (0) must be at least 1");
  });

  it("throws when overagePolicy is invalid", () => {
    expect(() =>
      resolveConfig({ ...minValid, overagePolicy: "INVALID_POLICY" }),
    ).toThrow('overagePolicy "INVALID_POLICY" is invalid');
  });

  it("accepts valid overage policies", () => {
    for (const policy of ["REJECT", "ALLOW_IF_AVAILABLE", "ALLOW_WITH_OVERDRAFT"]) {
      const cfg = resolveConfig({ ...minValid, overagePolicy: policy });
      expect(cfg.overagePolicy).toBe(policy);
    }
  });

  it("throws when toolOveragePolicies contains invalid policy", () => {
    expect(() =>
      resolveConfig({
        ...minValid,
        toolOveragePolicies: { web_search: "BAD" },
      }),
    ).toThrow('toolOveragePolicies["web_search"] = "BAD" is invalid');
  });

  it("parses toolCallLimits", () => {
    const cfg = resolveConfig({
      ...minValid,
      toolCallLimits: { send_email: 10, deploy: 3 },
    });
    expect(cfg.toolCallLimits).toEqual({ send_email: 10, deploy: 3 });
  });

  it("throws when toolCallLimits contains value less than 1", () => {
    expect(() =>
      resolveConfig({
        ...minValid,
        toolCallLimits: { send_email: 0 },
      }),
    ).toThrow('toolCallLimits["send_email"] = 0 must be at least 1');
  });

  it("resolves metricsEmitter when provided as a function-like object", () => {
    const emitter = {
      gauge: () => {},
      counter: () => {},
      histogram: () => {},
    };
    const result = resolveConfig({
      ...minValid,
      // metricsEmitter is a callback-only option, not JSON-serializable.
      // When passed as a non-function object it should be undefined.
      metricsEmitter: emitter,
    });
    // asFunction returns undefined for objects, so metricsEmitter is undefined here
    expect(result.metricsEmitter).toBeUndefined();
  });

  it("resolves metricsEmitter when passed as a function", () => {
    const emitterFn = () => ({
      gauge: () => {},
      counter: () => {},
      histogram: () => {},
    });
    const result = resolveConfig({
      ...minValid,
      metricsEmitter: emitterFn,
    });
    // asFunction returns the function, so the truthy branch is taken
    expect(result.metricsEmitter).toBe(emitterFn);
  });

  it("resolves v0.5.0 config defaults", () => {
    const result = resolveConfig(minValid);
    expect(result.aggressiveCacheInvalidation).toBe(true);
    expect(result.modelCostEstimator).toBeUndefined();
    expect(result.metricsEmitter).toBeUndefined();
    expect(result.otlpMetricsEndpoint).toBeUndefined();
    expect(result.otlpMetricsHeaders).toBeUndefined();
  });

  it("resolves aggressiveCacheInvalidation false when explicitly set", () => {
    const result = resolveConfig({
      ...minValid,
      aggressiveCacheInvalidation: false,
    });
    expect(result.aggressiveCacheInvalidation).toBe(false);
  });

  it("resolves otlpMetricsEndpoint and headers", () => {
    const result = resolveConfig({
      ...minValid,
      otlpMetricsEndpoint: "http://localhost:4318/v1/metrics",
      otlpMetricsHeaders: { "X-Api-Key": "secret" },
    });
    expect(result.otlpMetricsEndpoint).toBe("http://localhost:4318/v1/metrics");
    expect(result.otlpMetricsHeaders).toEqual({ "X-Api-Key": "secret" });
  });

  it("resolves custom retryableStatusCodes array", () => {
    const result = resolveConfig({
      ...minValid,
      retryableStatusCodes: [429, 502, 503],
    });
    expect(result.retryableStatusCodes).toEqual([429, 502, 503]);
  });

  it("falls back to default retryableStatusCodes when not provided", () => {
    const result = resolveConfig(minValid);
    expect(result.retryableStatusCodes).toEqual([429, 503, 504]);
  });

  it("ignores invalid retryableStatusCodes (non-array)", () => {
    const result = resolveConfig({
      ...minValid,
      retryableStatusCodes: "429",
    });
    expect(result.retryableStatusCodes).toEqual([429, 503, 504]);
  });

  it("resolves v0.6.0 config defaults", () => {
    const result = resolveConfig(minValid);
    expect(result.heartbeatIntervalMs).toBe(30_000);
    expect(result.transientRetryMaxAttempts).toBe(2);
    expect(result.transientRetryBaseDelayMs).toBe(500);
    expect(result.burnRateWindowMs).toBe(60_000);
    expect(result.burnRateAlertThreshold).toBe(3.0);
    expect(result.enableEventLog).toBe(false);
    expect(result.exhaustionWarningThresholdMs).toBe(120_000);
  });

  it("rejects toolBaseCosts with non-number values", () => {
    const cfg = resolveConfig({
      ...minValid,
      toolBaseCosts: { web_search: "not_a_number" },
    });
    expect(cfg.toolBaseCosts).toEqual({});
  });

  it("rejects otlpMetricsHeaders with non-string values", () => {
    const cfg = resolveConfig({
      ...minValid,
      otlpMetricsHeaders: { Authorization: 123 },
    });
    expect(cfg.otlpMetricsHeaders).toBeUndefined();
  });

  it("accepts valid toolBaseCosts with all number values", () => {
    const cfg = resolveConfig({
      ...minValid,
      toolBaseCosts: { web_search: 5000, code_exec: 10000 },
    });
    expect(cfg.toolBaseCosts).toEqual({ web_search: 5000, code_exec: 10000 });
  });
});
