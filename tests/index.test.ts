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

  it("calls resolveConfig with api.config when flat", () => {
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

  it("unwraps config wrapper when OpenClaw nests under config key", () => {
    const inner = { tenant: "test", cyclesBaseUrl: "http://localhost:7878" };
    mockResolveConfig.mockReturnValue(makeConfig());

    const api = {
      config: { config: inner },
      logger: makeLogger(),
      on: vi.fn(),
    };

    registerPlugin(api);
    expect(mockResolveConfig).toHaveBeenCalledWith(inner);
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
});
