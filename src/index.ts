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
import { createOtlpEmitter } from "./metrics-otlp.js";
import { PLUGIN_VERSION } from "./version.js";

import type { OpenClawPluginApi } from "./types.js";

export { BudgetExhaustedError, ToolBudgetDeniedError } from "./types.js";
export type {
  BudgetGuardConfig,
  BudgetLevel,
  BudgetSnapshot,
  BudgetTransitionEvent,
  BudgetStatusMetadata,
  CostEstimatorContext,
  ModelCostEstimatorContext,
  MetricsEmitter,
  StandardMetrics,
  SessionSummary,
  ReservationLogEntry,
  BurnRateAnomalyEvent,
  ExhaustionForecastEvent,
} from "./types.js";
export { createOtlpEmitter } from "./metrics-otlp.js";
export type { OtlpEmitterOptions } from "./metrics-otlp.js";

/** @internal Exported for testing only. */
export let startupBannerShown = false;

/** @internal Counter for differentiating init instances when no context ID is available. */
let initCount = 0;

/** @internal Reset startup banner flag (for testing). */
export function _resetStartupBanner(): void {
  startupBannerShown = false;
  initCount = 0;
}

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
    api.logger.warn(`[openclaw-budget-guard] Skipping registration: ${msg}`);
    return;
  }

  if (!config.enabled) {
    api.logger.info("[openclaw-budget-guard] Plugin disabled via config");
    return;
  }

  // OpenClaw may call the plugin entrypoint multiple times (once per channel/worker).
  // Show the full banner only once; subsequent inits get a short one-liner.
  if (!startupBannerShown) {
    startupBannerShown = true;

    const maskedKey = config.cyclesApiKey
      ? `****${config.cyclesApiKey.slice(-4)}`
      : "(not set)";
    const lines = [
      ``,
      `  Cycles Budget Guard for OpenClaw v${PLUGIN_VERSION}`,
      `  https://runcycles.io`,
      ``,
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
    if (config.defaultModelName) lines.push(`  defaultModelName: ${config.defaultModelName}`);
    if (Object.keys(config.modelFallbacks).length > 0)
      lines.push(`  modelFallbacks: ${Object.keys(config.modelFallbacks).join(", ")}`);
    if (Object.keys(config.toolBaseCosts).length > 0)
      lines.push(`  toolBaseCosts: ${Object.keys(config.toolBaseCosts).join(", ")}`);
    if (config.toolAllowlist) lines.push(`  toolAllowlist: ${config.toolAllowlist.join(", ")}`);
    if (config.toolBlocklist) lines.push(`  toolBlocklist: ${config.toolBlocklist.join(", ")}`);
    if (config.toolCallLimits && Object.keys(config.toolCallLimits).length > 0)
      lines.push(`  toolCallLimits: ${Object.entries(config.toolCallLimits).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    lines.push(`  lowBudgetStrategies: ${config.lowBudgetStrategies.join(", ")}`);
    if (config.lowBudgetStrategies.includes("limit_remaining_calls"))
      lines.push(`  maxRemainingCallsWhenLow: ${config.maxRemainingCallsWhenLow}`);
    api.logger.info(lines.join("\n"));

    // Warn about common misconfigurations so operators catch issues early.
    if (
      config.lowBudgetStrategies.includes("downgrade_model") &&
      Object.keys(config.modelFallbacks).length === 0
    ) {
      api.logger.warn(
        "[openclaw-budget-guard] Strategy 'downgrade_model' is enabled but no modelFallbacks configured — model downgrade will have no effect",
      );
    }
    if (
      config.lowBudgetStrategies.includes("disable_expensive_tools") &&
      config.expensiveToolThreshold === undefined &&
      Object.keys(config.toolBaseCosts).length === 0
    ) {
      api.logger.warn(
        "[openclaw-budget-guard] Strategy 'disable_expensive_tools' is enabled but no toolBaseCosts or expensiveToolThreshold configured — all tools use the default cost estimate",
      );
    }
    if (
      !config.lowBudgetStrategies.includes("limit_remaining_calls") &&
      config.maxRemainingCallsWhenLow !== 10 // 10 is the default — only warn if user explicitly set it
    ) {
      api.logger.warn(
        `[openclaw-budget-guard] maxRemainingCallsWhenLow is set to ${config.maxRemainingCallsWhenLow} but 'limit_remaining_calls' is not in lowBudgetStrategies — this setting will have no effect. Add "limit_remaining_calls" to lowBudgetStrategies to enable it.`,
      );
    }
    if (Object.keys(config.toolBaseCosts).length === 0) {
      api.logger.info(
        "[openclaw-budget-guard] No toolBaseCosts configured — all tools will use the default cost estimate (100,000 units). Set toolBaseCosts for accurate budgeting.",
      );
    }
  } else {
    // Try to extract a context identifier from the api object to differentiate channels
    const apiRecord = api as unknown as Record<string, unknown>;
    const context = asString(apiRecord.channelId)
      ?? asString(apiRecord.channel)
      ?? asString(apiRecord.workerId)
      ?? asString(apiRecord.id)
      ?? asString(apiRecord.scope);
    const instanceNum = ++initCount;
    const contextPart = context ? `, context=${context}` : "";
    api.logger.info(`Cycles Budget Guard initialized (tenant=${config.tenant}, dryRun=${config.dryRun}, instance=${instanceNum}${contextPart})`);
  }

  // Auto-detect model name from all available config surfaces if not set explicitly.
  // OpenClaw doesn't pass the model name in hook events, so we check everywhere we can.
  if (!config.defaultModelName) {
    const sysConfig = api.config as Record<string, unknown>;
    const pluginCfg = (api.pluginConfig ?? {}) as Record<string, unknown>;

    // Check system config (api.config) — the full OpenClaw config snapshot
    const fromSys = asString(sysConfig.model)
      ?? asString(sysConfig.defaultModel)
      ?? asString(sysConfig.model_name)
      ?? asString(sysConfig.modelName)
      ?? asString((sysConfig.agent as Record<string, unknown>)?.model)
      ?? asString((sysConfig.gateway as Record<string, unknown>)?.model)
      ?? asString((sysConfig.llm as Record<string, unknown>)?.model)
      ?? asString((sysConfig.provider as Record<string, unknown>)?.model);

    // Check plugin config (api.pluginConfig) — might have model in a non-standard field
    const fromPlugin = asString(pluginCfg.model)
      ?? asString(pluginCfg.modelName)
      ?? asString(pluginCfg.defaultModel);

    const detected = fromSys ?? fromPlugin;

    if (detected) {
      config.defaultModelName = detected;
      api.logger.info(`[openclaw-budget-guard] Auto-detected model: ${detected}`);
    } else {
      api.logger.info(
        `[openclaw-budget-guard] Could not auto-detect model name. ` +
        `Set defaultModelName in plugin config (e.g. "openai/gpt-5-nano"). ` +
        `System config keys: [${Object.keys(sysConfig).join(", ")}]. ` +
        `Plugin config keys: [${Object.keys(pluginCfg).join(", ")}].`
      );
    }
  }

  // v0.5.0: Auto-create OTLP metrics emitter if endpoint is configured and no custom emitter provided
  if (config.otlpMetricsEndpoint && !config.metricsEmitter) {
    config.metricsEmitter = createOtlpEmitter({
      endpoint: config.otlpMetricsEndpoint,
      headers: config.otlpMetricsHeaders,
    });
    api.logger.info(
      `[openclaw-budget-guard] OTLP metrics emitter configured → ${config.otlpMetricsEndpoint}`,
    );
  }

  initHooks(config, api.logger);

  api.on("before_model_resolve", beforeModelResolve, {
    name: "openclaw-budget-guard:before_model_resolve",
    priority: 10,
  });

  api.on("before_prompt_build", beforePromptBuild, {
    name: "openclaw-budget-guard:before_prompt_build",
    priority: 10,
  });

  api.on("before_tool_call", beforeToolCall, {
    name: "openclaw-budget-guard:before_tool_call",
    priority: 10,
  });

  api.on("after_tool_call", afterToolCall, {
    name: "openclaw-budget-guard:after_tool_call",
    priority: 10,
  });

  api.on("agent_end", agentEnd, {
    name: "openclaw-budget-guard:agent_end",
    priority: 100,
  });
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
