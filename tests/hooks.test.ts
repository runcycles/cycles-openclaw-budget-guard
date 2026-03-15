import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeConfig, makeLogger, makeSnapshot, makeHookContext } from "./helpers.js";
import type { BudgetSnapshot } from "../src/types.js";
import { BudgetExhaustedError } from "../src/types.js";

// --- Mocks ---

const mockFetchBudgetState = vi.fn<() => Promise<BudgetSnapshot>>();
const mockCreateCyclesClient = vi.fn(() => ({}));
const mockReserveBudget = vi.fn();
const mockCommitUsage = vi.fn();
const mockReleaseReservation = vi.fn();
const mockIsAllowed = vi.fn();

vi.mock("runcycles", () => ({
  CyclesClient: vi.fn(),
  CyclesConfig: vi.fn(),
  isAllowed: (...args: unknown[]) => mockIsAllowed(...args),
}));

vi.mock("../src/cycles.js", () => ({
  createCyclesClient: (...args: unknown[]) => mockCreateCyclesClient(...args),
  fetchBudgetState: (...args: unknown[]) => mockFetchBudgetState(...args),
  reserveBudget: (...args: unknown[]) => mockReserveBudget(...args),
  commitUsage: (...args: unknown[]) => mockCommitUsage(...args),
  releaseReservation: (...args: unknown[]) => mockReleaseReservation(...args),
}));

const mockFormatBudgetHint = vi.fn(() => "Budget hint");

vi.mock("../src/budget.js", () => ({
  classifyBudget: vi.fn(),
  formatBudgetHint: (...args: unknown[]) => mockFormatBudgetHint(...args),
}));

vi.mock("../src/logger.js", () => ({
  createLogger: vi.fn(() => makeLogger()),
}));

import {
  initHooks,
  beforeModelResolve,
  beforePromptBuild,
  beforeToolCall,
  afterToolCall,
  agentEnd,
} from "../src/hooks.js";

// --- Setup ---

function setup(configOverrides?: Parameters<typeof makeConfig>[0]) {
  const config = makeConfig(configOverrides);
  const logger = makeLogger();
  initHooks(config, logger);
  return { config, logger };
}

describe("initHooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses provided logger", () => {
    const logger = makeLogger();
    initHooks(makeConfig(), logger);
    // logger.info is called with "Plugin initialized"
    expect(logger.info).toHaveBeenCalledWith(
      "Plugin initialized",
      expect.anything(),
    );
  });

  it("falls back to createLogger when no logger provided", async () => {
    const { createLogger } = await import("../src/logger.js");
    initHooks(makeConfig());
    expect(createLogger).toHaveBeenCalled();
  });

  it("resets state on re-init", async () => {
    // First init, create a reservation
    setup();
    mockFetchBudgetState.mockResolvedValue(makeSnapshot({ level: "healthy" }));
    mockReserveBudget.mockResolvedValue({
      decision: "ALLOW",
      reservationId: "res-orphan",
      affectedScopes: [],
    });

    await beforeToolCall(
      { toolName: "x", toolCallId: "call-1" },
      makeHookContext(),
    );

    // Re-init should clear state
    setup();
    mockFetchBudgetState.mockResolvedValue(makeSnapshot());
    mockReleaseReservation.mockResolvedValue(undefined);

    // agent_end should have no orphans
    await agentEnd({}, makeHookContext());
    expect(mockReleaseReservation).not.toHaveBeenCalled();
  });
});

describe("beforeModelResolve — snapshot caching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  it("fetches from server on first call", async () => {
    setup();
    mockFetchBudgetState.mockResolvedValue(makeSnapshot({ level: "healthy" }));

    await beforeModelResolve({ model: "gpt-4o" }, makeHookContext());
    expect(mockFetchBudgetState).toHaveBeenCalledOnce();
  });

  it("returns cached snapshot within 5s", async () => {
    setup();
    mockFetchBudgetState.mockResolvedValue(makeSnapshot({ level: "healthy" }));

    await beforeModelResolve({ model: "gpt-4o" }, makeHookContext());
    vi.advanceTimersByTime(3000); // 3s < 5s TTL
    await beforeModelResolve({ model: "gpt-4o" }, makeHookContext());

    expect(mockFetchBudgetState).toHaveBeenCalledOnce();
  });

  it("fetches fresh snapshot after 5s", async () => {
    setup();
    mockFetchBudgetState.mockResolvedValue(makeSnapshot({ level: "healthy" }));

    await beforeModelResolve({ model: "gpt-4o" }, makeHookContext());
    vi.advanceTimersByTime(6000); // 6s > 5s TTL
    await beforeModelResolve({ model: "gpt-4o" }, makeHookContext());

    expect(mockFetchBudgetState).toHaveBeenCalledTimes(2);
  });

  afterEach(() => {
    vi.useRealTimers();
  });
});

describe("beforeModelResolve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns undefined when healthy", async () => {
    setup();
    mockFetchBudgetState.mockResolvedValue(makeSnapshot({ level: "healthy" }));

    const result = await beforeModelResolve(
      { model: "gpt-4o" },
      makeHookContext(),
    );
    expect(result).toBeUndefined();
  });

  it("returns modelOverride when low + fallback exists", async () => {
    setup({ modelFallbacks: { "gpt-4o": "gpt-4o-mini" } });
    mockFetchBudgetState.mockResolvedValue(makeSnapshot({ level: "low" }));

    const result = await beforeModelResolve(
      { model: "gpt-4o" },
      makeHookContext(),
    );
    expect(result).toEqual({ modelOverride: "gpt-4o-mini" });
  });

  it("returns undefined when low + no fallback", async () => {
    setup({ modelFallbacks: {} });
    mockFetchBudgetState.mockResolvedValue(makeSnapshot({ level: "low" }));

    const result = await beforeModelResolve(
      { model: "gpt-4o" },
      makeHookContext(),
    );
    expect(result).toBeUndefined();
  });

  it("throws BudgetExhaustedError when exhausted + failClosed", async () => {
    setup({ failClosed: true });
    mockFetchBudgetState.mockResolvedValue(
      makeSnapshot({ level: "exhausted", remaining: 0 }),
    );

    await expect(
      beforeModelResolve({ model: "gpt-4o" }, makeHookContext()),
    ).rejects.toThrow(BudgetExhaustedError);
  });

  it("returns undefined when exhausted + !failClosed", async () => {
    const { logger } = setup({ failClosed: false });
    mockFetchBudgetState.mockResolvedValue(
      makeSnapshot({ level: "exhausted", remaining: 0 }),
    );

    const result = await beforeModelResolve(
      { model: "gpt-4o" },
      makeHookContext(),
    );
    expect(result).toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe("beforePromptBuild", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns prependSystemContext when injectPromptBudgetHint is true", async () => {
    setup({ injectPromptBudgetHint: true });
    mockFetchBudgetState.mockResolvedValue(makeSnapshot());
    mockFormatBudgetHint.mockReturnValue("Budget: 50M remaining.");

    const result = await beforePromptBuild({}, makeHookContext());
    expect(result).toEqual({ prependSystemContext: "Budget: 50M remaining." });
  });

  it("returns undefined when injectPromptBudgetHint is false", async () => {
    setup({ injectPromptBudgetHint: false });

    const result = await beforePromptBuild({}, makeHookContext());
    expect(result).toBeUndefined();
  });

  it("uses cached snapshot", async () => {
    setup({ injectPromptBudgetHint: true });
    mockFetchBudgetState.mockResolvedValue(makeSnapshot());

    // First call via beforeModelResolve to populate cache
    await beforeModelResolve({ model: "x" }, makeHookContext());
    // Second call should use cache
    await beforePromptBuild({}, makeHookContext());

    expect(mockFetchBudgetState).toHaveBeenCalledOnce();
  });
});

describe("beforeToolCall", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns undefined (allow) when reservation is ALLOW", async () => {
    setup();
    mockFetchBudgetState.mockResolvedValue(makeSnapshot());
    mockIsAllowed.mockReturnValue(true);
    mockReserveBudget.mockResolvedValue({
      decision: "ALLOW",
      reservationId: "res-1",
      affectedScopes: [],
    });

    const result = await beforeToolCall(
      { toolName: "web_search", toolCallId: "call-1" },
      makeHookContext(),
    );
    expect(result).toBeUndefined();
  });

  it("returns block result when reservation is DENY", async () => {
    setup();
    mockFetchBudgetState.mockResolvedValue(makeSnapshot());
    mockIsAllowed.mockReturnValue(false);
    mockReserveBudget.mockResolvedValue({
      decision: "DENY",
      affectedScopes: [],
      reasonCode: "limit_reached",
    });

    const result = await beforeToolCall(
      { toolName: "web_search", toolCallId: "call-2" },
      makeHookContext(),
    );
    expect(result).toEqual({
      block: true,
      blockReason: expect.stringContaining("web_search"),
    });
  });

  it("uses toolBaseCosts for known tool", async () => {
    setup({ toolBaseCosts: { web_search: 999 } });
    mockFetchBudgetState.mockResolvedValue(makeSnapshot());
    mockIsAllowed.mockReturnValue(true);
    mockReserveBudget.mockResolvedValue({
      decision: "ALLOW",
      reservationId: "res-2",
      affectedScopes: [],
    });

    await beforeToolCall(
      { toolName: "web_search", toolCallId: "call-3" },
      makeHookContext(),
    );

    expect(mockReserveBudget).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ estimate: 999 }),
    );
  });

  it("falls back to DEFAULT_TOOL_COST (100000) for unknown tool", async () => {
    setup({ toolBaseCosts: {} });
    mockFetchBudgetState.mockResolvedValue(makeSnapshot());
    mockIsAllowed.mockReturnValue(true);
    mockReserveBudget.mockResolvedValue({
      decision: "ALLOW",
      reservationId: "res-3",
      affectedScopes: [],
    });

    await beforeToolCall(
      { toolName: "unknown_tool", toolCallId: "call-4" },
      makeHookContext(),
    );

    expect(mockReserveBudget).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ estimate: 100_000 }),
    );
  });

  it("builds correct actionKind", async () => {
    setup({ defaultToolActionKindPrefix: "tool." });
    mockFetchBudgetState.mockResolvedValue(makeSnapshot());
    mockIsAllowed.mockReturnValue(true);
    mockReserveBudget.mockResolvedValue({
      decision: "ALLOW",
      reservationId: "res-4",
      affectedScopes: [],
    });

    await beforeToolCall(
      { toolName: "code_exec", toolCallId: "call-5" },
      makeHookContext(),
    );

    expect(mockReserveBudget).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ actionKind: "tool.code_exec" }),
    );
  });
});

describe("afterToolCall", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("commits reservation when found", async () => {
    setup();
    mockFetchBudgetState.mockResolvedValue(makeSnapshot());
    mockIsAllowed.mockReturnValue(true);
    mockReserveBudget.mockResolvedValue({
      decision: "ALLOW",
      reservationId: "res-commit",
      affectedScopes: [],
    });
    mockCommitUsage.mockResolvedValue(undefined);

    // Create a reservation first
    await beforeToolCall(
      { toolName: "web_search", toolCallId: "call-commit" },
      makeHookContext(),
    );

    // Now settle it
    await afterToolCall(
      { toolName: "web_search", toolCallId: "call-commit" },
      makeHookContext(),
    );

    expect(mockCommitUsage).toHaveBeenCalledWith(
      expect.anything(),
      "res-commit",
      expect.any(Number),
      "USD_MICROCENTS",
      expect.anything(),
    );
  });

  it("removes reservation from map after commit", async () => {
    setup();
    mockFetchBudgetState.mockResolvedValue(makeSnapshot());
    mockIsAllowed.mockReturnValue(true);
    mockReserveBudget.mockResolvedValue({
      decision: "ALLOW",
      reservationId: "res-remove",
      affectedScopes: [],
    });
    mockCommitUsage.mockResolvedValue(undefined);

    await beforeToolCall(
      { toolName: "x", toolCallId: "call-remove" },
      makeHookContext(),
    );
    await afterToolCall(
      { toolName: "x", toolCallId: "call-remove" },
      makeHookContext(),
    );

    // Second afterToolCall for same callId should not commit
    mockCommitUsage.mockClear();
    await afterToolCall(
      { toolName: "x", toolCallId: "call-remove" },
      makeHookContext(),
    );
    expect(mockCommitUsage).not.toHaveBeenCalled();
  });

  it("logs debug and returns when no matching reservation", async () => {
    const { logger } = setup();
    mockFetchBudgetState.mockResolvedValue(makeSnapshot());

    await afterToolCall(
      { toolName: "x", toolCallId: "nonexistent" },
      makeHookContext(),
    );

    expect(mockCommitUsage).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalled();
  });
});

describe("agentEnd", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips release when no orphans, logs summary", async () => {
    const { logger } = setup();
    mockFetchBudgetState.mockResolvedValue(makeSnapshot());

    const ctx = makeHookContext();
    await agentEnd({}, ctx);

    expect(mockReleaseReservation).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("summary"),
      expect.anything(),
    );
  });

  it("releases orphaned reservations", async () => {
    setup();
    mockFetchBudgetState.mockResolvedValue(makeSnapshot());
    mockIsAllowed.mockReturnValue(true);
    mockReserveBudget.mockResolvedValue({
      decision: "ALLOW",
      reservationId: "orphan-1",
      affectedScopes: [],
    });
    mockReleaseReservation.mockResolvedValue(undefined);

    // Create a reservation but don't settle it
    await beforeToolCall(
      { toolName: "x", toolCallId: "orphan-call" },
      makeHookContext(),
    );

    // agent_end should release it
    await agentEnd({}, makeHookContext());

    expect(mockReleaseReservation).toHaveBeenCalledWith(
      expect.anything(),
      "orphan-1",
      "agent_end_cleanup",
      expect.anything(),
    );
  });

  it("clears map after releasing orphans", async () => {
    setup();
    mockFetchBudgetState.mockResolvedValue(makeSnapshot());
    mockIsAllowed.mockReturnValue(true);
    mockReserveBudget.mockResolvedValue({
      decision: "ALLOW",
      reservationId: "orphan-2",
      affectedScopes: [],
    });
    mockReleaseReservation.mockResolvedValue(undefined);
    mockCommitUsage.mockResolvedValue(undefined);

    await beforeToolCall(
      { toolName: "x", toolCallId: "orphan-call-2" },
      makeHookContext(),
    );
    await agentEnd({}, makeHookContext());

    // Second agentEnd should have no orphans
    mockReleaseReservation.mockClear();
    mockFetchBudgetState.mockResolvedValue(makeSnapshot());
    await agentEnd({}, makeHookContext());
    expect(mockReleaseReservation).not.toHaveBeenCalled();
  });

  it("attaches summary to ctx.metadata", async () => {
    setup();
    mockFetchBudgetState.mockResolvedValue(
      makeSnapshot({ remaining: 42, spent: 10, level: "healthy" }),
    );

    const ctx = makeHookContext();
    await agentEnd({}, ctx);

    expect(ctx.metadata!["cycles-budget-guard"]).toEqual(
      expect.objectContaining({
        remaining: 42,
        spent: 10,
        level: "healthy",
      }),
    );
  });

  it("summary includes totalReservationsMade", async () => {
    setup();
    mockFetchBudgetState.mockResolvedValue(makeSnapshot());
    mockIsAllowed.mockReturnValue(true);
    mockReserveBudget.mockResolvedValue({
      decision: "ALLOW",
      reservationId: "res-count",
      affectedScopes: [],
    });
    mockCommitUsage.mockResolvedValue(undefined);

    // Make 2 reservations
    await beforeToolCall(
      { toolName: "a", toolCallId: "c1" },
      makeHookContext(),
    );
    await afterToolCall({ toolName: "a", toolCallId: "c1" }, makeHookContext());
    await beforeToolCall(
      { toolName: "b", toolCallId: "c2" },
      makeHookContext(),
    );
    await afterToolCall({ toolName: "b", toolCallId: "c2" }, makeHookContext());

    const ctx = makeHookContext();
    await agentEnd({}, ctx);

    const summary = ctx.metadata!["cycles-budget-guard"] as Record<
      string,
      unknown
    >;
    expect(summary.totalReservationsMade).toBe(2);
  });
});
