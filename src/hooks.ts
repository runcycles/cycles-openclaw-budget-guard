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
  MetricsEmitter,
  ModelResolveEvent,
  ModelResolveResult,
  OpenClawLogger,
  PromptBuildEvent,
  PromptBuildResult,
  ReservationLogEntry,
  SessionSummary,
  StandardMetrics,
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

/** v0.5.0: Pending model reservation for reserve-then-commit pattern. */
let pendingModelReservation: ActiveReservation | undefined;
let pendingModelName: string | undefined;

/** v0.5.0: Turn counter for model cost estimator context. */
let turnIndex = 0;

/** v0.5.0: Metrics emitter reference (from config or OTLP auto-creation). */
let metricsEmitter: MetricsEmitter | undefined;

/** v0.5.0: Base tags for all metrics. */
let baseTags: Record<string, string> = {};

/** v0.6.0: Heartbeat timers for long-running tool reservations. */
const heartbeatTimers = new Map<string, ReturnType<typeof setInterval>>();

/** v0.6.0: Session event log. */
const eventLog: ReservationLogEntry[] = [];

/** v0.6.0: Burn rate tracking — cost snapshots per window. */
let windowCostAtStart = 0;
let windowStartedAt = 0;
let lastBurnRate = 0;
let exhaustionWarningFired = false;


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

  // v0.5.0: Reset model reservation tracking
  pendingModelReservation = undefined;
  pendingModelName = undefined;
  turnIndex = 0;

  // v0.5.0: Set up metrics emitter
  metricsEmitter = config.metricsEmitter;
  baseTags = { tenant: config.tenant };
  if (config.budgetId) baseTags.budgetId = config.budgetId;

  // v0.6.0: Reset new state
  for (const timer of heartbeatTimers.values()) clearInterval(timer);
  heartbeatTimers.clear();
  eventLog.length = 0;
  windowCostAtStart = 0;
  windowStartedAt = Date.now();
  lastBurnRate = 0;
  exhaustionWarningFired = false;
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

  // v0.5.0: Emit budget gauge metrics
  emitGauge("cycles.budget.remaining", cachedSnapshot.remaining, { currency: config.currency });
  emitGauge("cycles.budget.reserved", cachedSnapshot.reserved);
  emitGauge("cycles.budget.spent", cachedSnapshot.spent);
  const levelValue = cachedSnapshot.level === "healthy" ? 0 : cachedSnapshot.level === "low" ? 1 : 2;
  emitGauge("cycles.budget.level", levelValue, { level: cachedSnapshot.level });

  return cachedSnapshot;
}

function invalidateSnapshotCache(): void {
  cachedSnapshot = undefined;
  cachedSnapshotAt = 0;
}

/** Gap 12: Attach budget status to ctx.metadata for end-user visibility. */
function attachBudgetStatus(ctx: HookContext, snapshot: BudgetSnapshot): void {
  if (ctx.metadata) {
    ctx.metadata["openclaw-budget-guard-status"] = {
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

/** v0.5.0: Safe metrics emission (never throws). */
function emitGauge(name: string, value: number, tags?: Record<string, string>): void {
  if (!metricsEmitter) return;
  try { metricsEmitter.gauge(name, value, { ...baseTags, ...tags }); } catch { /* best-effort */ }
}
function emitCounter(name: string, delta: number, tags?: Record<string, string>): void {
  if (!metricsEmitter) return;
  try { metricsEmitter.counter(name, delta, { ...baseTags, ...tags }); } catch { /* best-effort */ }
}
function emitHistogram(name: string, value: number, tags?: Record<string, string>): void {
  if (!metricsEmitter) return;
  try { metricsEmitter.histogram(name, value, { ...baseTags, ...tags }); } catch { /* best-effort */ }
}

const MAX_EVENT_LOG_ENTRIES = 10_000;

/** v0.6.0: Append to event log if enabled. Capped to prevent unbounded growth. */
function logEvent(entry: ReservationLogEntry): void {
  if (!config.enableEventLog) return;
  if (eventLog.length >= MAX_EVENT_LOG_ENTRIES) eventLog.shift();
  eventLog.push(entry);
}

/** v0.6.0: Get current session cost total. */
function sessionCostTotal(): number {
  let total = 0;
  for (const e of costBreakdown.values()) total += e.totalCost;
  return total;
}

/** v0.6.0: Check burn rate and fire anomaly if needed. */
function checkBurnRate(remaining: number): void {
  const now = Date.now();
  const elapsed = now - windowStartedAt;
  if (elapsed < config.burnRateWindowMs || elapsed <= 0) return;

  const currentTotal = sessionCostTotal();
  const windowCost = currentTotal - windowCostAtStart;
  const currentRate = windowCost / elapsed; // cost per ms

  if (lastBurnRate > 0 && currentRate > 0) {
    const ratio = currentRate / lastBurnRate;
    if (ratio >= config.burnRateAlertThreshold) {
      logger.warn(
        `Burn rate anomaly: ${ratio.toFixed(1)}x above average (threshold: ${config.burnRateAlertThreshold}x)`,
      );
      emitCounter("cycles.budget.burn_rate_anomaly", 1, { ratio: ratio.toFixed(1) });
      const event = {
        currentBurnRate: currentRate,
        averageBurnRate: lastBurnRate,
        ratio,
        threshold: config.burnRateAlertThreshold,
        windowMs: config.burnRateWindowMs,
        remaining,
        timestamp: now,
      };
      try { config.onBurnRateAnomaly?.(event); } catch { /* best-effort */ }
    }
  }

  lastBurnRate = currentRate > 0 ? currentRate : lastBurnRate;
  windowCostAtStart = currentTotal;
  windowStartedAt = now;
}

/** v0.6.0: Check if budget will exhaust soon and warn. */
function checkExhaustionForecast(remaining: number): void {
  if (exhaustionWarningFired || remaining === Infinity) return;
  const elapsed = Date.now() - sessionStartedAt;
  if (elapsed < 1000) return; // need at least 1s of data

  const totalCost = sessionCostTotal();
  if (totalCost <= 0) return;

  const burnRatePerMs = totalCost / elapsed;
  if (burnRatePerMs <= 0) return;
  const msRemaining = remaining / burnRatePerMs;

  if (msRemaining < config.exhaustionWarningThresholdMs) {
    exhaustionWarningFired = true;
    logger.warn(
      `Budget exhaustion forecast: ~${Math.round(msRemaining / 1000)}s remaining at current burn rate`,
    );
    emitGauge("cycles.budget.exhaustion_forecast_ms", msRemaining);
    const event = {
      estimatedMsRemaining: msRemaining,
      burnRatePerMs,
      remaining,
      timestamp: Date.now(),
    };
    try { config.onExhaustionForecast?.(event); } catch { /* best-effort */ }
  }
}

/** v0.6.0: Start heartbeat timer for a tool reservation. */
function startHeartbeat(toolCallId: string, reservationId: string): void {
  if (config.heartbeatIntervalMs <= 0) return;
  const timer = setInterval(async () => {
    try {
      const body: Record<string, unknown> = {
        idempotency_key: `extend-${reservationId}-${Date.now()}`,
        extend_by_ms: config.heartbeatIntervalMs,
      };
      // Use client.extendReservation if available, otherwise skip
      if ("extendReservation" in client && typeof (client as unknown as Record<string, unknown>).extendReservation === "function") {
        await (client as unknown as { extendReservation(id: string, body: Record<string, unknown>): Promise<unknown> })
          .extendReservation(reservationId, body);
        logger.debug(`Heartbeat: extended reservation ${reservationId} for tool callId=${toolCallId}`);
      }
    } catch {
      logger.debug(`Heartbeat: failed to extend reservation ${reservationId}`);
    }
  }, config.heartbeatIntervalMs);
  if (typeof timer === "object" && "unref" in timer) timer.unref();
  heartbeatTimers.set(toolCallId, timer);
}

/** v0.6.0: Stop heartbeat timer for a tool call. */
function stopHeartbeat(toolCallId: string): void {
  const timer = heartbeatTimers.get(toolCallId);
  if (timer) {
    clearInterval(timer);
    heartbeatTimers.delete(toolCallId);
  }
}

/** v0.5.0: Commit pending model reservation from previous turn. */
async function commitPendingModelReservation(): Promise<void> {
  if (!pendingModelReservation) return;

  const reservation = pendingModelReservation;
  const modelName = pendingModelName ?? "unknown";
  pendingModelReservation = undefined;
  pendingModelName = undefined;

  let actual = reservation.estimate;
  if (config.modelCostEstimator) {
    try {
      const computed = config.modelCostEstimator({
        model: modelName,
        estimatedCost: reservation.estimate,
        turnIndex: turnIndex - 1,
      });
      if (computed !== undefined) actual = computed;
    } catch (err) {
      logger.warn(`modelCostEstimator threw for model=${modelName}, using estimate:`, err);
    }
  }

  const unit = reservation.currency ?? config.currency;
  const metrics: StandardMetrics = { model_version: modelName };
  await commitUsage(client, reservation.reservationId, actual, unit, logger, metrics);
  logger.debug(`Committed model reservation for ${modelName}: ${actual} ${unit}`);

  trackCost(`model:${modelName}`, actual);
  totalModelCost += actual;
  totalModelCalls++;

  emitCounter("cycles.reservation.committed", 1, { kind: "model", name: modelName });
  emitHistogram("cycles.reservation.cost", actual, { kind: "model", name: modelName });
  logEvent({ timestamp: Date.now(), hook: "commit_model", action: "commit", kind: "model", name: modelName, amount: actual, budgetLevel: cachedSnapshot?.level ?? "healthy", remaining: cachedSnapshot?.remaining ?? 0 });

  invalidateSnapshotCache();
  if (config.aggressiveCacheInvalidation) {
    await getSnapshot();
  }
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

  // Resolve model name from event — OpenClaw may pass it in different fields,
  // or not at all (only 'prompt' key). Fall back to config.defaultModelName.
  const eventRecord = event as Record<string, unknown>;
  const eventModel = event.model
    ?? eventRecord.modelId as string | undefined
    ?? eventRecord.modelName as string | undefined
    ?? eventRecord.model_id as string | undefined
    ?? eventRecord.model_name as string | undefined
    ?? config.defaultModelName;
  if (!eventModel) {
    logger.warn(`before_model_resolve: cannot determine model name (event keys: ${Object.keys(event).join(", ")}). Set defaultModelName in plugin config to enable model budget tracking.`);
    attachBudgetStatus(ctx, snapshot);
    return undefined;
  }

  logger.debug(`before_model_resolve: model=${eventModel} level=${snapshot.level}`);

  // Gap 12: Attach status for end-user visibility
  attachBudgetStatus(ctx, snapshot);

  let resolvedModel = eventModel;

  if (snapshot.level === "low") {
    // Gap 4: Chained model fallbacks
    const fallbacks = config.modelFallbacks[eventModel];
    if (fallbacks) {
      const candidates = Array.isArray(fallbacks) ? fallbacks : [fallbacks];
      for (const candidate of candidates) {
        const cost = config.modelBaseCosts[candidate] ?? config.defaultModelCost;
        if (cost <= snapshot.remaining) {
          logger.info(
            `Budget low (${snapshot.remaining} remaining) — downgrading model ${eventModel} → ${candidate}`,
          );
          emitCounter("cycles.model.downgrade", 1, { from: eventModel, to: candidate });
          resolvedModel = candidate;
          break;
        }
      }
    } else {
      logger.debug(`Budget low but no fallback configured for model ${eventModel}`);
    }

    // Gap 13: Apply low-budget strategies
    if (config.lowBudgetStrategies.includes("limit_remaining_calls") && remainingCallsAllowed <= 0) {
      logEvent({ timestamp: Date.now(), hook: "before_model_resolve", action: "deny", kind: "model", name: eventModel, reason: "remaining_calls", budgetLevel: snapshot.level, remaining: snapshot.remaining });
      if (config.failClosed) {
        logger.warn(`Call limit reached for model ${eventModel} — budget is low, blocking execution`);
        throw new BudgetExhaustedError(snapshot.remaining, { tenant: config.tenant, budgetId: config.budgetId });
      }
      logger.warn("Low budget call limit reached, failClosed=false — allowing");
    }
  }

  if (snapshot.level === "exhausted") {
    if (config.failClosed) {
      logger.warn(
        `Budget exhausted (${snapshot.remaining} remaining) — blocking model resolve for ${eventModel}`,
      );
      logEvent({ timestamp: Date.now(), hook: "before_model_resolve", action: "deny", kind: "model", name: eventModel, reason: "budget_exhausted", budgetLevel: snapshot.level, remaining: snapshot.remaining });
      throw new BudgetExhaustedError(snapshot.remaining, { tenant: config.tenant, budgetId: config.budgetId });
    }
    logger.warn(
      `Budget exhausted (${snapshot.remaining} remaining) — failClosed=false, allowing ${eventModel}`,
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
    const reason = result.reasonCode ?? "denied";
    emitCounter("cycles.reservation.denied", 1, { kind: "model", name: resolvedModel, reason });
    logEvent({ timestamp: Date.now(), hook: "before_model_resolve", action: "deny", kind: "model", name: resolvedModel, decision: result.decision, reason, budgetLevel: snapshot.level, remaining: snapshot.remaining });

    // Reservation denied but budget level was already checked above (exhausted throws at line 515).
    // If we reach here, budget is healthy/low but the reservation failed for another reason.
    logger.warn(`Model reservation denied for ${resolvedModel} (reason: ${reason}, budget: ${snapshot.level}) — allowing execution to continue`);
  } else {
    totalReservationsMade++;
    emitCounter("cycles.reservation.created", 1, { kind: "model", name: resolvedModel });

    // v0.5.0: Commit any pending model reservation from previous turn first
    await commitPendingModelReservation();

    if (result.reservationId) {
      // v0.5.0: Reserve-then-commit pattern — hold the reservation open.
      // It will be committed in the next beforePromptBuild or at agentEnd,
      // allowing modelCostEstimator to reconcile the cost.
      pendingModelReservation = {
        reservationId: result.reservationId,
        estimate: modelCost,
        toolName: resolvedModel,
        createdAt: Date.now(),
        kind: "model",
        currency: modelCurrency,
      };
      pendingModelName = resolvedModel;
    } else {
      // No reservation ID (e.g. dry-run with DENY) — track immediately
      trackCost(`model:${resolvedModel}`, modelCost);
      totalModelCost += modelCost;
      totalModelCalls++;
    }

    turnIndex++;
    invalidateSnapshotCache();

    logEvent({ timestamp: Date.now(), hook: "before_model_resolve", action: "reserve", kind: "model", name: resolvedModel, amount: modelCost, decision: result.decision, budgetLevel: snapshot.level, remaining: snapshot.remaining });
    checkBurnRate(snapshot.remaining);
    checkExhaustionForecast(snapshot.remaining);
  }

  if (resolvedModel !== eventModel) {
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
  // v0.5.0: Commit pending model reservation from previous turn
  await commitPendingModelReservation();

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

  // Guard against missing event fields
  if (!toolName) {
    logger.warn("before_tool_call: toolName is undefined in event — blocking");
    return { block: true, blockReason: "Missing tool name in event" };
  }
  if (!event.toolCallId) {
    logger.warn(`before_tool_call: toolCallId is undefined for tool ${toolName} — blocking`);
    return { block: true, blockReason: "Missing tool call ID in event" };
  }

  // Resolve user/session from ctx if available (consistent with beforeModelResolve)
  if (ctx.metadata?.userId) resolvedUserId = ctx.metadata.userId as string;
  if (ctx.metadata?.sessionId) resolvedSessionId = ctx.metadata.sessionId as string;

  // Gap 7: Check tool allowlist/blocklist
  const permission = isToolPermitted(toolName, config.toolAllowlist, config.toolBlocklist);
  if (!permission.permitted) {
    logger.warn(`Tool "${toolName}" blocked by access list: ${permission.reason}`);
    emitCounter("cycles.tool.blocked", 1, { tool: toolName, reason: "access_list" });
    logEvent({ timestamp: Date.now(), hook: "before_tool_call", action: "block", kind: "tool", name: toolName, reason: permission.reason, budgetLevel: cachedSnapshot?.level ?? "healthy", remaining: cachedSnapshot?.remaining ?? 0 });
    return { block: true, blockReason: permission.reason };
  }

  // Enforce per-tool invocation limits
  if (config.toolCallLimits) {
    const limit = config.toolCallLimits[toolName];
    if (limit !== undefined) {
      const count = toolCallCounts.get(toolName) ?? 0;
      if (count >= limit) {
        logger.warn(`Tool "${toolName}" blocked: call limit ${limit} reached (${count} calls)`);
        emitCounter("cycles.tool.blocked", 1, { tool: toolName, reason: "call_limit" });
        logEvent({ timestamp: Date.now(), hook: "before_tool_call", action: "block", kind: "tool", name: toolName, reason: `call_limit:${limit}`, budgetLevel: cachedSnapshot?.level ?? "healthy", remaining: cachedSnapshot?.remaining ?? 0 });
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
      emitCounter("cycles.tool.blocked", 1, { tool: toolName, reason: "expensive" });
      logEvent({ timestamp: Date.now(), hook: "before_tool_call", action: "block", kind: "tool", name: toolName, reason: "expensive", budgetLevel: snapshot.level, remaining: snapshot.remaining });
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
    emitCounter("cycles.tool.blocked", 1, { tool: toolName, reason: "remaining_calls" });
    logEvent({ timestamp: Date.now(), hook: "before_tool_call", action: "block", kind: "tool", name: toolName, reason: "remaining_calls", budgetLevel: snapshot.level, remaining: snapshot.remaining });
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
            startHeartbeat(event.toolCallId, retry.reservationId);
          }
          toolCallCounts.set(toolName, (toolCallCounts.get(toolName) ?? 0) + 1);
          if (snapshot.level === "low" && config.lowBudgetStrategies.includes("limit_remaining_calls")) {
            remainingCallsAllowed--;
          }
          invalidateSnapshotCache();
          logEvent({ timestamp: Date.now(), hook: "before_tool_call", action: "reserve", kind: "tool", name: toolName, amount: estimate, decision: retry.decision, reason: "retry_success", budgetLevel: snapshot.level, remaining: snapshot.remaining });
          return undefined;
        }
      }
    }

    logger.warn(
      `Tool "${toolName}" denied by Cycles (decision=${result.decision}, reason=${result.reasonCode ?? "none"})`,
    );
    emitCounter("cycles.reservation.denied", 1, { kind: "tool", name: toolName, reason: result.reasonCode ?? "denied" });
    logEvent({ timestamp: Date.now(), hook: "before_tool_call", action: "deny", kind: "tool", name: toolName, decision: result.decision, reason: result.reasonCode, budgetLevel: snapshot.level, remaining: snapshot.remaining });
    return {
      block: true,
      blockReason: `Budget reservation denied for tool "${toolName}": ${result.reasonCode ?? "budget limit reached"}`,
    };
  }

  totalReservationsMade++;
  emitCounter("cycles.reservation.created", 1, { kind: "tool", name: toolName });

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

  // v0.6.0: Start heartbeat for long-running tool reservations
  if (result.reservationId) {
    startHeartbeat(event.toolCallId, result.reservationId);
  }

  // Track per-tool invocation count for toolCallLimits
  toolCallCounts.set(toolName, (toolCallCounts.get(toolName) ?? 0) + 1);

  // Gap 13: Decrement remaining calls counter
  if (snapshot.level === "low" && config.lowBudgetStrategies.includes("limit_remaining_calls")) {
    remainingCallsAllowed--;
  }

  invalidateSnapshotCache();

  logEvent({ timestamp: Date.now(), hook: "before_tool_call", action: "reserve", kind: "tool", name: toolName, amount: estimate, decision: result.decision, budgetLevel: snapshot.level, remaining: snapshot.remaining });
  checkBurnRate(snapshot.remaining);
  checkExhaustionForecast(snapshot.remaining);

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

  stopHeartbeat(event.toolCallId);

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
  // Delete from tracking AFTER commit (not before) so orphaned reservations
  // can be released at agentEnd if commit fails
  activeReservations.delete(event.toolCallId);
  logger.debug(
    `after_tool_call: committed ${actual} for tool=${reservation.toolName}`,
  );

  // Gap 6 & 9: Track tool cost
  trackCost(`tool:${reservation.toolName}`, actual);
  totalToolCost += actual;
  totalToolCalls++;

  // v0.5.0: Emit commit metrics
  emitCounter("cycles.reservation.committed", 1, { kind: "tool", name: reservation.toolName });
  emitHistogram("cycles.reservation.cost", actual, { kind: "tool", name: reservation.toolName });

  logEvent({ timestamp: Date.now(), hook: "after_tool_call", action: "commit", kind: "tool", name: reservation.toolName, amount: actual, budgetLevel: cachedSnapshot?.level ?? "healthy", remaining: cachedSnapshot?.remaining ?? 0 });

  invalidateSnapshotCache();

  // v0.5.0: Aggressive cache invalidation — proactively refetch after mutation
  if (config.aggressiveCacheInvalidation) {
    await getSnapshot();
  }
}

// ---------------------------------------------------------------------------
// Hook: agent_end
// ---------------------------------------------------------------------------

export async function agentEnd(
  _event: AgentEndEvent,
  ctx: HookContext,
): Promise<void> {
  // v0.5.0: Commit any pending model reservation from the last turn
  await commitPendingModelReservation();

  // v0.6.0: Stop all heartbeat timers
  for (const timer of heartbeatTimers.values()) clearInterval(timer);
  heartbeatTimers.clear();

  // Release any orphaned reservations
  if (activeReservations.size > 0) {
    logger.warn(
      `agent_end: releasing ${activeReservations.size} orphaned reservation(s)`,
    );
    const orphaned = [...activeReservations.values()];
    for (const r of orphaned) {
      logEvent({ timestamp: Date.now(), hook: "agent_end", action: "release", kind: r.kind, name: r.toolName, amount: r.estimate, budgetLevel: cachedSnapshot?.level ?? "healthy", remaining: cachedSnapshot?.remaining ?? 0 });
    }
    const releases = orphaned.map((r) =>
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

  // v0.6.0: Build unconfigured tools report
  const unconfiguredTools = [...warnedUnconfiguredTools].map((name) => ({
    name,
    callCount: callCounts[name] ?? 0,
    estimatedTotalCost: (callCounts[name] ?? 0) * DEFAULT_TOOL_COST,
  }));

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
    unconfiguredTools: unconfiguredTools.length > 0 ? unconfiguredTools : undefined,
    eventLog: config.enableEventLog ? [...eventLog] : undefined,
  };

  logger.info(`Agent session budget summary: remaining=${summary.remaining} spent=${summary.spent} reservations=${summary.totalReservationsMade}`);

  // Attach to context metadata if available
  if (ctx.metadata) {
    ctx.metadata["openclaw-budget-guard"] = {
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

  // v0.5.0: Emit session-level metrics
  const durationMs = summary.endedAt - summary.startedAt;
  emitHistogram("cycles.session.duration_ms", durationMs);
  const totalCost = [...costBreakdown.values()].reduce((sum, e) => sum + e.totalCost, 0);
  emitHistogram("cycles.session.total_cost", totalCost);
}
