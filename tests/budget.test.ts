import { describe, it, expect } from "vitest";
import { classifyBudget, formatBudgetHint } from "../src/budget.js";
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
});
