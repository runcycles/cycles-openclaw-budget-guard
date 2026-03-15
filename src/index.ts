/**
 * cycles-openclaw-budget-guard
 *
 * OpenClaw plugin entrypoint. Exports a default register function that
 * returns lifecycle hooks for budget-aware model and tool execution.
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

export default function register(
  pluginConfig: Record<string, unknown>,
): Record<string, unknown> {
  const config = resolveConfig(pluginConfig);

  if (!config.enabled) {
    return {};
  }

  initHooks(config);

  return {
    before_model_resolve: beforeModelResolve,
    before_prompt_build: beforePromptBuild,
    before_tool_call: beforeToolCall,
    after_tool_call: afterToolCall,
    agent_end: agentEnd,
  };
}
