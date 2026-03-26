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
  // OpenClaw wraps plugin config under a "config" key in the entry object.
  // Unwrap if present so resolveConfig sees the flat config values.
  const raw = api.config as Record<string, unknown>;
  const unwrapped = (raw.config && typeof raw.config === "object" && !Array.isArray(raw.config))
    ? raw.config as Record<string, unknown>
    : raw;

  let config;
  try {
    config = resolveConfig(unwrapped);
  } catch (err) {
    // During plugin install, config may not be available yet.
    // Log and skip registration so install can complete.
    const msg = err instanceof Error ? err.message : String(err);
    api.logger.warn(`[cycles-budget-guard] Skipping registration: ${msg}`);
    return;
  }

  if (!config.enabled) {
    return;
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
