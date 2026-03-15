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
export type { BudgetGuardConfig, BudgetLevel, BudgetSnapshot } from "./types.js";

export default function (api: OpenClawPluginApi): void {
  const config = resolveConfig(api.config);

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
