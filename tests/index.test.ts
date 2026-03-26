import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeConfig, makeLogger } from "./helpers.js";

// Mock dependencies — use vi.hoisted so these are available when vi.mock runs
const {
  mockResolveConfig,
  mockInitHooks,
  mockBeforeModelResolve,
  mockBeforePromptBuild,
  mockBeforeToolCall,
  mockAfterToolCall,
  mockAgentEnd,
} = vi.hoisted(() => ({
  mockResolveConfig: vi.fn(),
  mockInitHooks: vi.fn(),
  mockBeforeModelResolve: vi.fn(),
  mockBeforePromptBuild: vi.fn(),
  mockBeforeToolCall: vi.fn(),
  mockAfterToolCall: vi.fn(),
  mockAgentEnd: vi.fn(),
}));

vi.mock("../src/config.js", () => ({
  resolveConfig: (...args: unknown[]) => mockResolveConfig(...args),
}));

vi.mock("../src/hooks.js", () => ({
  initHooks: (...args: unknown[]) => mockInitHooks(...args),
  beforeModelResolve: mockBeforeModelResolve,
  beforePromptBuild: mockBeforePromptBuild,
  beforeToolCall: mockBeforeToolCall,
  afterToolCall: mockAfterToolCall,
  agentEnd: mockAgentEnd,
}));

import registerPlugin, {
  BudgetExhaustedError,
  ToolBudgetDeniedError,
} from "../src/index.js";

describe("re-exported error types", () => {
  it("exports BudgetExhaustedError", () => {
    expect(BudgetExhaustedError).toBeDefined();
    const err = new BudgetExhaustedError(0);
    expect(err.code).toBe("BUDGET_EXHAUSTED");
  });

  it("exports ToolBudgetDeniedError", () => {
    expect(ToolBudgetDeniedError).toBeDefined();
    const err = new ToolBudgetDeniedError("test-tool");
    expect(err.code).toBe("TOOL_BUDGET_DENIED");
  });
});

describe("plugin entrypoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers all 5 hooks when enabled", () => {
    const config = makeConfig({ enabled: true });
    mockResolveConfig.mockReturnValue(config);

    const onCalls: Array<{ name: string; priority: number }> = [];
    const api = {
      config: {},
      logger: makeLogger(),
      on: vi.fn((name: string, _handler: unknown, opts?: { priority?: number; name?: string }) => {
        onCalls.push({ name, priority: opts?.priority ?? 0 });
      }),
    };

    registerPlugin(api);

    expect(api.on).toHaveBeenCalledTimes(5);
    const hookNames = onCalls.map((c) => c.name);
    expect(hookNames).toContain("before_model_resolve");
    expect(hookNames).toContain("before_prompt_build");
    expect(hookNames).toContain("before_tool_call");
    expect(hookNames).toContain("after_tool_call");
    expect(hookNames).toContain("agent_end");
  });

  it("registers 0 hooks when disabled", () => {
    mockResolveConfig.mockReturnValue(makeConfig({ enabled: false }));

    const api = {
      config: {},
      logger: makeLogger(),
      on: vi.fn(),
    };

    registerPlugin(api);
    expect(api.on).not.toHaveBeenCalled();
  });

  it("uses priority 10 for first 4 hooks, 100 for agent_end", () => {
    mockResolveConfig.mockReturnValue(makeConfig());

    const priorities: Record<string, number> = {};
    const api = {
      config: {},
      logger: makeLogger(),
      on: vi.fn((name: string, _handler: unknown, opts?: { priority?: number }) => {
        priorities[name] = opts?.priority ?? 0;
      }),
    };

    registerPlugin(api);

    expect(priorities["before_model_resolve"]).toBe(10);
    expect(priorities["before_prompt_build"]).toBe(10);
    expect(priorities["before_tool_call"]).toBe(10);
    expect(priorities["after_tool_call"]).toBe(10);
    expect(priorities["agent_end"]).toBe(100);
  });

  it("hook names include cycles-budget-guard: prefix", () => {
    mockResolveConfig.mockReturnValue(makeConfig());

    const names: string[] = [];
    const api = {
      config: {},
      logger: makeLogger(),
      on: vi.fn((_hookName: string, _handler: unknown, opts?: { name?: string }) => {
        if (opts?.name) names.push(opts.name);
      }),
    };

    registerPlugin(api);

    expect(names).toHaveLength(5);
    for (const name of names) {
      expect(name).toMatch(/^cycles-budget-guard:/);
    }
  });

  it("uses api.pluginConfig when available", () => {
    const pluginCfg = { tenant: "test", cyclesBaseUrl: "http://localhost:7878" };
    mockResolveConfig.mockReturnValue(makeConfig());

    const api = {
      config: { some: "system-config" },
      pluginConfig: pluginCfg,
      logger: makeLogger(),
      on: vi.fn(),
    };

    registerPlugin(api);
    expect(mockResolveConfig).toHaveBeenCalledWith(pluginCfg);
  });

  it("falls back to api.config when pluginConfig is absent", () => {
    const rawConfig = { tenant: "test" };
    mockResolveConfig.mockReturnValue(makeConfig());

    const api = {
      config: rawConfig,
      logger: makeLogger(),
      on: vi.fn(),
    };

    registerPlugin(api);
    expect(mockResolveConfig).toHaveBeenCalledWith(rawConfig);
  });

  it("logs warning and skips registration when config is missing", () => {
    mockResolveConfig.mockImplementation(() => {
      throw new Error("[cycles-budget-guard] tenant is required in config");
    });

    const logger = makeLogger();
    const api = {
      config: {},
      logger,
      on: vi.fn(),
    };

    registerPlugin(api);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Skipping registration"),
    );
    expect(api.on).not.toHaveBeenCalled();
  });

  it("handles non-Error throws in catch path", () => {
    mockResolveConfig.mockImplementation(() => {
      throw "string error";
    });

    const logger = makeLogger();
    const api = {
      config: {},
      logger,
      on: vi.fn(),
    };

    registerPlugin(api);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("string error"),
    );
    expect(api.on).not.toHaveBeenCalled();
  });

  it("logs startup summary with all optional config fields", () => {
    mockResolveConfig.mockReturnValue(makeConfig({
      budgetId: "my-app",
      modelFallbacks: { "gpt-4o": "gpt-4o-mini" },
      toolBaseCosts: { web_search: 500000 },
      toolAllowlist: ["web_search", "code_*"],
      toolBlocklist: ["dangerous_*"],
    }));

    const logger = makeLogger();
    const api = {
      config: {},
      logger,
      on: vi.fn(),
    };

    registerPlugin(api);
    const infoCall = (logger.info as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(infoCall).toContain("v0.3.4 starting");
    expect(infoCall).toContain("tenant: test-tenant");
    expect(infoCall).toContain("cyclesApiKey: ****-key");
    expect(infoCall).toContain("budgetId: my-app");
    expect(infoCall).toContain("modelFallbacks: gpt-4o");
    expect(infoCall).toContain("toolBaseCosts: web_search");
    expect(infoCall).toContain("toolAllowlist: web_search, code_*");
    expect(infoCall).toContain("toolBlocklist: dangerous_*");
  });

  it("masks empty API key as '(not set)' in startup summary", () => {
    mockResolveConfig.mockReturnValue(makeConfig({
      cyclesApiKey: "",
    }));

    const logger = makeLogger();
    const api = {
      config: {},
      logger,
      on: vi.fn(),
    };

    registerPlugin(api);
    const infoCall = (logger.info as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(infoCall).toContain("cyclesApiKey: (not set)");
  });

  it("calls initHooks with resolved config and api.logger", () => {
    const resolvedConfig = makeConfig();
    mockResolveConfig.mockReturnValue(resolvedConfig);

    const logger = makeLogger();
    const api = {
      config: {},
      logger,
      on: vi.fn(),
    };

    registerPlugin(api);
    expect(mockInitHooks).toHaveBeenCalledWith(resolvedConfig, logger);
  });

  it("warns when downgrade_model strategy has no modelFallbacks", () => {
    mockResolveConfig.mockReturnValue(makeConfig({
      lowBudgetStrategies: ["downgrade_model"],
      modelFallbacks: {},
    }));

    const logger = makeLogger();
    const api = { config: {}, logger, on: vi.fn() };
    registerPlugin(api);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("no modelFallbacks configured"),
    );
  });

  it("warns when disable_expensive_tools has no toolBaseCosts or threshold", () => {
    mockResolveConfig.mockReturnValue(makeConfig({
      lowBudgetStrategies: ["disable_expensive_tools"],
      toolBaseCosts: {},
      expensiveToolThreshold: undefined,
    }));

    const logger = makeLogger();
    const api = { config: {}, logger, on: vi.fn() };
    registerPlugin(api);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("no toolBaseCosts or expensiveToolThreshold configured"),
    );
  });

  it("logs info when no toolBaseCosts configured", () => {
    mockResolveConfig.mockReturnValue(makeConfig({
      lowBudgetStrategies: [],
      toolBaseCosts: {},
    }));

    const logger = makeLogger();
    const api = { config: {}, logger, on: vi.fn() };
    registerPlugin(api);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("No toolBaseCosts configured"),
    );
  });

  it("includes toolCallLimits in startup summary", () => {
    mockResolveConfig.mockReturnValue(makeConfig({
      lowBudgetStrategies: [],
      toolBaseCosts: { web_search: 100 },
      toolCallLimits: { send_email: 10, deploy: 3 },
    }));

    const logger = makeLogger();
    const api = { config: {}, logger, on: vi.fn() };
    registerPlugin(api);
    const infoCall = (logger.info as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(infoCall).toContain("toolCallLimits: send_email=10, deploy=3");
  });
});
