/**
 * OpenClaw lifecycle hook implementations.
 *
 * All hooks are thin orchestration over cycles.ts and budget.ts.
 * Module-level state is initialized once via initHooks().
 */

import { type CyclesClient, isAllowed } from "runcycles";

import type {
  ActiveReservation,
  AgentEndContext,
  BudgetGuardConfig,
  BudgetSnapshot,
  ModelResolveContext,
  ModelResolveResult,
  PromptBuildContext,
  ToolCallContext,
  ToolResultContext,
  BudgetExhaustedError,
  ToolBudgetDeniedError,
} from "./types.js";

import {
  BudgetExhaustedError as BudgetExhaustedErrorClass,
  ToolBudgetDeniedError as ToolBudgetDeniedErrorClass,
} from "./types.js";

import {
  createCyclesClient,
  fetchBudgetState,
  reserveBudget,
  commitUsage,
  releaseReservation,
} from "./cycles.js";

import { formatBudgetHint } from "./budget.js";
import { createLogger, type Logger } from "./logger.js";

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let client: CyclesClient;
let config: BudgetGuardConfig;
let logger: Logger;

/** In-flight tool reservations keyed by tool callId. */
const activeReservations = new Map<string, ActiveReservation>();

/** Cached budget snapshot with simple time-based freshness. */
let cachedSnapshot: BudgetSnapshot | undefined;
let cachedSnapshotAt = 0;
const SNAPSHOT_TTL_MS = 5_000;

/** Session-level counters for the final summary. */
let totalReservationsMade = 0;

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

export function initHooks(pluginConfig: BudgetGuardConfig): void {
  config = pluginConfig;
  logger = createLogger(config.logLevel);
  client = createCyclesClient(config);
  cachedSnapshot = undefined;
  cachedSnapshotAt = 0;
  totalReservationsMade = 0;
  activeReservations.clear();
  logger.info("Plugin initialized", { tenant: config.tenant });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function getSnapshot(): Promise<BudgetSnapshot> {
  const now = Date.now();
  if (cachedSnapshot && now - cachedSnapshotAt < SNAPSHOT_TTL_MS) {
    return cachedSnapshot;
  }
  cachedSnapshot = await fetchBudgetState(client, config, logger);
  cachedSnapshotAt = now;
  return cachedSnapshot;
}

function invalidateSnapshotCache(): void {
  cachedSnapshot = undefined;
  cachedSnapshotAt = 0;
}

const DEFAULT_TOOL_COST = 100_000; // 0.001 USD in microcents as a safe default

// ---------------------------------------------------------------------------
// Hook: before_model_resolve
// ---------------------------------------------------------------------------

export async function beforeModelResolve(
  ctx: ModelResolveContext,
): Promise<ModelResolveResult | undefined> {
  const snapshot = await getSnapshot();
  logger.debug(`before_model_resolve: model=${ctx.model} level=${snapshot.level}`);

  if (snapshot.level === "healthy") {
    return undefined;
  }

  if (snapshot.level === "low") {
    const fallback = config.modelFallbacks[ctx.model];
    if (fallback) {
      logger.info(
        `Budget low (${snapshot.remaining} remaining) — downgrading model ${ctx.model} → ${fallback}`,
      );
      return { model: fallback };
    }
    logger.debug(`Budget low but no fallback configured for model ${ctx.model}`);
    return undefined;
  }

  // exhausted
  if (config.failClosed) {
    logger.warn(
      `Budget exhausted (${snapshot.remaining} remaining) — blocking model resolve for ${ctx.model}`,
    );
    throw new BudgetExhaustedErrorClass(snapshot.remaining);
  }

  logger.warn(
    `Budget exhausted (${snapshot.remaining} remaining) — failClosed=false, allowing ${ctx.model}`,
  );
  return undefined;
}

// ---------------------------------------------------------------------------
// Hook: before_prompt_build
// ---------------------------------------------------------------------------

export async function beforePromptBuild(
  ctx: PromptBuildContext,
): Promise<void> {
  if (!config.injectPromptBudgetHint) return;

  const snapshot = await getSnapshot();
  const hint = formatBudgetHint(snapshot, config);
  logger.debug(`before_prompt_build: injecting hint (${hint.length} chars)`);

  // Inject as the first system message
  ctx.messages.unshift({
    role: "system",
    content: hint,
  });
}

// ---------------------------------------------------------------------------
// Hook: before_tool_call
// ---------------------------------------------------------------------------

export async function beforeToolCall(ctx: ToolCallContext): Promise<void> {
  const toolName = ctx.tool.name;
  const estimate =
    config.toolBaseCosts[toolName] ?? DEFAULT_TOOL_COST;

  const actionKind = config.defaultToolActionKindPrefix + toolName;

  logger.debug(
    `before_tool_call: tool=${toolName} callId=${ctx.callId} estimate=${estimate}`,
  );

  const result = await reserveBudget(client, config, {
    actionKind,
    actionName: toolName,
    estimate,
  });

  if (!isAllowed(result.decision)) {
    logger.warn(
      `Tool "${toolName}" denied by Cycles (decision=${result.decision}, reason=${result.reasonCode ?? "none"})`,
    );
    throw new ToolBudgetDeniedErrorClass(
      toolName,
      result.reasonCode ?? "budget reservation denied",
    );
  }

  totalReservationsMade++;

  if (result.reservationId) {
    activeReservations.set(ctx.callId, {
      reservationId: result.reservationId,
      estimate,
      toolName,
      createdAt: Date.now(),
    });
  }

  // Invalidate cache since budget state changed after reservation
  invalidateSnapshotCache();
}

// ---------------------------------------------------------------------------
// Hook: after_tool_call
// ---------------------------------------------------------------------------

export async function afterToolCall(ctx: ToolResultContext): Promise<void> {
  const reservation = activeReservations.get(ctx.callId);
  if (!reservation) {
    logger.debug(
      `after_tool_call: no active reservation for callId=${ctx.callId}`,
    );
    return;
  }

  activeReservations.delete(ctx.callId);

  // Use estimate as actual — no way to know real cost in phase 1 without proxy
  const actual = reservation.estimate;

  try {
    await commitUsage(
      client,
      reservation.reservationId,
      actual,
      config.currency,
      logger,
    );
    logger.debug(
      `after_tool_call: committed ${actual} for tool=${reservation.toolName}`,
    );
  } catch {
    // Commit already logs internally — attempt release as fallback
    await releaseReservation(
      client,
      reservation.reservationId,
      "commit_failed_fallback",
      logger,
    );
  }

  invalidateSnapshotCache();
}

// ---------------------------------------------------------------------------
// Hook: agent_end
// ---------------------------------------------------------------------------

export async function agentEnd(ctx: AgentEndContext): Promise<void> {
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
  const snapshot = await getSnapshot();

  const summary = {
    remaining: snapshot.remaining,
    spent: snapshot.spent,
    reserved: snapshot.reserved,
    allocated: snapshot.allocated,
    level: snapshot.level,
    totalReservationsMade,
  };

  logger.info("Agent session budget summary:", summary);

  // Attach to context metadata if available
  if (ctx.metadata) {
    ctx.metadata["cycles-budget-guard"] = summary;
  }
}
