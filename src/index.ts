/**
 * cycles-openclaw-budget-guard
 *
 * OpenClaw plugin entrypoint. Exports a default function that receives the
 * OpenClaw plugin API and registers lifecycle hooks for budget-aware model
 * and tool execution via api.on().
 */

import { resolveConfig } from "./config.js";
import {
  initHooks,
  beforeModelResolve,
  beforePromptBuild,
  beforeToolCall,
  afterToolCall,
  agentEnd,
} from "./hooks.js";

import type { OpenClawPluginApi } from "./types.js";

export { BudgetExhaustedError, ToolBudgetDeniedError } from "./types.js";
export type {
  BudgetGuardConfig,
  BudgetLevel,
  BudgetSnapshot,
  BudgetTransitionEvent,
  BudgetStatusMetadata,
  CostEstimatorContext,
  SessionSummary,
} from "./types.js";

export default function (api: OpenClawPluginApi): void {
  // OpenClaw provides plugin-specific config on api.pluginConfig (from
  // plugins.entries.<id>.config in openclaw.json). Fall back to api.config
  // for older OpenClaw versions or direct invocation in tests.
  const raw = (api.pluginConfig ?? api.config) as Record<string, unknown>;

  let config;
  try {
    config = resolveConfig(raw);
  } catch (err) {
    // During plugin install, config may not be available yet.
    // Log and skip registration so install can complete.
    const msg = err instanceof Error ? err.message : String(err);
    api.logger.warn(`[cycles-budget-guard] Skipping registration: ${msg}`);
    return;
  }

  if (!config.enabled) {
    api.logger.info("[cycles-budget-guard] Plugin disabled via config");
    return;
  }

  // Log resolved config summary on startup so operators can verify settings.
  const maskedKey = config.cyclesApiKey
    ? `****${config.cyclesApiKey.slice(-4)}`
    : "(not set)";
  const lines = [
    `[cycles-budget-guard] v0.4.0 starting`,
    `  tenant: ${config.tenant}`,
    `  cyclesBaseUrl: ${config.cyclesBaseUrl}`,
    `  cyclesApiKey: ${maskedKey}`,
    `  currency: ${config.currency}`,
    `  failClosed: ${config.failClosed}`,
    `  dryRun: ${config.dryRun}`,
    `  logLevel: ${config.logLevel}`,
    `  lowBudgetThreshold: ${config.lowBudgetThreshold}`,
    `  exhaustedThreshold: ${config.exhaustedThreshold}`,
  ];
  if (config.budgetId) lines.push(`  budgetId: ${config.budgetId}`);
  if (Object.keys(config.modelFallbacks).length > 0)
    lines.push(`  modelFallbacks: ${Object.keys(config.modelFallbacks).join(", ")}`);
  if (Object.keys(config.toolBaseCosts).length > 0)
    lines.push(`  toolBaseCosts: ${Object.keys(config.toolBaseCosts).join(", ")}`);
  if (config.toolAllowlist) lines.push(`  toolAllowlist: ${config.toolAllowlist.join(", ")}`);
  if (config.toolBlocklist) lines.push(`  toolBlocklist: ${config.toolBlocklist.join(", ")}`);
  if (config.toolCallLimits && Object.keys(config.toolCallLimits).length > 0)
    lines.push(`  toolCallLimits: ${Object.entries(config.toolCallLimits).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  api.logger.info(lines.join("\n"));

  // Warn about common misconfigurations so operators catch issues early.
  if (
    config.lowBudgetStrategies.includes("downgrade_model") &&
    Object.keys(config.modelFallbacks).length === 0
  ) {
    api.logger.warn(
      "[cycles-budget-guard] Strategy 'downgrade_model' is enabled but no modelFallbacks configured — model downgrade will have no effect",
    );
  }
  if (
    config.lowBudgetStrategies.includes("disable_expensive_tools") &&
    config.expensiveToolThreshold === undefined &&
    Object.keys(config.toolBaseCosts).length === 0
  ) {
    api.logger.warn(
      "[cycles-budget-guard] Strategy 'disable_expensive_tools' is enabled but no toolBaseCosts or expensiveToolThreshold configured — all tools use the default cost estimate",
    );
  }
  if (Object.keys(config.toolBaseCosts).length === 0) {
    api.logger.info(
      "[cycles-budget-guard] No toolBaseCosts configured — all tools will use the default cost estimate (100,000 units). Set toolBaseCosts for accurate budgeting.",
    );
  }

  initHooks(config, api.logger);

  api.on("before_model_resolve", beforeModelResolve, {
    name: "cycles-budget-guard:before_model_resolve",
    priority: 10,
  });

  api.on("before_prompt_build", beforePromptBuild, {
    name: "cycles-budget-guard:before_prompt_build",
    priority: 10,
  });

  api.on("before_tool_call", beforeToolCall, {
    name: "cycles-budget-guard:before_tool_call",
    priority: 10,
  });

  api.on("after_tool_call", afterToolCall, {
    name: "cycles-budget-guard:after_tool_call",
    priority: 10,
  });

  api.on("agent_end", agentEnd, {
    name: "cycles-budget-guard:agent_end",
    priority: 100,
  });
}
