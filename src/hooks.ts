/**
 * OpenClaw lifecycle hook implementations.
 *
 * All hooks follow the OpenClaw (event, ctx) => result pattern.
 * Mutable lifecycle state is isolated first by plugin registration, then by
 * the session/run identity supplied by OpenClaw. Each registered handler set
 * closes over its own client, config, logger, metrics, and session state map.
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
// Plugin runtime and isolated session state
// ---------------------------------------------------------------------------

interface SessionState {
  /** In-flight tool reservations keyed by the host's toolCallId. */
  activeReservations: Map<string, ActiveReservation>;
  cachedSnapshot?: BudgetSnapshot;
  cachedSnapshotAt: number;
  totalReservationsMade: number;
  lastKnownLevel?: BudgetLevel;
  costBreakdown: Map<string, { count: number; totalCost: number }>;
  totalToolCost: number;
  totalToolCalls: number;
  totalModelCost: number;
  totalModelCalls: number;
  remainingCallsAllowed: number;
  toolCallCounts: Map<string, number>;
  warnedUnconfiguredTools: Set<string>;
  sessionStartedAt: number;
  resolvedUserId?: string;
  resolvedSessionId?: string;
  /** One pending model hold per isolated session/run. */
  pendingModelReservation?: ActiveReservation;
  pendingModelName?: string;
  pendingModelTurnIndex?: number;
  turnIndex: number;
  heartbeatTimers: Map<string, ReturnType<typeof setInterval>>;
  eventLog: ReservationLogEntry[];
  windowCostAtStart: number;
  windowStartedAt: number;
  lastBurnRate: number;
  exhaustionWarningFired: boolean;
  eventLogCapWarned: boolean;
  /** Set as soon as agent_end starts so concurrent terminal hooks no-op. */
  ending: boolean;
}

type PendingModelCommitOutcome = "none" | "committed" | "deferred";

interface HookRuntime {
  client: CyclesClient;
  config: BudgetGuardConfig;
  logger: OpenClawLogger;
  /** All mutable lifecycle state for this registration, keyed by host scope. */
  sessionStates: Map<string, SessionState>;
  metricsEmitter?: MetricsEmitter;
  baseTags: Record<string, string>;
}

export interface HookHandlers {
  beforeModelResolve: (
    event: ModelResolveEvent,
    ctx: HookContext,
  ) => Promise<ModelResolveResult | undefined>;
  beforePromptBuild: (
    event: PromptBuildEvent,
    ctx: HookContext,
  ) => Promise<PromptBuildResult | undefined>;
  beforeToolCall: (
    event: ToolCallEvent,
    ctx: HookContext,
  ) => Promise<ToolCallResult | undefined>;
  afterToolCall: (event: ToolResultEvent, ctx: HookContext) => Promise<void>;
  agentEnd: (event: AgentEndEvent, ctx: HookContext) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

let defaultRuntime: HookRuntime | undefined;
let defaultHandlers: HookHandlers | undefined;

function createRuntime(
  pluginConfig: BudgetGuardConfig,
  apiLogger?: OpenClawLogger,
): HookRuntime {
  const runtimeLogger = apiLogger ?? createLogger(pluginConfig.logLevel);
  let runtimeClient: CyclesClient;

  if (pluginConfig.dryRun) {
    runtimeClient = new DryRunClient(
      pluginConfig.dryRunBudget,
      pluginConfig.currency,
    ) as unknown as CyclesClient;
    runtimeLogger.info(
      `[DRY-RUN] Simulated budget=${pluginConfig.dryRunBudget} ${pluginConfig.currency}`,
    );
  } else {
    runtimeClient = createCyclesClient(pluginConfig);
  }

  const runtimeBaseTags: Record<string, string> = { tenant: pluginConfig.tenant };
  if (pluginConfig.budgetScope) {
    for (const [key, value] of Object.entries(pluginConfig.budgetScope)) {
      runtimeBaseTags[key] = value;
    }
  }

  return {
    client: runtimeClient,
    config: pluginConfig,
    logger: runtimeLogger,
    sessionStates: new Map(),
    metricsEmitter: pluginConfig.metricsEmitter,
    baseTags: runtimeBaseTags,
  };
}

function createHandlers(runtime: HookRuntime): HookHandlers {
  return {
    beforeModelResolve: (event, ctx) => beforeModelResolveFor(runtime, event, ctx),
    beforePromptBuild: (event, ctx) => beforePromptBuildFor(runtime, event, ctx),
    beforeToolCall: (event, ctx) => beforeToolCallFor(runtime, event, ctx),
    afterToolCall: (event, ctx) => afterToolCallFor(runtime, event, ctx),
    agentEnd: (event, ctx) => agentEndFor(runtime, event, ctx),
  };
}

function disposeRuntime(runtime: HookRuntime): void {
  for (const state of runtime.sessionStates.values()) stopAllHeartbeats(state);
  runtime.sessionStates.clear();
}

/** Create a fully isolated handler set for one OpenClaw plugin registration. */
export function createHooks(
  pluginConfig: BudgetGuardConfig,
  apiLogger?: OpenClawLogger,
): HookHandlers {
  return createHandlers(createRuntime(pluginConfig, apiLogger));
}

/** @internal Reset initialization flag (for testing only). */
export function _resetInitialized(): void {
  if (defaultRuntime) disposeRuntime(defaultRuntime);
  defaultRuntime = undefined;
  defaultHandlers = undefined;
}

/** @internal Return the legacy runtime's live state count (for testing only). */
export function _getDefaultSessionStateCount(): number {
  return defaultRuntime?.sessionStates.size ?? 0;
}

export function initHooks(
  pluginConfig: BudgetGuardConfig,
  apiLogger?: OpenClawLogger,
): HookHandlers {
  // Legacy direct-hook users share one intentionally stable default runtime.
  // Production registrations use createHooks() and never touch this singleton.
  if (!defaultHandlers) {
    defaultRuntime = createRuntime(pluginConfig, apiLogger);
    defaultHandlers = createHandlers(defaultRuntime);
  }
  return defaultHandlers;
}

function requireDefaultHandlers(): HookHandlers {
  if (!defaultHandlers) {
    throw new Error("initHooks must be called before invoking exported hook functions");
  }
  return defaultHandlers;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function resolveScope(
  runtime: HookRuntime,
  event: Record<string, unknown>,
  ctx: HookContext,
): { key: string; userId?: string; sessionId?: string } {
  const { config } = runtime;
  const metadata = ctx.metadata ?? {};
  const scopeKey = (kind: string, id: string) => JSON.stringify([config.tenant, kind, id]);
  const userId = asNonEmptyString(metadata.userId) ?? config.userId;
  const hostSessionId = asNonEmptyString(ctx.sessionId)
    ?? asNonEmptyString(metadata.sessionId)
    ?? asNonEmptyString(event.sessionId);
  if (hostSessionId) {
    return { key: scopeKey("session", hostSessionId), userId, sessionId: hostSessionId };
  }

  const sessionKey = asNonEmptyString(ctx.sessionKey)
    ?? asNonEmptyString(metadata.sessionKey)
    ?? asNonEmptyString(ctx.conversationId)
    ?? asNonEmptyString(metadata.conversationId)
    ?? asNonEmptyString(event.sessionKey)
    ?? asNonEmptyString(event.conversationId);
  if (sessionKey) {
    return { key: scopeKey("session-key", sessionKey), userId, sessionId: config.sessionId };
  }

  const runId = asNonEmptyString(ctx.runId)
    ?? asNonEmptyString(metadata.runId)
    ?? asNonEmptyString(event.runId);
  if (runId) return { key: scopeKey("run", runId), userId, sessionId: config.sessionId };

  if (config.sessionId) {
    return {
      key: scopeKey("configured-session", config.sessionId),
      userId,
      sessionId: config.sessionId,
    };
  }

  const agentId = asNonEmptyString(ctx.agentId)
    ?? asNonEmptyString(metadata.agentId)
    ?? asNonEmptyString(event.agentId);
  if (agentId) {
    return { key: scopeKey("agent", agentId), userId, sessionId: config.sessionId };
  }
  if (userId) return { key: scopeKey("user", userId), userId, sessionId: config.sessionId };

  return { key: scopeKey("unscoped", "default"), sessionId: config.sessionId };
}

function createSessionState(
  runtime: HookRuntime,
  identity: { userId?: string; sessionId?: string },
): SessionState {
  const { config } = runtime;
  const now = Date.now();
  return {
    activeReservations: new Map(),
    cachedSnapshotAt: 0,
    totalReservationsMade: 0,
    costBreakdown: new Map(),
    totalToolCost: 0,
    totalToolCalls: 0,
    totalModelCost: 0,
    totalModelCalls: 0,
    remainingCallsAllowed: config.maxRemainingCallsWhenLow,
    toolCallCounts: new Map(),
    warnedUnconfiguredTools: new Set(),
    sessionStartedAt: now,
    resolvedUserId: identity.userId,
    resolvedSessionId: identity.sessionId,
    turnIndex: 0,
    heartbeatTimers: new Map(),
    eventLog: [],
    windowCostAtStart: 0,
    windowStartedAt: now,
    lastBurnRate: 0,
    exhaustionWarningFired: false,
    eventLogCapWarned: false,
    ending: false,
  };
}

function getSessionStateFor(
  runtime: HookRuntime,
  event: Record<string, unknown>,
  ctx: HookContext,
): { key: string; state: SessionState } {
  const identity = resolveScope(runtime, event, ctx);
  let state = runtime.sessionStates.get(identity.key);
  if (!state) {
    state = createSessionState(runtime, identity);
    runtime.sessionStates.set(identity.key, state);
  } else {
    state.resolvedUserId = identity.userId ?? state.resolvedUserId;
    state.resolvedSessionId = identity.sessionId ?? state.resolvedSessionId;
  }
  return { key: identity.key, state };
}

function findSessionStateFor(
  runtime: HookRuntime,
  event: Record<string, unknown>,
  ctx: HookContext,
): { key: string; state?: SessionState } {
  const identity = resolveScope(runtime, event, ctx);
  return { key: identity.key, state: runtime.sessionStates.get(identity.key) };
}

async function getSnapshotFor(runtime: HookRuntime, state: SessionState): Promise<BudgetSnapshot> {
  const { client, config, logger } = runtime;
  const emitGauge = (name: string, value: number, tags?: Record<string, string>) =>
    emitGaugeFor(runtime, name, value, tags);
  const now = Date.now();
  if (state.cachedSnapshot && now - state.cachedSnapshotAt < config.snapshotCacheTtlMs) {
    return state.cachedSnapshot;
  }

  // Timeout guard: don't let a hung Cycles server block hook execution
  const SNAPSHOT_TIMEOUT_MS = 10_000;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    state.cachedSnapshot = await Promise.race([
      fetchBudgetState(client, config, logger, {
        userId: state.resolvedUserId,
        sessionId: state.resolvedSessionId,
      }),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error("fetchBudgetState timed out")), SNAPSHOT_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    if (config.failClosedOnSnapshotError) {
      logger.warn(`Budget snapshot fetch failed (${err}), failing closed (exhausted)`);
      state.cachedSnapshot = { remaining: 0, reserved: 0, spent: 0, level: "exhausted" };
    } else {
      logger.warn(`Budget snapshot fetch failed (${err}), assuming healthy`);
      state.cachedSnapshot = { remaining: Infinity, reserved: 0, spent: 0, level: "healthy" };
    }
  } finally {
    clearTimeout(timeoutHandle);
  }
  state.cachedSnapshotAt = now;

  // Gap 5: Detect budget level transitions
  if (state.lastKnownLevel !== undefined && state.cachedSnapshot.level !== state.lastKnownLevel) {
    logger.warn(`Budget level changed: ${state.lastKnownLevel} → ${state.cachedSnapshot.level} (remaining=${state.cachedSnapshot.remaining})`);
    const event = {
      previousLevel: state.lastKnownLevel,
      currentLevel: state.cachedSnapshot.level,
      remaining: state.cachedSnapshot.remaining,
      timestamp: now,
    };
    try {
      config.onBudgetTransition?.(event);
    } catch (err) {
      logger.warn("onBudgetTransition callback error:", err);
    }
    if (config.budgetTransitionWebhookUrl) {
      fireWebhookFor(runtime, config.budgetTransitionWebhookUrl, event);
    }
  }
  state.lastKnownLevel = state.cachedSnapshot.level;

  // v0.5.0: Emit budget gauge metrics
  emitGauge("cycles.budget.remaining", state.cachedSnapshot.remaining, { currency: config.currency });
  emitGauge("cycles.budget.reserved", state.cachedSnapshot.reserved);
  emitGauge("cycles.budget.spent", state.cachedSnapshot.spent);
  const levelValue = state.cachedSnapshot.level === "healthy" ? 0 : state.cachedSnapshot.level === "low" ? 1 : 2;
  emitGauge("cycles.budget.level", levelValue, { level: state.cachedSnapshot.level });

  return state.cachedSnapshot;
}

function invalidateSnapshotCache(state: SessionState): void {
  state.cachedSnapshot = undefined;
  state.cachedSnapshotAt = 0;
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
function trackCost(state: SessionState, key: string, cost: number): void {
  const entry = state.costBreakdown.get(key);
  if (entry) {
    entry.count++;
    entry.totalCost += cost;
  } else {
    state.costBreakdown.set(key, { count: 1, totalCost: cost });
  }
}

/** Gap 9: Build forecast data from running totals. */
function buildForecast(state: SessionState): ForecastData {
  return {
    avgToolCost: state.totalToolCalls > 0 ? state.totalToolCost / state.totalToolCalls : 0,
    avgModelCost: state.totalModelCalls > 0 ? state.totalModelCost / state.totalModelCalls : 0,
    totalToolCalls: state.totalToolCalls,
    totalModelCalls: state.totalModelCalls,
  };
}

/** Fire a webhook POST (best-effort, non-blocking). */
function fireWebhookFor(runtime: HookRuntime, url: string, payload: unknown): void {
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  }).catch((err) => {
    runtime.logger.warn(`Webhook POST to ${url} failed:`, err);
  });
}

/** Gap 17: Sleep utility for retry. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** v0.5.0: Safe metrics emission (never throws). */
function emitGaugeFor(runtime: HookRuntime, name: string, value: number, tags?: Record<string, string>): void {
  if (!runtime.metricsEmitter) return;
  try { runtime.metricsEmitter.gauge(name, value, { ...runtime.baseTags, ...tags }); } catch { /* best-effort */ }
}
function emitCounterFor(runtime: HookRuntime, name: string, delta: number, tags?: Record<string, string>): void {
  if (!runtime.metricsEmitter) return;
  try { runtime.metricsEmitter.counter(name, delta, { ...runtime.baseTags, ...tags }); } catch { /* best-effort */ }
}
function emitHistogramFor(runtime: HookRuntime, name: string, value: number, tags?: Record<string, string>): void {
  if (!runtime.metricsEmitter) return;
  try { runtime.metricsEmitter.histogram(name, value, { ...runtime.baseTags, ...tags }); } catch { /* best-effort */ }
}

const MAX_EVENT_LOG_ENTRIES = 10_000;

/** v0.6.0: Append to event log if enabled. Capped to prevent unbounded growth. */
function logEventFor(runtime: HookRuntime, state: SessionState, entry: ReservationLogEntry): void {
  const { config, logger } = runtime;
  if (!config.enableEventLog) return;
  if (state.eventLog.length >= MAX_EVENT_LOG_ENTRIES) {
    if (!state.eventLogCapWarned) {
      state.eventLogCapWarned = true;
      logger.warn(`Event log capacity (${MAX_EVENT_LOG_ENTRIES} entries) reached — further events will be dropped`);
    }
    return;
  }
  state.eventLog.push(entry);
}

/** v0.6.0: Get current session cost total. */
function sessionCostTotal(state: SessionState): number {
  let total = 0;
  for (const e of state.costBreakdown.values()) total += e.totalCost;
  return total;
}

/** v0.6.0: Check burn rate and fire anomaly if needed. */
function checkBurnRateFor(runtime: HookRuntime, state: SessionState, remaining: number): void {
  const { config, logger } = runtime;
  const emitCounter = (name: string, delta: number, tags?: Record<string, string>) =>
    emitCounterFor(runtime, name, delta, tags);
  const now = Date.now();
  const elapsed = now - state.windowStartedAt;
  if (elapsed < config.burnRateWindowMs || elapsed <= 0) return;

  const currentTotal = sessionCostTotal(state);
  const windowCost = currentTotal - state.windowCostAtStart;
  const currentRate = windowCost / elapsed; // cost per ms

  if (state.lastBurnRate > 0 && currentRate > 0) {
    const ratio = currentRate / state.lastBurnRate;
    if (ratio >= config.burnRateAlertThreshold) {
      logger.warn(
        `Burn rate anomaly: ${ratio.toFixed(1)}x above average (threshold: ${config.burnRateAlertThreshold}x)`,
      );
      emitCounter("cycles.budget.burn_rate_anomaly", 1, { ratio: ratio.toFixed(1) });
      const event = {
        currentBurnRate: currentRate,
        averageBurnRate: state.lastBurnRate,
        ratio,
        threshold: config.burnRateAlertThreshold,
        windowMs: config.burnRateWindowMs,
        remaining,
        timestamp: now,
      };
      try { config.onBurnRateAnomaly?.(event); } catch { /* best-effort */ }
    }
  }

  state.lastBurnRate = currentRate > 0 ? currentRate : state.lastBurnRate;
  state.windowCostAtStart = currentTotal;
  state.windowStartedAt = now;
}

/** v0.6.0: Check if budget will exhaust soon and warn. */
function checkExhaustionForecastFor(runtime: HookRuntime, state: SessionState, remaining: number): void {
  const { config, logger } = runtime;
  const emitGauge = (name: string, value: number, tags?: Record<string, string>) =>
    emitGaugeFor(runtime, name, value, tags);
  if (state.exhaustionWarningFired || remaining === Infinity) return;
  const elapsed = Date.now() - state.sessionStartedAt;
  if (elapsed < 1000) return; // need at least 1s of data

  const totalCost = sessionCostTotal(state);
  if (totalCost <= 0) return;

  const burnRatePerMs = totalCost / elapsed;
  if (burnRatePerMs <= 0) return;
  const msRemaining = remaining / burnRatePerMs;

  if (msRemaining < config.exhaustionWarningThresholdMs) {
    state.exhaustionWarningFired = true;
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
function startHeartbeatFor(
  runtime: HookRuntime,
  state: SessionState,
  toolCallId: string,
  reservationId: string,
): void {
  const { client, config, logger } = runtime;
  if (config.heartbeatIntervalMs <= 0) return;
  const heartbeatClient = client;
  const heartbeatIntervalMs = config.heartbeatIntervalMs;
  const heartbeatLogger = logger;
  const timer = setInterval(async () => {
    try {
      const body: Record<string, unknown> = {
        idempotency_key: `extend-${reservationId}-${Date.now()}`,
        extend_by_ms: heartbeatIntervalMs,
      };
      // Use client.extendReservation if available, otherwise skip
      if ("extendReservation" in heartbeatClient && typeof (heartbeatClient as unknown as Record<string, unknown>).extendReservation === "function") {
        await (heartbeatClient as unknown as { extendReservation(id: string, body: Record<string, unknown>): Promise<unknown> })
          .extendReservation(reservationId, body);
        heartbeatLogger.debug(`Heartbeat: extended reservation ${reservationId} for tool callId=${toolCallId}`);
      }
    } catch {
      heartbeatLogger.debug(`Heartbeat: failed to extend reservation ${reservationId}`);
    }
  }, heartbeatIntervalMs);
  if (typeof timer === "object" && "unref" in timer) timer.unref();
  state.heartbeatTimers.set(toolCallId, timer);
}

/** v0.6.0: Stop heartbeat timer for a tool call. */
function stopHeartbeat(state: SessionState, toolCallId: string): void {
  const timer = state.heartbeatTimers.get(toolCallId);
  if (timer) {
    clearInterval(timer);
    state.heartbeatTimers.delete(toolCallId);
  }
}

function stopAllHeartbeats(state: SessionState): void {
  for (const timer of state.heartbeatTimers.values()) clearInterval(timer);
  state.heartbeatTimers.clear();
}

/** v0.5.0: Commit pending model reservation from previous turn. */
async function commitPendingModelReservationFor(
  runtime: HookRuntime,
  state: SessionState,
): Promise<PendingModelCommitOutcome> {
  const { client, config, logger } = runtime;
  const emitCounter = (name: string, delta: number, tags?: Record<string, string>) =>
    emitCounterFor(runtime, name, delta, tags);
  const emitHistogram = (name: string, value: number, tags?: Record<string, string>) =>
    emitHistogramFor(runtime, name, value, tags);
  const logEventForRuntime = (entry: ReservationLogEntry) => logEventFor(runtime, state, entry);
  const getSnapshotForRuntime = () => getSnapshotFor(runtime, state);
  if (!state.pendingModelReservation) return "none";

  const reservation = state.pendingModelReservation;
  const modelName = state.pendingModelName ?? "unknown";
  const modelTurnIndex = state.pendingModelTurnIndex ?? state.turnIndex - 1;
  let actual = reservation.estimate;
  if (config.modelCostEstimator) {
    try {
      const computed = config.modelCostEstimator({
        model: modelName,
        estimatedCost: reservation.estimate,
        turnIndex: modelTurnIndex,
      });
      if (computed != null) actual = computed;
    } catch (err) {
      logger.warn(`modelCostEstimator threw for model=${modelName}, using estimate:`, err);
    }
  }

  const unit = reservation.currency ?? config.currency;
  const metrics: StandardMetrics = { model_version: modelName };
  const committed = await commitUsage(
    client,
    reservation.reservationId,
    actual,
    unit,
    logger,
    metrics,
  );
  if (committed === false) {
    logger.warn(
      `Model commit deferred for ${modelName}; retaining reservation ${reservation.reservationId} for retry or agent_end cleanup`,
    );
    return "deferred";
  }
  state.pendingModelReservation = undefined;
  state.pendingModelName = undefined;
  state.pendingModelTurnIndex = undefined;
  logger.info(`Model committed: ${modelName} (cost=${actual} ${unit})`);

  trackCost(state, `model:${modelName}`, actual);
  state.totalModelCost += actual;
  state.totalModelCalls++;

  emitCounter("cycles.reservation.committed", 1, { kind: "model", name: modelName });
  emitHistogram("cycles.reservation.cost", actual, { kind: "model", name: modelName });
  logEventForRuntime({ timestamp: Date.now(), hook: "commit_model", action: "commit", kind: "model", name: modelName, amount: actual, budgetLevel: state.cachedSnapshot?.level ?? "healthy", remaining: state.cachedSnapshot?.remaining ?? 0 });

  invalidateSnapshotCache(state);
  if (config.aggressiveCacheInvalidation) {
    await getSnapshotForRuntime();
  }
  return "committed";
}

const DEFAULT_TOOL_COST = 100_000;
const DEFAULT_MODEL_COST = 500_000;

// ---------------------------------------------------------------------------
// Hook: before_model_resolve
// ---------------------------------------------------------------------------

async function beforeModelResolveFor(
  runtime: HookRuntime,
  event: ModelResolveEvent,
  ctx: HookContext,
): Promise<ModelResolveResult | undefined> {
  const { client, config, logger } = runtime;
  const emitCounter = (name: string, delta: number, tags?: Record<string, string>) =>
    emitCounterFor(runtime, name, delta, tags);
  const logEvent = (state: SessionState, entry: ReservationLogEntry) =>
    logEventFor(runtime, state, entry);
  const checkBurnRate = (state: SessionState, remaining: number) =>
    checkBurnRateFor(runtime, state, remaining);
  const checkExhaustionForecast = (state: SessionState, remaining: number) =>
    checkExhaustionForecastFor(runtime, state, remaining);
  const { state } = getSessionStateFor(runtime, event, ctx);

  // Never create a new hold until the previous model hold for this session has
  // been finalized. A failed commit remains attached to this session so
  // agent_end can release it rather than orphaning either reservation.
  const pendingCommitOutcome = await commitPendingModelReservationFor(runtime, state);
  const snapshot = await getSnapshotFor(runtime, state);

  // Resolve model name — check event fields, ctx.metadata, and config fallback.
  // OpenClaw may pass the model in different places depending on version.
  const eventRecord = event as Record<string, unknown>;
  const ctxMeta = (ctx.metadata ?? {}) as Record<string, unknown>;
  const eventModel = event.model
    ?? ctx.modelId
    ?? eventRecord.modelId as string | undefined
    ?? eventRecord.modelName as string | undefined
    ?? eventRecord.model_id as string | undefined
    ?? eventRecord.model_name as string | undefined
    ?? ctxMeta.model as string | undefined
    ?? ctxMeta.modelId as string | undefined
    ?? ctxMeta.modelName as string | undefined
    ?? config.defaultModelName;
  if (!eventModel) {
    logger.warn(
      `before_model_resolve: cannot determine model name. ` +
      `Event keys: [${Object.keys(event).join(", ")}]. ` +
      `Metadata keys: [${Object.keys(ctxMeta).join(", ")}]. ` +
      `Set defaultModelName in plugin config to enable model budget tracking.`
    );
    attachBudgetStatus(ctx, snapshot);
    return undefined;
  }

  logger.debug(`before_model_resolve: model=${eventModel} level=${snapshot.level}`);

  // Gap 12: Attach status for end-user visibility
  attachBudgetStatus(ctx, snapshot);

  let resolvedModel = eventModel;

  if (snapshot.level === "low") {
    // Gap 4: Chained model fallbacks (only when downgrade_model strategy is active)
    const fallbacks = config.lowBudgetStrategies.includes("downgrade_model")
      ? config.modelFallbacks[eventModel]
      : undefined;
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
    if (config.lowBudgetStrategies.includes("limit_remaining_calls") && state.remainingCallsAllowed <= 0) {
      logEvent(state, { timestamp: Date.now(), hook: "before_model_resolve", action: "deny", kind: "model", name: eventModel, reason: "remaining_calls", budgetLevel: snapshot.level, remaining: snapshot.remaining });
      if (config.failClosed) {
        logger.warn(`Call limit reached for model ${eventModel} — budget is low, blocking model call`);
        return { modelOverride: "__cycles_budget_exhausted__" };
      }
      logger.warn("Low budget call limit reached, failClosed=false — allowing");
    }
  }

  if (snapshot.level === "exhausted") {
    if (config.failClosed) {
      logger.warn(
        `Budget exhausted (${snapshot.remaining} remaining) — blocking model call for ${eventModel}`,
      );
      logEvent(state, { timestamp: Date.now(), hook: "before_model_resolve", action: "deny", kind: "model", name: eventModel, reason: "budget_exhausted", budgetLevel: snapshot.level, remaining: snapshot.remaining });
      return { modelOverride: "__cycles_budget_exhausted__" };
    }
    logger.warn(
      `Budget exhausted (${snapshot.remaining} remaining) — failClosed=false, allowing ${eventModel}`,
    );
  }

  // Gap 1: Reserve budget for model call
  const modelCost = config.modelBaseCosts[resolvedModel] ?? config.defaultModelCost;
  const modelCurrency = config.modelCurrency ?? config.currency;
  const actionKind = config.defaultModelActionKind;

  if (pendingCommitOutcome === "deferred") {
    // Connectivity failures are fail-open, but the prior hold must not be
    // overwritten. Allow this call without a second server-side reservation
    // and account for its estimate locally until the session ends.
    logger.warn(
      `Allowing model ${resolvedModel} without a new reservation because the previous model commit is deferred`,
    );
    trackCost(state, `model:${resolvedModel}`, modelCost);
    state.totalModelCost += modelCost;
    state.totalModelCalls++;
    state.turnIndex++;
    if (snapshot.level === "low" && config.lowBudgetStrategies.includes("limit_remaining_calls")) {
      state.remainingCallsAllowed--;
    }
    invalidateSnapshotCache(state);
    logEvent(state, { timestamp: Date.now(), hook: "before_model_resolve", action: "reserve", kind: "model", name: resolvedModel, amount: modelCost, decision: "ALLOW", reason: "pending_commit_deferred:allowed_without_reservation", budgetLevel: snapshot.level, remaining: snapshot.remaining });
    checkBurnRate(state, snapshot.remaining);
    checkExhaustionForecast(state, snapshot.remaining);
  } else {
    const result = await reserveBudget(client, config, {
      actionKind,
      actionName: resolvedModel,
      estimate: modelCost,
      unit: modelCurrency,
      userId: state.resolvedUserId,
      sessionId: state.resolvedSessionId,
    });

    if (!isAllowed(result.decision)) {
      const reason = result.reasonCode ?? "denied";
      emitCounter("cycles.reservation.denied", 1, { kind: "model", name: resolvedModel, reason });
      logEvent(state, { timestamp: Date.now(), hook: "before_model_resolve", action: "deny", kind: "model", name: resolvedModel, decision: result.decision, reason, budgetLevel: snapshot.level, remaining: snapshot.remaining });

      if (config.failClosed) {
        logger.warn(`Model reservation denied for ${resolvedModel} (reason: ${reason}, budget: ${snapshot.level}) — blocking model call (failClosed=true)`);
        return { modelOverride: "__cycles_budget_exhausted__" };
      }
      logger.warn(`Model reservation denied for ${resolvedModel} (reason: ${reason}, budget: ${snapshot.level}) — allowing execution to continue (failClosed=false)`);

      // Track cost locally even though no server-side reservation was created.
      // The model call will proceed, so the session summary and forecasting
      // should reflect the estimated cost.
      trackCost(state, `model:${resolvedModel}`, modelCost);
      state.totalModelCost += modelCost;
      state.totalModelCalls++;
      state.turnIndex++;
      if (snapshot.level === "low" && config.lowBudgetStrategies.includes("limit_remaining_calls")) {
        state.remainingCallsAllowed--;
      }
      invalidateSnapshotCache(state);

      logEvent(state, { timestamp: Date.now(), hook: "before_model_resolve", action: "reserve", kind: "model", name: resolvedModel, amount: modelCost, decision: result.decision, reason: `${reason}:allowed_without_reservation`, budgetLevel: snapshot.level, remaining: snapshot.remaining });
      checkBurnRate(state, snapshot.remaining);
      checkExhaustionForecast(state, snapshot.remaining);
    } else {
      state.totalReservationsMade++;
      emitCounter("cycles.reservation.created", 1, { kind: "model", name: resolvedModel });
      logger.info(`Model reserved: ${resolvedModel} (estimate=${modelCost}, remaining=${snapshot.remaining})`);

      if (result.reservationId) {
        // v0.5.0: Reserve-then-commit pattern — hold the reservation open.
        // It will be committed in the next beforePromptBuild or at agentEnd,
        // allowing modelCostEstimator to reconcile the cost.
        state.pendingModelReservation = {
          reservationId: result.reservationId,
          estimate: modelCost,
          toolName: resolvedModel,
          createdAt: Date.now(),
          kind: "model",
          currency: modelCurrency,
        };
        state.pendingModelName = resolvedModel;
        state.pendingModelTurnIndex = state.turnIndex;
      } else {
        // No reservation ID (e.g. dry-run with DENY) — track immediately
        trackCost(state, `model:${resolvedModel}`, modelCost);
        state.totalModelCost += modelCost;
        state.totalModelCalls++;
      }

      state.turnIndex++;
      if (snapshot.level === "low" && config.lowBudgetStrategies.includes("limit_remaining_calls")) {
        state.remainingCallsAllowed--;
      }
      invalidateSnapshotCache(state);

      logEvent(state, { timestamp: Date.now(), hook: "before_model_resolve", action: "reserve", kind: "model", name: resolvedModel, amount: modelCost, decision: result.decision, budgetLevel: snapshot.level, remaining: snapshot.remaining });
      checkBurnRate(state, snapshot.remaining);
      checkExhaustionForecast(state, snapshot.remaining);
    }
  }

  if (resolvedModel !== eventModel) {
    // OpenClaw prepends the provider prefix to modelOverride values,
    // so strip any provider/ prefix to avoid double-prefixing
    // (e.g., "openai/gpt-5-nano" → "gpt-5-nano" → OpenClaw adds "openai/" → "openai/gpt-5-nano")
    const overrideValue = resolvedModel.includes("/")
      ? resolvedModel.split("/").slice(1).join("/")
      : resolvedModel;
    return { modelOverride: overrideValue };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Hook: before_prompt_build
// ---------------------------------------------------------------------------

async function beforePromptBuildFor(
  runtime: HookRuntime,
  event: PromptBuildEvent,
  ctx: HookContext,
): Promise<PromptBuildResult | undefined> {
  const { config, logger } = runtime;
  const { state } = getSessionStateFor(runtime, event, ctx);
  // v0.5.0: Commit pending model reservation from previous turn
  await commitPendingModelReservationFor(runtime, state);

  if (!config.injectPromptBudgetHint) return undefined;

  const snapshot = await getSnapshotFor(runtime, state);

  // Gap 12: Attach status
  attachBudgetStatus(ctx, snapshot);

  // Gap 9: Include forecast data in hint
  const forecast = buildForecast(state);
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
      fullHint = fullHint.slice(0, Math.max(0, config.maxPromptHintChars - 3)) + "...";
    }
  }

  return { prependSystemContext: fullHint };
}

// ---------------------------------------------------------------------------
// Hook: before_tool_call
// ---------------------------------------------------------------------------

async function beforeToolCallFor(
  runtime: HookRuntime,
  event: ToolCallEvent,
  ctx: HookContext,
): Promise<ToolCallResult | undefined> {
  const { client, config, logger } = runtime;
  const emitCounter = (name: string, delta: number, tags?: Record<string, string>) =>
    emitCounterFor(runtime, name, delta, tags);
  const logEvent = (state: SessionState, entry: ReservationLogEntry) =>
    logEventFor(runtime, state, entry);
  const startHeartbeat = (state: SessionState, toolCallId: string, reservationId: string) =>
    startHeartbeatFor(runtime, state, toolCallId, reservationId);
  const checkBurnRate = (state: SessionState, remaining: number) =>
    checkBurnRateFor(runtime, state, remaining);
  const checkExhaustionForecast = (state: SessionState, remaining: number) =>
    checkExhaustionForecastFor(runtime, state, remaining);
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

  const { state } = getSessionStateFor(runtime, event, ctx);

  // Gap 7: Check tool allowlist/blocklist
  const permission = isToolPermitted(toolName, config.toolAllowlist, config.toolBlocklist);
  if (!permission.permitted) {
    logger.warn(`Tool "${toolName}" blocked by access list: ${permission.reason}`);
    emitCounter("cycles.tool.blocked", 1, { tool: toolName, reason: "access_list" });
    logEvent(state, { timestamp: Date.now(), hook: "before_tool_call", action: "block", kind: "tool", name: toolName, reason: permission.reason, budgetLevel: state.cachedSnapshot?.level ?? "healthy", remaining: state.cachedSnapshot?.remaining ?? 0 });
    return { block: true, blockReason: permission.reason };
  }

  // Enforce per-tool invocation limits
  if (config.toolCallLimits) {
    const limit = config.toolCallLimits[toolName];
    if (limit !== undefined) {
      const count = state.toolCallCounts.get(toolName) ?? 0;
      if (count >= limit) {
        logger.warn(`Tool "${toolName}" blocked: call limit ${limit} reached (${count} calls)`);
        emitCounter("cycles.tool.blocked", 1, { tool: toolName, reason: "call_limit" });
        logEvent(state, { timestamp: Date.now(), hook: "before_tool_call", action: "block", kind: "tool", name: toolName, reason: `call_limit:${limit}`, budgetLevel: state.cachedSnapshot?.level ?? "healthy", remaining: state.cachedSnapshot?.remaining ?? 0 });
        return {
          block: true,
          blockReason: `Tool "${toolName}" exceeded session call limit (${limit})`,
        };
      }
    }
  }

  // Gap 12: Attach budget status
  const snapshot = await getSnapshotFor(runtime, state);
  attachBudgetStatus(ctx, snapshot);

  // Log once per tool when using default cost estimate
  const estimate = config.toolBaseCosts[toolName] ?? DEFAULT_TOOL_COST;
  if (!(toolName in config.toolBaseCosts) && !state.warnedUnconfiguredTools.has(toolName)) {
    state.warnedUnconfiguredTools.add(toolName);
    logger.warn(
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
      logEvent(state, { timestamp: Date.now(), hook: "before_tool_call", action: "block", kind: "tool", name: toolName, reason: "expensive", budgetLevel: snapshot.level, remaining: snapshot.remaining });
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
    state.remainingCallsAllowed <= 0
  ) {
    logger.warn(`Tool "${toolName}" blocked: remaining call limit reached`);
    emitCounter("cycles.tool.blocked", 1, { tool: toolName, reason: "remaining_calls" });
    logEvent(state, { timestamp: Date.now(), hook: "before_tool_call", action: "block", kind: "tool", name: toolName, reason: "remaining_calls", budgetLevel: snapshot.level, remaining: snapshot.remaining });
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
    userId: state.resolvedUserId,
    sessionId: state.resolvedSessionId,
  });

  if (!isAllowed(result.decision)) {
    // Gap 17: Retry on deny
    if (config.retryOnDeny) {
      for (let attempt = 0; attempt < config.maxRetries; attempt++) {
        logger.debug(
          `Tool "${toolName}" denied, retry ${attempt + 1}/${config.maxRetries} after ${config.retryDelayMs}ms`,
        );
        await sleep(config.retryDelayMs);
        invalidateSnapshotCache(state);
        const retry = await reserveBudget(client, config, {
          actionKind,
          actionName: toolName,
          estimate,
          ttlMs,
          overagePolicy,
          unit,
          userId: state.resolvedUserId,
          sessionId: state.resolvedSessionId,
        });
        if (isAllowed(retry.decision)) {
          state.totalReservationsMade++;
          if (retry.reservationId) {
            state.activeReservations.set(event.toolCallId, {
              reservationId: retry.reservationId,
              estimate,
              toolName,
              createdAt: Date.now(),
              kind: "tool",
              currency: unit,
            });
            startHeartbeat(state, event.toolCallId, retry.reservationId);
          }
          state.toolCallCounts.set(toolName, (state.toolCallCounts.get(toolName) ?? 0) + 1);
          if (snapshot.level === "low" && config.lowBudgetStrategies.includes("limit_remaining_calls")) {
            state.remainingCallsAllowed--;
          }
          invalidateSnapshotCache(state);
          logEvent(state, { timestamp: Date.now(), hook: "before_tool_call", action: "reserve", kind: "tool", name: toolName, amount: estimate, decision: retry.decision, reason: "retry_success", budgetLevel: snapshot.level, remaining: snapshot.remaining });
          return undefined;
        }
      }
    }

    logger.warn(
      `Tool "${toolName}" denied by Cycles (decision=${result.decision}, reason=${result.reasonCode ?? "none"})`,
    );
    emitCounter("cycles.reservation.denied", 1, { kind: "tool", name: toolName, reason: result.reasonCode ?? "denied" });
    logEvent(state, { timestamp: Date.now(), hook: "before_tool_call", action: "deny", kind: "tool", name: toolName, decision: result.decision, reason: result.reasonCode, budgetLevel: snapshot.level, remaining: snapshot.remaining });
    return {
      block: true,
      blockReason: `Budget reservation denied for tool "${toolName}": ${result.reasonCode ?? "budget limit reached"}`,
    };
  }

  state.totalReservationsMade++;
  emitCounter("cycles.reservation.created", 1, { kind: "tool", name: toolName });
  logger.info(`Tool reserved: ${toolName} (estimate=${estimate}, remaining=${snapshot.remaining})`);

  if (result.reservationId) {
    state.activeReservations.set(event.toolCallId, {
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
    startHeartbeat(state, event.toolCallId, result.reservationId);
  }

  // Track per-tool invocation count for toolCallLimits
  state.toolCallCounts.set(toolName, (state.toolCallCounts.get(toolName) ?? 0) + 1);

  // Gap 13: Decrement remaining calls counter
  if (snapshot.level === "low" && config.lowBudgetStrategies.includes("limit_remaining_calls")) {
    state.remainingCallsAllowed--;
  }

  invalidateSnapshotCache(state);

  logEvent(state, { timestamp: Date.now(), hook: "before_tool_call", action: "reserve", kind: "tool", name: toolName, amount: estimate, decision: result.decision, budgetLevel: snapshot.level, remaining: snapshot.remaining });
  checkBurnRate(state, snapshot.remaining);
  checkExhaustionForecast(state, snapshot.remaining);

  return undefined;
}

// ---------------------------------------------------------------------------
// Hook: after_tool_call
// ---------------------------------------------------------------------------

async function afterToolCallFor(
  runtime: HookRuntime,
  event: ToolResultEvent,
  ctx: HookContext,
): Promise<void> {
  const { client, config, logger } = runtime;
  const emitCounter = (name: string, delta: number, tags?: Record<string, string>) =>
    emitCounterFor(runtime, name, delta, tags);
  const emitHistogram = (name: string, value: number, tags?: Record<string, string>) =>
    emitHistogramFor(runtime, name, value, tags);
  const logEvent = (state: SessionState, entry: ReservationLogEntry) =>
    logEventFor(runtime, state, entry);
  const { state } = findSessionStateFor(runtime, event, ctx);
  if (!state || state.ending) {
    logger.debug(
      `after_tool_call: session state is absent or ending for callId=${event.toolCallId}`,
    );
    return;
  }
  const reservation = state.activeReservations.get(event.toolCallId);
  if (!reservation) {
    logger.debug(
      `after_tool_call: no active reservation for callId=${event.toolCallId}`,
    );
    return;
  }

  stopHeartbeat(state, event.toolCallId);

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
      if (computed != null) actual = computed;
    } catch (err) {
      logger.warn(`costEstimator threw for tool=${reservation.toolName}, using estimate:`, err);
    }
  }

  const unit = reservation.currency ?? config.currency;
  const committed = await commitUsage(
    client,
    reservation.reservationId,
    actual,
    unit,
    logger,
  );
  if (committed === false) {
    logger.warn(
      `Tool commit failed for ${reservation.toolName}; retaining reservation for agent_end cleanup`,
    );
    return;
  }
  // Delete from tracking AFTER commit (not before) so orphaned reservations
  // can be released at agentEnd if commit fails
  state.activeReservations.delete(event.toolCallId);
  logger.info(`Tool committed: ${reservation.toolName} (cost=${actual} ${unit})`);

  // Gap 6 & 9: Track tool cost
  trackCost(state, `tool:${reservation.toolName}`, actual);
  state.totalToolCost += actual;
  state.totalToolCalls++;

  // v0.5.0: Emit commit metrics
  emitCounter("cycles.reservation.committed", 1, { kind: "tool", name: reservation.toolName });
  emitHistogram("cycles.reservation.cost", actual, { kind: "tool", name: reservation.toolName });

  logEvent(state, { timestamp: Date.now(), hook: "after_tool_call", action: "commit", kind: "tool", name: reservation.toolName, amount: actual, budgetLevel: state.cachedSnapshot?.level ?? "healthy", remaining: state.cachedSnapshot?.remaining ?? 0 });

  invalidateSnapshotCache(state);

  // v0.5.0: Aggressive cache invalidation — proactively refetch after mutation
  if (config.aggressiveCacheInvalidation) {
    await getSnapshotFor(runtime, state);
  }
}

// ---------------------------------------------------------------------------
// Hook: agent_end
// ---------------------------------------------------------------------------

async function agentEndFor(
  runtime: HookRuntime,
  event: AgentEndEvent,
  ctx: HookContext,
): Promise<void> {
  const { client, config, logger } = runtime;
  const emitHistogram = (name: string, value: number, tags?: Record<string, string>) =>
    emitHistogramFor(runtime, name, value, tags);
  const logEvent = (state: SessionState, entry: ReservationLogEntry) =>
    logEventFor(runtime, state, entry);
  const { key, state } = getSessionStateFor(runtime, event, ctx);
  state.ending = true;
  try {
    // v0.5.0: Commit any pending model reservation from the last turn.
    // If commit fails, release the reservation so budget isn't locked until TTL.
    if (state.pendingModelReservation) {
      const resId = state.pendingModelReservation.reservationId;
      try {
        const outcome = await commitPendingModelReservationFor(runtime, state);
        if (outcome === "deferred") {
          logger.warn(
            `Failed to commit pending model reservation ${resId} at agent_end, releasing`,
          );
          await releaseReservation(client, resId, "commit_failed_at_agent_end", logger);
        }
      } catch (err) {
        logger.warn(`Unexpected error committing pending model reservation ${resId} at agent_end, releasing:`, err);
        await releaseReservation(client, resId, "commit_failed_at_agent_end", logger);
      }
    }

    // v0.6.0: Stop only this session's heartbeat timers before releasing holds.
    stopAllHeartbeats(state);

    // Release any orphaned reservations belonging to this session only.
    if (state.activeReservations.size > 0) {
      logger.warn(
        `agent_end: releasing ${state.activeReservations.size} orphaned reservation(s)`,
      );
      const orphaned = [...state.activeReservations.values()];
      for (const r of orphaned) {
        logEvent(state, { timestamp: Date.now(), hook: "agent_end", action: "release", kind: r.kind, name: r.toolName, amount: r.estimate, budgetLevel: state.cachedSnapshot?.level ?? "healthy", remaining: state.cachedSnapshot?.remaining ?? 0 });
      }
      const releases = orphaned.map((r) =>
        releaseReservation(client, r.reservationId, "agent_end_cleanup", logger),
      );
      await Promise.allSettled(releases);
      state.activeReservations.clear();
    }

    // Fetch final budget state for summary
    invalidateSnapshotCache(state);
    const snapshot = await getSnapshotFor(runtime, state);

    // Gap 6: Build cost breakdown as plain object
    const breakdown: Record<string, { count: number; totalCost: number }> = {};
    for (const [breakdownKey, value] of state.costBreakdown) {
      breakdown[breakdownKey] = { count: value.count, totalCost: value.totalCost };
    }

    // Gap 9: Include forecast data
    const forecast = buildForecast(state);

    // Build per-tool call counts as plain object
    const callCounts: Record<string, number> = {};
    for (const [toolName, value] of state.toolCallCounts) {
      callCounts[toolName] = value;
    }

    // v0.6.0: Build unconfigured tools report
    const unconfiguredTools = [...state.warnedUnconfiguredTools].map((name) => ({
      name,
      callCount: callCounts[name] ?? 0,
      estimatedTotalCost: (callCounts[name] ?? 0) * DEFAULT_TOOL_COST,
    }));

    const summary: SessionSummary = {
      tenant: config.tenant,
      budgetId: config.budgetId,
      budgetScope: config.budgetScope,
      userId: state.resolvedUserId,
      sessionId: state.resolvedSessionId,
      remaining: snapshot.remaining,
      spent: snapshot.spent,
      reserved: snapshot.reserved,
      allocated: snapshot.allocated,
      level: snapshot.level,
      totalReservationsMade: state.totalReservationsMade,
      costBreakdown: breakdown,
      toolCallCounts: callCounts,
      startedAt: state.sessionStartedAt,
      endedAt: Date.now(),
      unconfiguredTools: unconfiguredTools.length > 0 ? unconfiguredTools : undefined,
      eventLog: config.enableEventLog ? [...state.eventLog] : undefined,
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
      fireWebhookFor(runtime, config.analyticsWebhookUrl, summary);
    }

    // v0.5.0: Emit session-level metrics
    const durationMs = summary.endedAt - summary.startedAt;
    emitHistogram("cycles.session.duration_ms", durationMs);
    const totalCost = [...state.costBreakdown.values()].reduce((sum, e) => sum + e.totalCost, 0);
    emitHistogram("cycles.session.total_cost", totalCost);

    // v0.7.10: Flush metrics emitter to ensure all datapoints are sent
    if (runtime.metricsEmitter?.flush) {
      try {
        await runtime.metricsEmitter.flush();
      } catch {
        // Best-effort — metrics flush failure is non-fatal
      }
    }
  } finally {
    // Never allow a timer or completed session state to survive agent_end,
    // including callback, metrics, snapshot, commit, or release error paths.
    stopAllHeartbeats(state);
    if (runtime.sessionStates.get(key) === state) runtime.sessionStates.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Backward-compatible direct hook exports
// ---------------------------------------------------------------------------

export async function beforeModelResolve(
  event: ModelResolveEvent,
  ctx: HookContext,
): Promise<ModelResolveResult | undefined> {
  return requireDefaultHandlers().beforeModelResolve(event, ctx);
}

export async function beforePromptBuild(
  event: PromptBuildEvent,
  ctx: HookContext,
): Promise<PromptBuildResult | undefined> {
  return requireDefaultHandlers().beforePromptBuild(event, ctx);
}

export async function beforeToolCall(
  event: ToolCallEvent,
  ctx: HookContext,
): Promise<ToolCallResult | undefined> {
  return requireDefaultHandlers().beforeToolCall(event, ctx);
}

export async function afterToolCall(
  event: ToolResultEvent,
  ctx: HookContext,
): Promise<void> {
  return requireDefaultHandlers().afterToolCall(event, ctx);
}

export async function agentEnd(
  event: AgentEndEvent,
  ctx: HookContext,
): Promise<void> {
  return requireDefaultHandlers().agentEnd(event, ctx);
}
