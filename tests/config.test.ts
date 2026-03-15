import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveConfig } from "../src/config.js";

describe("resolveConfig", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.CYCLES_BASE_URL = process.env.CYCLES_BASE_URL;
    savedEnv.CYCLES_API_KEY = process.env.CYCLES_API_KEY;
    delete process.env.CYCLES_BASE_URL;
    delete process.env.CYCLES_API_KEY;
  });

  afterEach(() => {
    if (savedEnv.CYCLES_BASE_URL !== undefined) {
      process.env.CYCLES_BASE_URL = savedEnv.CYCLES_BASE_URL;
    } else {
      delete process.env.CYCLES_BASE_URL;
    }
    if (savedEnv.CYCLES_API_KEY !== undefined) {
      process.env.CYCLES_API_KEY = savedEnv.CYCLES_API_KEY;
    } else {
      delete process.env.CYCLES_API_KEY;
    }
  });

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

  it("falls back to CYCLES_BASE_URL env var", () => {
    process.env.CYCLES_BASE_URL = "http://from-env";
    const cfg = resolveConfig({ cyclesApiKey: "k", tenant: "t" });
    expect(cfg.cyclesBaseUrl).toBe("http://from-env");
  });

  it("falls back to CYCLES_API_KEY env var", () => {
    process.env.CYCLES_API_KEY = "env-key";
    const cfg = resolveConfig({ cyclesBaseUrl: "http://x", tenant: "t" });
    expect(cfg.cyclesApiKey).toBe("env-key");
  });

  it("config value takes precedence over env var", () => {
    process.env.CYCLES_BASE_URL = "http://from-env";
    const cfg = resolveConfig({
      ...minValid,
      cyclesBaseUrl: "http://from-config",
    });
    expect(cfg.cyclesBaseUrl).toBe("http://from-config");
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

  it("parses modelFallbacks record", () => {
    const cfg = resolveConfig({
      ...minValid,
      modelFallbacks: { "gpt-4o": "gpt-4o-mini" },
    });
    expect(cfg.modelFallbacks).toEqual({ "gpt-4o": "gpt-4o-mini" });
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

  it("ignores non-string values for string fields", () => {
    // cyclesBaseUrl is required, but if it's a number the env var fallback should be used
    process.env.CYCLES_BASE_URL = "http://fallback";
    const cfg = resolveConfig({
      cyclesBaseUrl: 12345 as unknown as string,
      cyclesApiKey: "k",
      tenant: "t",
    });
    expect(cfg.cyclesBaseUrl).toBe("http://fallback");
  });

  it("ignores array for record fields, uses default", () => {
    const cfg = resolveConfig({
      ...minValid,
      modelFallbacks: [1, 2, 3] as unknown as Record<string, string>,
    });
    expect(cfg.modelFallbacks).toEqual({});
  });
});
