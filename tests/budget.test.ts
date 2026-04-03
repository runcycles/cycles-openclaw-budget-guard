import { describe, it, expect } from "vitest";
import { classifyBudget, formatBudgetHint, isToolPermitted } from "../src/budget.js";
import { makeConfig, makeSnapshot } from "./helpers.js";

describe("classifyBudget", () => {
  const config = makeConfig({
    lowBudgetThreshold: 10_000_000,
    exhaustedThreshold: 0,
  });

  it("returns 'healthy' when remaining > lowBudgetThreshold", () => {
    expect(classifyBudget(50_000_000, config)).toBe("healthy");
  });

  it("returns 'low' when remaining === lowBudgetThreshold", () => {
    expect(classifyBudget(10_000_000, config)).toBe("low");
  });

  it("returns 'low' when remaining is between thresholds", () => {
    expect(classifyBudget(5_000_000, config)).toBe("low");
  });

  it("returns 'exhausted' when remaining === exhaustedThreshold", () => {
    expect(classifyBudget(0, config)).toBe("exhausted");
  });

  it("returns 'exhausted' when remaining < exhaustedThreshold", () => {
    const cfg = makeConfig({ exhaustedThreshold: 100 });
    expect(classifyBudget(50, cfg)).toBe("exhausted");
  });
});

describe("formatBudgetHint", () => {
  const config = makeConfig();

  it("healthy hint contains no warning text", () => {
    const snapshot = makeSnapshot({ level: "healthy", remaining: 50_000_000 });
    const hint = formatBudgetHint(snapshot, config);
    expect(hint).toContain("Budget: 50000000 USD_MICROCENTS remaining.");
    expect(hint).not.toContain("low");
    expect(hint).not.toContain("exhausted");
  });

  it("low hint includes warning about cheaper models", () => {
    const snapshot = makeSnapshot({ level: "low", remaining: 5_000_000 });
    const hint = formatBudgetHint(snapshot, config);
    expect(hint).toContain("prefer cheaper models");
  });

  it("exhausted hint includes minimize resource usage", () => {
    const snapshot = makeSnapshot({ level: "exhausted", remaining: 0 });
    const hint = formatBudgetHint(snapshot, config);
    expect(hint).toContain("minimize resource usage");
  });

  it("includes percentage when allocated > 0", () => {
    const snapshot = makeSnapshot({
      level: "healthy",
      remaining: 50_000_000,
      allocated: 100_000_000,
    });
    const hint = formatBudgetHint(snapshot, config);
    expect(hint).toContain("50% of budget remaining");
  });

  it("omits percentage when allocated is undefined", () => {
    const snapshot = makeSnapshot({
      level: "healthy",
      remaining: 50_000_000,
      allocated: undefined,
    });
    const hint = formatBudgetHint(snapshot, config);
    expect(hint).not.toContain("% of budget");
  });

  it("truncates to maxPromptHintChars with ellipsis", () => {
    const cfg = makeConfig({ maxPromptHintChars: 50 });
    const snapshot = makeSnapshot({
      level: "low",
      remaining: 5_000_000,
      allocated: 100_000_000,
    });
    const hint = formatBudgetHint(snapshot, cfg);
    expect(hint.length).toBeLessThanOrEqual(50);
    expect(hint).toMatch(/\.\.\.$/);
  });

  it("includes forecast projection (Gap 9)", () => {
    const snapshot = makeSnapshot({ level: "healthy", remaining: 1_000_000 });
    const forecast = {
      avgToolCost: 100_000,
      avgModelCost: 200_000,
      totalToolCalls: 5,
      totalModelCalls: 3,
    };
    const cfg = makeConfig({ maxPromptHintChars: 500 });
    const hint = formatBudgetHint(snapshot, cfg, forecast);
    expect(hint).toContain("~10 tool calls");
    expect(hint).toContain("~5 model calls");
  });

  it("omits forecast when no calls made yet", () => {
    const snapshot = makeSnapshot({ level: "healthy", remaining: 1_000_000 });
    const forecast = {
      avgToolCost: 0,
      avgModelCost: 0,
      totalToolCalls: 0,
      totalModelCalls: 0,
    };
    const hint = formatBudgetHint(snapshot, config, forecast);
    expect(hint).not.toContain("Est.");
  });

  it("includes pool info when available (Gap 18)", () => {
    const snapshot = makeSnapshot({
      level: "healthy",
      remaining: 1_000_000,
      poolRemaining: 50_000_000,
    });
    const cfg = makeConfig({ maxPromptHintChars: 500 });
    const hint = formatBudgetHint(snapshot, cfg);
    expect(hint).toContain("Team pool: 50000000 remaining.");
  });
});

describe("isToolPermitted (Gap 7)", () => {
  it("permits all tools when no lists configured", () => {
    expect(isToolPermitted("anything")).toEqual({ permitted: true });
  });

  it("blocks tool matching blocklist exact name", () => {
    const result = isToolPermitted("dangerous_tool", undefined, ["dangerous_tool"]);
    expect(result.permitted).toBe(false);
    expect(result.reason).toContain("blocklisted");
  });

  it("blocks tool matching blocklist wildcard prefix", () => {
    const result = isToolPermitted("code_exec", undefined, ["code_*"]);
    expect(result.permitted).toBe(false);
  });

  it("blocks tool matching blocklist wildcard suffix", () => {
    const result = isToolPermitted("my_dangerous", undefined, ["*_dangerous"]);
    expect(result.permitted).toBe(false);
  });

  it("blocks tool matching blocklist wildcard star", () => {
    const result = isToolPermitted("anything", undefined, ["*"]);
    expect(result.permitted).toBe(false);
  });

  it("permits tool not on blocklist", () => {
    const result = isToolPermitted("web_search", undefined, ["code_exec"]);
    expect(result.permitted).toBe(true);
  });

  it("blocks tool not on allowlist", () => {
    const result = isToolPermitted("code_exec", ["web_search"]);
    expect(result.permitted).toBe(false);
    expect(result.reason).toContain("allowlist");
  });

  it("permits tool on allowlist", () => {
    const result = isToolPermitted("web_search", ["web_search", "code_*"]);
    expect(result.permitted).toBe(true);
  });

  it("permits tool matching allowlist wildcard", () => {
    const result = isToolPermitted("code_exec", ["code_*"]);
    expect(result.permitted).toBe(true);
  });

  it("blocklist takes precedence over allowlist", () => {
    const result = isToolPermitted("dangerous_tool", ["*"], ["dangerous_tool"]);
    expect(result.permitted).toBe(false);
  });

  it("blocks tool matching blocklist with mid-pattern wildcard", () => {
    const result = isToolPermitted("aws_s3_tool", undefined, ["aws_*_tool"]);
    expect(result.permitted).toBe(false);
  });

  it("permits tool matching allowlist with mid-pattern wildcard", () => {
    const result = isToolPermitted("aws_s3_tool", ["aws_*_tool"]);
    expect(result.permitted).toBe(true);
  });

  it("does not match mid-pattern wildcard when segments differ", () => {
    const result = isToolPermitted("gcp_s3_tool", ["aws_*_tool"]);
    expect(result.permitted).toBe(false);
    expect(result.reason).toContain("allowlist");
  });

  it("matches pattern with multiple wildcards", () => {
    const result = isToolPermitted("a_foo_b_bar_c", undefined, ["a_*_b_*_c"]);
    expect(result.permitted).toBe(false);
  });
});
