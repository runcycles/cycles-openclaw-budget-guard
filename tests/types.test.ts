import { describe, it, expect } from "vitest";
import { BudgetExhaustedError, ToolBudgetDeniedError } from "../src/types.js";

describe("BudgetExhaustedError", () => {
  it("has code BUDGET_EXHAUSTED", () => {
    const err = new BudgetExhaustedError(42);
    expect(err.code).toBe("BUDGET_EXHAUSTED");
  });

  it("stores the remaining amount", () => {
    const err = new BudgetExhaustedError(12345);
    expect(err.remaining).toBe(12345);
  });

  it("includes remaining in the message", () => {
    const err = new BudgetExhaustedError(999);
    expect(err.message).toContain("999");
  });

  it("has name BudgetExhaustedError", () => {
    const err = new BudgetExhaustedError(0);
    expect(err.name).toBe("BudgetExhaustedError");
  });

  it("is an instance of Error", () => {
    const err = new BudgetExhaustedError(0);
    expect(err).toBeInstanceOf(Error);
  });
});

describe("ToolBudgetDeniedError", () => {
  it("has code TOOL_BUDGET_DENIED and stores toolName", () => {
    const err = new ToolBudgetDeniedError("web_search");
    expect(err.code).toBe("TOOL_BUDGET_DENIED");
    expect(err.toolName).toBe("web_search");
  });

  it("includes toolName in message without reason", () => {
    const err = new ToolBudgetDeniedError("web_search");
    expect(err.message).toContain("web_search");
    expect(err.message).not.toContain(":");
  });

  it("includes reason in message when provided", () => {
    const err = new ToolBudgetDeniedError("code_exec", "over limit");
    expect(err.message).toContain("code_exec");
    expect(err.message).toContain("over limit");
  });

  it("has name ToolBudgetDeniedError", () => {
    const err = new ToolBudgetDeniedError("x");
    expect(err.name).toBe("ToolBudgetDeniedError");
  });
});
