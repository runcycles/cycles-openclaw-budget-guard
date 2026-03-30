import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeConfig, makeLogger } from "./helpers.js";

// Mock runcycles module
const mockGetBalances = vi.fn();
const mockCreateReservation = vi.fn();
const mockCommitReservation = vi.fn();
const mockReleaseReservation = vi.fn();

vi.mock("runcycles", () => ({
  CyclesClient: vi.fn().mockImplementation(function () {
    return {
      getBalances: mockGetBalances,
      createReservation: mockCreateReservation,
      commitReservation: mockCommitReservation,
      releaseReservation: mockReleaseReservation,
    };
  }),
  CyclesConfig: vi.fn().mockImplementation(function () {
    return {};
  }),
  balanceResponseFromWire: vi.fn((body) => body),
  reservationCreateResponseFromWire: vi.fn((body) => body),
  isAllowed: vi.fn(),
}));

// Mock crypto.randomUUID for deterministic tests
vi.mock("node:crypto", () => ({
  randomUUID: vi.fn(() => "test-uuid-1234"),
}));

import {
  createCyclesClient,
  fetchBudgetState,
  reserveBudget,
  commitUsage,
  releaseReservation,
} from "../src/cycles.js";
import { CyclesConfig } from "runcycles";

describe("createCyclesClient", () => {
  it("passes config to CyclesConfig", () => {
    const config = makeConfig();
    createCyclesClient(config);
    expect(CyclesConfig).toHaveBeenCalledWith({
      baseUrl: config.cyclesBaseUrl,
      apiKey: config.cyclesApiKey,
      tenant: config.tenant,
    });
  });

  it("returns a client object", () => {
    const client = createCyclesClient(makeConfig());
    expect(client).toBeDefined();
    expect(client.getBalances).toBeDefined();
  });
});

describe("fetchBudgetState", () => {
  const config = makeConfig();
  const logger = makeLogger();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns BudgetSnapshot on success", async () => {
    mockGetBalances.mockResolvedValue({
      isSuccess: true,
      body: {
        balances: [
          {
            scope: "tenant:test",
            scopePath: "/test",
            remaining: { unit: "USD_MICROCENTS", amount: 50_000_000 },
            reserved: { unit: "USD_MICROCENTS", amount: 1_000_000 },
            spent: { unit: "USD_MICROCENTS", amount: 5_000_000 },
            allocated: { unit: "USD_MICROCENTS", amount: 100_000_000 },
          },
        ],
      },
    });

    const client = createCyclesClient(config);
    const snapshot = await fetchBudgetState(client, config, logger);

    expect(snapshot.remaining).toBe(50_000_000);
    expect(snapshot.reserved).toBe(1_000_000);
    expect(snapshot.spent).toBe(5_000_000);
    expect(snapshot.allocated).toBe(100_000_000);
    expect(snapshot.level).toBe("healthy");
  });

  it("returns fail-open snapshot on API error without errorMessage", async () => {
    mockGetBalances.mockResolvedValue({
      isSuccess: false,
      status: 500,
      errorMessage: undefined,
    });

    const client = createCyclesClient(config);
    const snapshot = await fetchBudgetState(client, config, logger);

    expect(snapshot.remaining).toBe(Infinity);
    expect(snapshot.level).toBe("healthy");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("unknown"),
    );
  });

  it("returns fail-open snapshot on API error", async () => {
    mockGetBalances.mockResolvedValue({
      isSuccess: false,
      status: 500,
      errorMessage: "server error",
    });

    const client = createCyclesClient(config);
    const snapshot = await fetchBudgetState(client, config, logger);

    expect(snapshot.remaining).toBe(Infinity);
    expect(snapshot.level).toBe("healthy");
    expect(logger.warn).toHaveBeenCalled();
  });

  it("returns fail-open snapshot on network exception", async () => {
    mockGetBalances.mockRejectedValue(new Error("DNS resolution failed"));

    const client = createCyclesClient(config);
    const snapshot = await fetchBudgetState(client, config, logger);

    expect(snapshot.remaining).toBe(Infinity);
    expect(snapshot.level).toBe("healthy");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("network error"),
    );
  });

  it("returns fail-open snapshot when no matching balance", async () => {
    mockGetBalances.mockResolvedValue({
      isSuccess: true,
      body: { balances: [] },
    });

    const client = createCyclesClient(config);
    const snapshot = await fetchBudgetState(client, config, logger);

    expect(snapshot.remaining).toBe(Infinity);
    expect(snapshot.level).toBe("healthy");
  });

  it("returns fail-open snapshot when balances exist but none match configured currency", async () => {
    mockGetBalances.mockResolvedValue({
      isSuccess: true,
      body: {
        balances: [
          {
            scope: "tenant:test",
            scopePath: "/test",
            remaining: { unit: "EUR_MICROCENTS", amount: 500 },
            reserved: { unit: "EUR_MICROCENTS", amount: 0 },
            spent: { unit: "EUR_MICROCENTS", amount: 100 },
          },
        ],
      },
    });

    const client = createCyclesClient(config);
    const snapshot = await fetchBudgetState(client, config, logger);

    // Should NOT use the EUR balance for USD_MICROCENTS comparisons
    expect(snapshot.remaining).toBe(Infinity);
    expect(snapshot.level).toBe("healthy");
  });

  it("passes budgetId as app param when set", async () => {
    const cfgWithBudget = makeConfig({ budgetId: "my-app" });
    mockGetBalances.mockResolvedValue({
      isSuccess: true,
      body: {
        balances: [
          {
            scope: "tenant:test",
            scopePath: "/test",
            remaining: { unit: "USD_MICROCENTS", amount: 10 },
          },
        ],
      },
    });

    const client = createCyclesClient(cfgWithBudget);
    await fetchBudgetState(client, cfgWithBudget, logger);

    expect(mockGetBalances).toHaveBeenCalledWith({
      tenant: "test-tenant",
      app: "my-app",
    });
  });

  it("omits app param when budgetId is undefined", async () => {
    mockGetBalances.mockResolvedValue({
      isSuccess: true,
      body: {
        balances: [
          {
            scope: "tenant:test",
            scopePath: "/test",
            remaining: { unit: "USD_MICROCENTS", amount: 10 },
          },
        ],
      },
    });

    const client = createCyclesClient(config);
    await fetchBudgetState(client, config, logger);

    expect(mockGetBalances).toHaveBeenCalledWith({ tenant: "test-tenant" });
  });

  it("does not pass userId/sessionId as balance query params (Gap 3)", async () => {
    const cfgWithUser = makeConfig({ userId: "user-1", sessionId: "sess-1" });
    mockGetBalances.mockResolvedValue({
      isSuccess: true,
      body: {
        balances: [
          {
            scope: "tenant:test",
            scopePath: "/test",
            remaining: { unit: "USD_MICROCENTS", amount: 10 },
          },
        ],
      },
    });

    const client = createCyclesClient(cfgWithUser);
    await fetchBudgetState(client, cfgWithUser, logger);

    // userId/sessionId are only used in reservation subjects via dimensions,
    // not in balance query params (getBalances only supports standard subject filters)
    expect(mockGetBalances).toHaveBeenCalledWith({
      tenant: "test-tenant",
    });
  });

  it("prefers balance matching configured currency", async () => {
    mockGetBalances.mockResolvedValue({
      isSuccess: true,
      body: {
        balances: [
          {
            scope: "a",
            scopePath: "/a",
            remaining: { unit: "TOKENS", amount: 999 },
          },
          {
            scope: "b",
            scopePath: "/b",
            remaining: { unit: "USD_MICROCENTS", amount: 42 },
          },
        ],
      },
    });

    const client = createCyclesClient(config);
    const snapshot = await fetchBudgetState(client, config, logger);
    expect(snapshot.remaining).toBe(42);
  });

  it("returns fail-open when no balance matches configured currency", async () => {
    mockGetBalances.mockResolvedValue({
      isSuccess: true,
      body: {
        balances: [
          {
            scope: "a",
            scopePath: "/a",
            remaining: { unit: "TOKENS", amount: 777 },
          },
          {
            scope: "b",
            scopePath: "/b",
            remaining: { unit: "CREDITS", amount: 888 },
          },
        ],
      },
    });

    const client = createCyclesClient(config);
    const snapshot = await fetchBudgetState(client, config, logger);
    // Should NOT use a wrong-currency balance for budget decisions
    expect(snapshot.remaining).toBe(Infinity);
    expect(snapshot.level).toBe("healthy");
  });

  it("prefers balance with budgetId in scope", async () => {
    const cfgWithBudget = makeConfig({ budgetId: "my-app" });
    mockGetBalances.mockResolvedValue({
      isSuccess: true,
      body: {
        balances: [
          {
            scope: "tenant:test",
            scopePath: "/test",
            remaining: { unit: "USD_MICROCENTS", amount: 100 },
          },
          {
            scope: "tenant:test:my-app",
            scopePath: "/test/my-app",
            remaining: { unit: "USD_MICROCENTS", amount: 42 },
          },
        ],
      },
    });

    const client = createCyclesClient(cfgWithBudget);
    const snapshot = await fetchBudgetState(client, cfgWithBudget, logger);
    expect(snapshot.remaining).toBe(42);
  });

  it("extracts pool balance when parentBudgetId is set (Gap 18)", async () => {
    const cfgWithPool = makeConfig({ parentBudgetId: "team-pool", budgetId: "my-app" });
    mockGetBalances.mockResolvedValue({
      isSuccess: true,
      body: {
        balances: [
          {
            scope: "tenant:test:my-app",
            scopePath: "/test/my-app",
            remaining: { unit: "USD_MICROCENTS", amount: 5_000_000 },
            allocated: { unit: "USD_MICROCENTS", amount: 10_000_000 },
          },
          {
            scope: "tenant:test:team-pool",
            scopePath: "/test/team-pool",
            remaining: { unit: "USD_MICROCENTS", amount: 50_000_000 },
            allocated: { unit: "USD_MICROCENTS", amount: 100_000_000 },
          },
        ],
      },
    });

    const client = createCyclesClient(cfgWithPool);
    const snapshot = await fetchBudgetState(client, cfgWithPool, logger);

    expect(snapshot.remaining).toBe(5_000_000);
    expect(snapshot.poolRemaining).toBe(50_000_000);
    expect(snapshot.poolAllocated).toBe(100_000_000);
  });

  it("returns undefined pool balance when parentBudgetId set but no match found (Gap 18)", async () => {
    const cfgWithPool = makeConfig({ parentBudgetId: "team-pool", budgetId: "my-app" });
    mockGetBalances.mockResolvedValue({
      isSuccess: true,
      body: {
        balances: [
          {
            scope: "tenant:test:my-app",
            scopePath: "/test/my-app",
            remaining: { unit: "USD_MICROCENTS", amount: 5_000_000 },
          },
          // No balance matching "team-pool" in scope
        ],
      },
    });

    const client = createCyclesClient(cfgWithPool);
    const snapshot = await fetchBudgetState(client, cfgWithPool, logger);

    expect(snapshot.remaining).toBe(5_000_000);
    expect(snapshot.poolRemaining).toBeUndefined();
    expect(snapshot.poolAllocated).toBeUndefined();
  });
});

describe("reserveBudget", () => {
  const config = makeConfig();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns parsed response on success", async () => {
    mockCreateReservation.mockResolvedValue({
      isSuccess: true,
      body: {
        decision: "ALLOW",
        reservationId: "res-123",
        affectedScopes: ["/test"],
      },
    });

    const client = createCyclesClient(config);
    const result = await reserveBudget(client, config, {
      actionKind: "tool.web_search",
      actionName: "web_search",
      estimate: 500_000,
    });

    expect(result.decision).toBe("ALLOW");
    expect(result.reservationId).toBe("res-123");
  });

  it("builds correct wire body with defaults", async () => {
    mockCreateReservation.mockResolvedValue({
      isSuccess: true,
      body: { decision: "ALLOW", affectedScopes: [] },
    });

    const client = createCyclesClient(config);
    await reserveBudget(client, config, {
      actionKind: "tool.code_exec",
      actionName: "code_exec",
      estimate: 1_000_000,
    });

    expect(mockCreateReservation).toHaveBeenCalledWith({
      idempotency_key: "test-uuid-1234",
      subject: { tenant: "test-tenant" },
      action: { kind: "tool.code_exec", name: "code_exec" },
      estimate: { unit: "USD_MICROCENTS", amount: 1_000_000 },
      ttl_ms: 60_000,
      overage_policy: "ALLOW_IF_AVAILABLE",
    });
  });

  it("includes budgetId as app in subject when set", async () => {
    const cfgWithBudget = makeConfig({ budgetId: "my-app" });
    mockCreateReservation.mockResolvedValue({
      isSuccess: true,
      body: { decision: "ALLOW", affectedScopes: [] },
    });

    const client = createCyclesClient(cfgWithBudget);
    await reserveBudget(client, cfgWithBudget, {
      actionKind: "tool.x",
      actionName: "x",
      estimate: 100,
    });

    expect(mockCreateReservation).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: { tenant: "test-tenant", app: "my-app" },
      }),
    );
  });

  it("includes userId and sessionId in subject dimensions (Gap 3)", async () => {
    const cfgWithUser = makeConfig({ userId: "u1", sessionId: "s1" });
    mockCreateReservation.mockResolvedValue({
      isSuccess: true,
      body: { decision: "ALLOW", affectedScopes: [] },
    });

    const client = createCyclesClient(cfgWithUser);
    await reserveBudget(client, cfgWithUser, {
      actionKind: "tool.x",
      actionName: "x",
      estimate: 100,
    });

    expect(mockCreateReservation).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: {
          tenant: "test-tenant",
          dimensions: { user: "u1", session: "s1" },
        },
      }),
    );
  });

  it("uses custom TTL from opts (Gap 8)", async () => {
    mockCreateReservation.mockResolvedValue({
      isSuccess: true,
      body: { decision: "ALLOW", affectedScopes: [] },
    });

    const client = createCyclesClient(config);
    await reserveBudget(client, config, {
      actionKind: "tool.x",
      actionName: "x",
      estimate: 100,
      ttlMs: 120_000,
    });

    expect(mockCreateReservation).toHaveBeenCalledWith(
      expect.objectContaining({ ttl_ms: 120_000 }),
    );
  });

  it("uses custom overage policy from opts (Gap 16)", async () => {
    mockCreateReservation.mockResolvedValue({
      isSuccess: true,
      body: { decision: "ALLOW", affectedScopes: [] },
    });

    const client = createCyclesClient(config);
    await reserveBudget(client, config, {
      actionKind: "tool.x",
      actionName: "x",
      estimate: 100,
      overagePolicy: "ALLOW_IF_AVAILABLE",
    });

    expect(mockCreateReservation).toHaveBeenCalledWith(
      expect.objectContaining({ overage_policy: "ALLOW_IF_AVAILABLE" }),
    );
  });

  it("uses custom unit from opts (Gap 14)", async () => {
    mockCreateReservation.mockResolvedValue({
      isSuccess: true,
      body: { decision: "ALLOW", affectedScopes: [] },
    });

    const client = createCyclesClient(config);
    await reserveBudget(client, config, {
      actionKind: "tool.x",
      actionName: "x",
      estimate: 100,
      unit: "TOKENS",
    });

    expect(mockCreateReservation).toHaveBeenCalledWith(
      expect.objectContaining({
        estimate: { unit: "TOKENS", amount: 100 },
      }),
    );
  });

  it("omits app from subject when budgetId is undefined", async () => {
    mockCreateReservation.mockResolvedValue({
      isSuccess: true,
      body: { decision: "ALLOW", affectedScopes: [] },
    });

    const client = createCyclesClient(config);
    await reserveBudget(client, config, {
      actionKind: "tool.x",
      actionName: "x",
      estimate: 100,
    });

    expect(mockCreateReservation).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: { tenant: "test-tenant" },
      }),
    );
  });

  it("returns synthetic DENY on API error", async () => {
    mockCreateReservation.mockResolvedValue({
      isSuccess: false,
      errorMessage: "server down",
    });

    const client = createCyclesClient(config);
    const result = await reserveBudget(client, config, {
      actionKind: "tool.x",
      actionName: "x",
      estimate: 100,
    });

    expect(result.decision).toBe("DENY");
    expect(result.affectedScopes).toEqual([]);
    expect(result.reasonCode).toBe("server down");
  });

  it("uses 'reservation_failed' as default reason on error without message", async () => {
    mockCreateReservation.mockResolvedValue({
      isSuccess: false,
      errorMessage: undefined,
    });

    const client = createCyclesClient(config);
    const result = await reserveBudget(client, config, {
      actionKind: "tool.x",
      actionName: "x",
      estimate: 100,
    });

    expect(result.reasonCode).toBe("reservation_failed");
  });

  it("returns synthetic DENY on network exception", async () => {
    mockCreateReservation.mockRejectedValue(new Error("connection refused"));

    const client = createCyclesClient(config);
    const result = await reserveBudget(client, config, {
      actionKind: "tool.x",
      actionName: "x",
      estimate: 100,
    });

    expect(result.decision).toBe("DENY");
    expect(result.reasonCode).toBe("reservation_network_error");
  });

  it("retries on 429 status and succeeds on second attempt", async () => {
    const retryConfig = makeConfig({
      retryableStatusCodes: [429],
      transientRetryMaxAttempts: 2,
      transientRetryBaseDelayMs: 1,
    });
    mockCreateReservation
      .mockResolvedValueOnce({ isSuccess: false, status: 429, errorMessage: "rate_limited" })
      .mockResolvedValueOnce({
        isSuccess: true,
        status: 200,
        body: { decision: "ALLOW", reservation_id: "r-retry", affected_scopes: [] },
      });

    const client = createCyclesClient(retryConfig);
    const result = await reserveBudget(client, retryConfig, {
      actionKind: "tool.test",
      actionName: "test",
      estimate: 100,
    });

    expect(result.decision).toBe("ALLOW");
    expect(mockCreateReservation).toHaveBeenCalledTimes(2);
  });

  it("returns DENY after exhausting retry attempts on 503", async () => {
    const retryConfig = makeConfig({
      retryableStatusCodes: [503],
      transientRetryMaxAttempts: 1,
      transientRetryBaseDelayMs: 1,
    });
    mockCreateReservation.mockResolvedValue({
      isSuccess: false, status: 503, errorMessage: "service_unavailable",
    });

    const client = createCyclesClient(retryConfig);
    const result = await reserveBudget(client, retryConfig, {
      actionKind: "tool.test",
      actionName: "test",
      estimate: 100,
    });

    expect(result.decision).toBe("DENY");
    // 1 initial + 1 retry = 2 attempts
    expect(mockCreateReservation).toHaveBeenCalledTimes(2);
  });

  it("retries on network error and returns DENY if all attempts fail", async () => {
    const retryConfig = makeConfig({
      transientRetryMaxAttempts: 1,
      transientRetryBaseDelayMs: 1,
    });
    mockCreateReservation.mockRejectedValue(new Error("network error"));

    const client = createCyclesClient(retryConfig);
    const result = await reserveBudget(client, retryConfig, {
      actionKind: "tool.test",
      actionName: "test",
      estimate: 100,
    });

    expect(result.decision).toBe("DENY");
    expect(result.reasonCode).toBe("reservation_network_error");
    // 1 initial + 1 retry = 2 attempts
    expect(mockCreateReservation).toHaveBeenCalledTimes(2);
  });
});

describe("commitUsage", () => {
  const logger = makeLogger();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("commits successfully without warning", async () => {
    mockCommitReservation.mockResolvedValue({
      isSuccess: true,
      body: { status: "committed" },
    });

    const client = createCyclesClient(makeConfig());
    await commitUsage(client, "res-ok", 500_000, "USD_MICROCENTS", logger);
    expect(mockCommitReservation).toHaveBeenCalledWith("res-ok", {
      idempotency_key: "test-uuid-1234",
      actual: { unit: "USD_MICROCENTS", amount: 500_000 },
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("does not throw on API error", async () => {
    mockCommitReservation.mockResolvedValue({
      isSuccess: false,
      status: 500,
    });

    const client = createCyclesClient(makeConfig());
    await expect(
      commitUsage(client, "res-1", 500_000, "USD_MICROCENTS", logger),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("does not throw when client throws", async () => {
    mockCommitReservation.mockRejectedValue(new Error("network fail"));

    const client = createCyclesClient(makeConfig());
    await expect(
      commitUsage(client, "res-1", 500_000, "USD_MICROCENTS", logger),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("includes StandardMetrics in commit body when provided", async () => {
    mockCommitReservation.mockResolvedValue({
      isSuccess: true,
      body: { status: "committed" },
    });

    const client = createCyclesClient(makeConfig());
    await commitUsage(client, "res-metrics", 500_000, "USD_MICROCENTS", logger, {
      model_version: "gpt-4o",
      tokens_input: 1200,
      tokens_output: 800,
      latency_ms: 2500,
    });
    expect(mockCommitReservation).toHaveBeenCalledWith("res-metrics", {
      idempotency_key: "test-uuid-1234",
      actual: { unit: "USD_MICROCENTS", amount: 500_000 },
      metrics: {
        model_version: "gpt-4o",
        tokens_input: 1200,
        tokens_output: 800,
        latency_ms: 2500,
      },
    });
  });

  it("omits metrics from commit body when not provided", async () => {
    mockCommitReservation.mockResolvedValue({
      isSuccess: true,
      body: { status: "committed" },
    });

    const client = createCyclesClient(makeConfig());
    await commitUsage(client, "res-no-metrics", 500_000, "USD_MICROCENTS", logger);
    const callBody = mockCommitReservation.mock.calls[0][1] as Record<string, unknown>;
    expect(callBody).not.toHaveProperty("metrics");
  });
});

describe("releaseReservation", () => {
  const logger = makeLogger();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("releases successfully", async () => {
    mockReleaseReservation.mockResolvedValue({
      isSuccess: true,
      body: { status: "released" },
    });

    const client = createCyclesClient(makeConfig());
    await releaseReservation(client, "res-ok", "cleanup", logger);
    expect(mockReleaseReservation).toHaveBeenCalledWith("res-ok", {
      idempotency_key: "test-uuid-1234",
      reason: "cleanup",
    });
  });

  it("does not throw on API error", async () => {
    mockReleaseReservation.mockResolvedValue({
      isSuccess: false,
      status: 404,
    });

    const client = createCyclesClient(makeConfig());
    await expect(
      releaseReservation(client, "res-1", "cleanup", logger),
    ).resolves.toBeUndefined();
  });

  it("does not throw when client throws", async () => {
    mockReleaseReservation.mockRejectedValue(new Error("boom"));

    const client = createCyclesClient(makeConfig());
    await expect(
      releaseReservation(client, "res-1", "cleanup", logger),
    ).resolves.toBeUndefined();
  });
});
