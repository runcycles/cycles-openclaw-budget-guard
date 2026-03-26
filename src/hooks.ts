/**
 * OpenClaw lifecycle hook implementations.
 *
 * All hooks follow the OpenClaw (event, ctx) => result pattern.
 * Module-level state is initialized once via initHooks().
 */

import { type CyclesClient, isAllowed } from "runcycles";

import type {
  ActiveReservation,
  AgentEndEvent,
  BudgetGuardConfig,
  BudgetLevel,
  BudgetSnapshot,
  HookContext,
  ModelResolveEvent,
  ModelResolveResult,
  OpenClawLogger,
  PromptBuildEvent,
  PromptBuildResult,
  SessionSummary,
  ToolCallEvent,
  ToolCallResult,
  ToolResultEvent,
} from "./types.js";

import {
  BudgetExhaustedError,
} from "./types.js";

import {
  createCyclesClient,
  fetchBudgetState,
  reserveBudget,
  commitUsage,
  releaseReservation,
} from "./cycles.js";

import { formatBudgetHint, isToolPermitted, type ForecastData } from "./budget.js";
import { createLogger } from "./logger.js";
import { DryRunClient } from "./dry-run.js";

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let client: CyclesClient;
let config: BudgetGuardConfig;
let logger: OpenClawLogger;

/** In-flight reservations keyed by callId (tools) or model:<uuid> (models). */
const activeReservations = new Map<string, ActiveReservation>();

/** Cached budget snapshot with configurable time-based freshness. */
let cachedSnapshot: BudgetSnapshot | undefined;
let cachedSnapshotAt = 0;

/** Session-level counters for the final summary. */
let totalReservationsMade = 0;

/** Gap 5: Last known budget level for transition detection. */
let lastKnownLevel: BudgetLevel | undefined;

/** Gap 6: Per-component cost breakdown. */
const costBreakdown = new Map<string, { count: number; totalCost: number }>();

/** Gap 9: Running totals for forecast. */
let totalToolCost = 0;
let totalToolCalls = 0;
let totalModelCost = 0;
let totalModelCalls = 0;

/** Gap 13: Remaining calls counter for limit_remaining_calls strategy. */
let remainingCallsAllowed = 0;

/** Per-tool invocation counters for toolCallLimits enforcement. */
const toolCallCounts = new Map<string, number>();

/** Tools already warned about missing toolBaseCosts entry. */
const warnedUnconfiguredTools = new Set<string>();

/** Gap 15: Session start time. */
let sessionStartedAt = 0;

/** Resolved userId/sessionId (from config + ctx overrides). */
let resolvedUserId: string | undefined;
let resolvedSessionId: string | undefined;


// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

export function initHooks(
  pluginConfig: BudgetGuardConfig,
  apiLogger?: OpenClawLogger,
): void {
  config = pluginConfig;
  logger = apiLogger ?? createLogger(config.logLevel);

  // Gap 10: Dry-run mode
  if (config.dryRun) {
    client = new DryRunClient(config.dryRunBudget, config.currency) as unknown as CyclesClient;
    logger.info(
      `[DRY-RUN] Plugin initialized with simulated budget=${config.dryRunBudget} tenant=${config.tenant}`,
    );
  } else {
    client = createCyclesClient(config);
    logger.info(`Plugin initialized tenant=${config.tenant}`);
  }

  cachedSnapshot = undefined;
  cachedSnapshotAt = 0;
  totalReservationsMade = 0;
  lastKnownLevel = undefined;
  activeReservations.clear();
  costBreakdown.clear();
  toolCallCounts.clear();
  warnedUnconfiguredTools.clear();
  totalToolCost = 0;
  totalToolCalls = 0;
  totalModelCost = 0;
  totalModelCalls = 0;
  remainingCallsAllowed = config.maxRemainingCallsWhenLow;
  sessionStartedAt = Date.now();
  resolvedUserId = config.userId;
  resolvedSessionId = config.sessionId;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function getSnapshot(ctx?: HookContext): Promise<BudgetSnapshot> {
  const now = Date.now();
  if (cachedSnapshot && now - cachedSnapshotAt < config.snapshotCacheTtlMs) {
    return cachedSnapshot;
  }
  const userId = (ctx?.metadata?.userId as string | undefined) ?? resolvedUserId;
  const sessionId = (ctx?.metadata?.sessionId as string | undefined) ?? resolvedSessionId;
  cachedSnapshot = await fetchBudgetState(client, config, logger, { userId, sessionId });
  cachedSnapshotAt = now;

  // Gap 5: Detect budget level transitions
  if (lastKnownLevel !== undefined && cachedSnapshot.level !== lastKnownLevel) {
    const event = {
      previousLevel: lastKnownLevel,
      currentLevel: cachedSnapshot.level,
      remaining: cachedSnapshot.remaining,
      timestamp: now,
    };
    try {
      config.onBudgetTransition?.(event);
    } catch (err) {
      logger.warn("onBudgetTransition callback error:", err);
    }
    if (config.budgetTransitionWebhookUrl) {
      fireWebhook(config.budgetTransitionWebhookUrl, event);
    }
  }
  lastKnownLevel = cachedSnapshot.level;

  return cachedSnapshot;
}

function invalidateSnapshotCache(): void {
  cachedSnapshot = undefined;
  cachedSnapshotAt = 0;
}

/** Gap 12: Attach budget status to ctx.metadata for end-user visibility. */
function attachBudgetStatus(ctx: HookContext, snapshot: BudgetSnapshot): void {
  if (ctx.metadata) {
    ctx.metadata["cycles-budget-guard-status"] = {
      level: snapshot.level,
      remaining: snapshot.remaining,
      allocated: snapshot.allocated,
      percentRemaining:
        snapshot.allocated && snapshot.allocated > 0
          ? Math.round((snapshot.remaining / snapshot.allocated) * 100)
          : undefined,
    };
  }
}

/** Gap 6: Update cost breakdown tracking. */
function trackCost(key: string, cost: number): void {
  const entry = costBreakdown.get(key);
  if (entry) {
    entry.count++;
    entry.totalCost += cost;
  } else {
    costBreakdown.set(key, { count: 1, totalCost: cost });
  }
}

/** Gap 9: Build forecast data from running totals. */
function buildForecast(): ForecastData {
  return {
    avgToolCost: totalToolCalls > 0 ? totalToolCost / totalToolCalls : 0,
    avgModelCost: totalModelCalls > 0 ? totalModelCost / totalModelCalls : 0,
    totalToolCalls,
    totalModelCalls,
  };
}

/** Fire a webhook POST (best-effort, non-blocking). */
function fireWebhook(url: string, payload: unknown): void {
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch((err) => {
    logger.warn(`Webhook POST to ${url} failed:`, err);
  });
}

/** Gap 17: Sleep utility for retry. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DEFAULT_TOOL_COST = 100_000;
const DEFAULT_MODEL_COST = 500_000;

// ---------------------------------------------------------------------------
// Hook: before_model_resolve
// ---------------------------------------------------------------------------

export async function beforeModelResolve(
  event: ModelResolveEvent,
  ctx: HookContext,
): Promise<ModelResolveResult | undefined> {
  // Gap 3: Resolve user/session from ctx if available
  if (ctx.metadata?.userId) resolvedUserId = ctx.metadata.userId as string;
  if (ctx.metadata?.sessionId) resolvedSessionId = ctx.metadata.sessionId as string;

  const snapshot = await getSnapshot(ctx);
  logger.debug(`before_model_resolve: model=${event.model} level=${snapshot.level}`);

  // Gap 12: Attach status for end-user visibility
  attachBudgetStatus(ctx, snapshot);

  let resolvedModel = event.model;

  if (snapshot.level === "low") {
    // Gap 4: Chained model fallbacks
    const fallbacks = config.modelFallbacks[event.model];
    if (fallbacks) {
      const candidates = Array.isArray(fallbacks) ? fallbacks : [fallbacks];
      for (const candidate of candidates) {
        const cost = config.modelBaseCosts[candidate] ?? config.defaultModelCost;
        if (cost <= snapshot.remaining) {
          logger.info(
            `Budget low (${snapshot.remaining} remaining) — downgrading model ${event.model} → ${candidate}`,
          );
          resolvedModel = candidate;
          break;
        }
      }
    } else {
      logger.debug(`Budget low but no fallback configured for model ${event.model}`);
    }

    // Gap 13: Apply low-budget strategies
    if (config.lowBudgetStrategies.includes("limit_remaining_calls") && remainingCallsAllowed <= 0) {
      if (config.failClosed) {
        throw new BudgetExhaustedError(snapshot.remaining);
      }
      logger.warn("Low budget call limit reached, failClosed=false — allowing");
    }
  }

  if (snapshot.level === "exhausted") {
    if (config.failClosed) {
      logger.warn(
        `Budget exhausted (${snapshot.remaining} remaining) — blocking model resolve for ${event.model}`,
      );
      throw new BudgetExhaustedError(snapshot.remaining);
    }
    logger.warn(
      `Budget exhausted (${snapshot.remaining} remaining) — failClosed=false, allowing ${event.model}`,
    );
  }

  // Gap 1: Reserve budget for model call
  const modelCost = config.modelBaseCosts[resolvedModel] ?? config.defaultModelCost;
  const modelCurrency = config.modelCurrency ?? config.currency;
  const actionKind = config.defaultModelActionKind;

  const result = await reserveBudget(client, config, {
    actionKind,
    actionName: resolvedModel,
    estimate: modelCost,
    unit: modelCurrency,
  });

  if (!isAllowed(result.decision)) {
    if (config.failClosed) {
      logger.warn(
        `Model reservation denied for ${resolvedModel} (decision=${result.decision})`,
      );
      throw new BudgetExhaustedError(snapshot.remaining);
    }
    logger.warn(
      `Model reservation denied for ${resolvedModel}, failClosed=false — allowing`,
    );
  } else {
    totalReservationsMade++;

    if (result.reservationId) {
      // Commit immediately — no after_model_resolve hook exists in OpenClaw,
      // so model cost is always estimated (not reconciled with actual tokens).
      await commitUsage(client, result.reservationId, modelCost, modelCurrency, logger);
    }

    // Gap 6 & 9: Track model cost
    trackCost(`model:${resolvedModel}`, modelCost);
    totalModelCost += modelCost;
    totalModelCalls++;

    invalidateSnapshotCache();
  }

  if (resolvedModel !== event.model) {
    return { modelOverride: resolvedModel };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Hook: before_prompt_build
// ---------------------------------------------------------------------------

export async function beforePromptBuild(
  _event: PromptBuildEvent,
  ctx: HookContext,
): Promise<PromptBuildResult | undefined> {
  if (!config.injectPromptBudgetHint) return undefined;

  const snapshot = await getSnapshot(ctx);

  // Gap 12: Attach status
  attachBudgetStatus(ctx, snapshot);

  // Gap 9: Include forecast data in hint
  const forecast = buildForecast();
  const hint = formatBudgetHint(snapshot, config, forecast);
  logger.debug(`before_prompt_build: injecting hint (${hint.length} chars)`);

  // Gap 13: Append max-tokens guidance when strategy is active
  let fullHint = hint;
  if (
    snapshot.level === "low" &&
    config.lowBudgetStrategies.includes("reduce_max_tokens")
  ) {
    fullHint += ` Limit responses to ${config.maxTokensWhenLow} tokens.`;
    if (fullHint.length > config.maxPromptHintChars) {
      fullHint = fullHint.slice(0, config.maxPromptHintChars - 3) + "...";
    }
  }

  return { prependSystemContext: fullHint };
}

// ---------------------------------------------------------------------------
// Hook: before_tool_call
// ---------------------------------------------------------------------------

export async function beforeToolCall(
  event: ToolCallEvent,
  ctx: HookContext,
): Promise<ToolCallResult | undefined> {
  const toolName = event.toolName;

  // Resolve user/session from ctx if available (consistent with beforeModelResolve)
  if (ctx.metadata?.userId) resolvedUserId = ctx.metadata.userId as string;
  if (ctx.metadata?.sessionId) resolvedSessionId = ctx.metadata.sessionId as string;

  // Gap 7: Check tool allowlist/blocklist
  const permission = isToolPermitted(toolName, config.toolAllowlist, config.toolBlocklist);
  if (!permission.permitted) {
    logger.warn(`Tool "${toolName}" blocked by access list: ${permission.reason}`);
    return { block: true, blockReason: permission.reason };
  }

  // Enforce per-tool invocation limits
  if (config.toolCallLimits) {
    const limit = config.toolCallLimits[toolName];
    if (limit !== undefined) {
      const count = toolCallCounts.get(toolName) ?? 0;
      if (count >= limit) {
        logger.warn(`Tool "${toolName}" blocked: call limit ${limit} reached (${count} calls)`);
        return {
          block: true,
          blockReason: `Tool "${toolName}" exceeded session call limit (${limit})`,
        };
      }
    }
  }

  // Gap 12: Attach budget status
  const snapshot = await getSnapshot(ctx);
  attachBudgetStatus(ctx, snapshot);

  // Log once per tool when using default cost estimate
  const estimate = config.toolBaseCosts[toolName] ?? DEFAULT_TOOL_COST;
  if (!(toolName in config.toolBaseCosts) && !warnedUnconfiguredTools.has(toolName)) {
    warnedUnconfiguredTools.add(toolName);
    logger.info(
      `Tool "${toolName}" has no entry in toolBaseCosts — using default estimate (${DEFAULT_TOOL_COST} ${config.currency}). Add it to toolBaseCosts for accurate budgeting.`,
    );
  }

  // Gap 13: Disable expensive tools when budget is low
  if (
    snapshot.level === "low" &&
    config.lowBudgetStrategies.includes("disable_expensive_tools")
  ) {
    const threshold = config.expensiveToolThreshold ?? config.lowBudgetThreshold / 10;
    if (estimate > threshold) {
      logger.warn(
        `Tool "${toolName}" blocked: cost ${estimate} exceeds expensive threshold ${threshold}`,
      );
      return {
        block: true,
        blockReason: `Tool "${toolName}" disabled during low budget (cost ${estimate} exceeds threshold ${threshold})`,
      };
    }
  }

  // Gap 13: Limit remaining calls
  if (
    snapshot.level === "low" &&
    config.lowBudgetStrategies.includes("limit_remaining_calls") &&
    remainingCallsAllowed <= 0
  ) {
    logger.warn(`Tool "${toolName}" blocked: remaining call limit reached`);
    return {
      block: true,
      blockReason: `Tool call limit reached during low budget (max ${config.maxRemainingCallsWhenLow} calls)`,
    };
  }

  const actionKind = config.defaultToolActionKindPrefix + toolName;
  const ttlMs = config.toolReservationTtls?.[toolName] ?? config.reservationTtlMs;
  const overagePolicy = config.toolOveragePolicies?.[toolName] ?? config.overagePolicy;
  const unit = config.toolCurrencies?.[toolName] ?? config.currency;

  logger.debug(
    `before_tool_call: tool=${toolName} callId=${event.toolCallId} estimate=${estimate}`,
  );

  const result = await reserveBudget(client, config, {
    actionKind,
    actionName: toolName,
    estimate,
    ttlMs,
    overagePolicy,
    unit,
  });

  if (!isAllowed(result.decision)) {
    // Gap 17: Retry on deny
    if (config.retryOnDeny) {
      for (let attempt = 0; attempt < config.maxRetries; attempt++) {
        logger.debug(
          `Tool "${toolName}" denied, retry ${attempt + 1}/${config.maxRetries} after ${config.retryDelayMs}ms`,
        );
        await sleep(config.retryDelayMs);
        invalidateSnapshotCache();
        const retry = await reserveBudget(client, config, {
          actionKind,
          actionName: toolName,
          estimate,
          ttlMs,
          overagePolicy,
          unit,
        });
        if (isAllowed(retry.decision)) {
          totalReservationsMade++;
          if (retry.reservationId) {
            activeReservations.set(event.toolCallId, {
              reservationId: retry.reservationId,
              estimate,
              toolName,
              createdAt: Date.now(),
              kind: "tool",
              currency: unit,
            });
          }
          toolCallCounts.set(toolName, (toolCallCounts.get(toolName) ?? 0) + 1);
          if (snapshot.level === "low" && config.lowBudgetStrategies.includes("limit_remaining_calls")) {
            remainingCallsAllowed--;
          }
          invalidateSnapshotCache();
          return undefined;
        }
      }
    }

    logger.warn(
      `Tool "${toolName}" denied by Cycles (decision=${result.decision}, reason=${result.reasonCode ?? "none"})`,
    );
    return {
      block: true,
      blockReason: `Budget reservation denied for tool "${toolName}": ${result.reasonCode ?? "budget limit reached"}`,
    };
  }

  totalReservationsMade++;

  if (result.reservationId) {
    activeReservations.set(event.toolCallId, {
      reservationId: result.reservationId,
      estimate,
      toolName,
      createdAt: Date.now(),
      kind: "tool",
      currency: unit,
    });
  }

  // Track per-tool invocation count for toolCallLimits
  toolCallCounts.set(toolName, (toolCallCounts.get(toolName) ?? 0) + 1);

  // Gap 13: Decrement remaining calls counter
  if (snapshot.level === "low" && config.lowBudgetStrategies.includes("limit_remaining_calls")) {
    remainingCallsAllowed--;
  }

  invalidateSnapshotCache();
  return undefined;
}

// ---------------------------------------------------------------------------
// Hook: after_tool_call
// ---------------------------------------------------------------------------

export async function afterToolCall(
  event: ToolResultEvent,
  _ctx: HookContext,
): Promise<void> {
  const reservation = activeReservations.get(event.toolCallId);
  if (!reservation) {
    logger.debug(
      `after_tool_call: no active reservation for callId=${event.toolCallId}`,
    );
    return;
  }

  activeReservations.delete(event.toolCallId);

  // Gap 2: Use cost estimator if available, otherwise use estimate
  let actual = reservation.estimate;
  if (config.costEstimator) {
    try {
      const computed = config.costEstimator({
        toolName: reservation.toolName,
        estimate: reservation.estimate,
        durationMs: event.durationMs,
        result: event.result,
      });
      if (computed !== undefined) actual = computed;
    } catch (err) {
      logger.warn(`costEstimator threw for tool=${reservation.toolName}, using estimate:`, err);
    }
  }

  const unit = reservation.currency ?? config.currency;
  await commitUsage(client, reservation.reservationId, actual, unit, logger);
  logger.debug(
    `after_tool_call: committed ${actual} for tool=${reservation.toolName}`,
  );

  // Gap 6 & 9: Track tool cost
  trackCost(`tool:${reservation.toolName}`, actual);
  totalToolCost += actual;
  totalToolCalls++;

  invalidateSnapshotCache();
}

// ---------------------------------------------------------------------------
// Hook: agent_end
// ---------------------------------------------------------------------------

export async function agentEnd(
  _event: AgentEndEvent,
  ctx: HookContext,
): Promise<void> {
  // Release any orphaned reservations
  if (activeReservations.size > 0) {
    logger.warn(
      `agent_end: releasing ${activeReservations.size} orphaned reservation(s)`,
    );
    const releases = [...activeReservations.values()].map((r) =>
      releaseReservation(client, r.reservationId, "agent_end_cleanup", logger),
    );
    await Promise.allSettled(releases);
    activeReservations.clear();
  }

  // Fetch final budget state for summary
  invalidateSnapshotCache();
  const snapshot = await getSnapshot(ctx);

  // Gap 6: Build cost breakdown as plain object
  const breakdown: Record<string, { count: number; totalCost: number }> = {};
  for (const [key, value] of costBreakdown) {
    breakdown[key] = { count: value.count, totalCost: value.totalCost };
  }

  // Gap 9: Include forecast data
  const forecast = buildForecast();

  // Build per-tool call counts as plain object
  const callCounts: Record<string, number> = {};
  for (const [key, value] of toolCallCounts) {
    callCounts[key] = value;
  }

  const summary: SessionSummary = {
    tenant: config.tenant,
    budgetId: config.budgetId,
    userId: resolvedUserId,
    sessionId: resolvedSessionId,
    remaining: snapshot.remaining,
    spent: snapshot.spent,
    reserved: snapshot.reserved,
    allocated: snapshot.allocated,
    level: snapshot.level,
    totalReservationsMade,
    costBreakdown: breakdown,
    toolCallCounts: callCounts,
    startedAt: sessionStartedAt,
    endedAt: Date.now(),
  };

  logger.info(`Agent session budget summary: remaining=${summary.remaining} spent=${summary.spent} reservations=${summary.totalReservationsMade}`);

  // Attach to context metadata if available
  if (ctx.metadata) {
    ctx.metadata["cycles-budget-guard"] = {
      ...summary,
      avgToolCost: forecast.avgToolCost,
      avgModelCost: forecast.avgModelCost,
      estimatedRemainingToolCalls:
        forecast.avgToolCost > 0 ? Math.floor(snapshot.remaining / forecast.avgToolCost) : undefined,
      estimatedRemainingModelCalls:
        forecast.avgModelCost > 0 ? Math.floor(snapshot.remaining / forecast.avgModelCost) : undefined,
    };
  }

  // Gap 15: Cross-session analytics
  if (config.onSessionEnd) {
    try {
      await config.onSessionEnd(summary);
    } catch (err) {
      logger.warn("onSessionEnd callback error:", err);
    }
  }
  if (config.analyticsWebhookUrl) {
    fireWebhook(config.analyticsWebhookUrl, summary);
  }
}
