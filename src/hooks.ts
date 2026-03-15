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
  BudgetSnapshot,
  HookContext,
  ModelResolveEvent,
  ModelResolveResult,
  OpenClawLogger,
  PromptBuildEvent,
  PromptBuildResult,
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

import { formatBudgetHint } from "./budget.js";
import { createLogger } from "./logger.js";

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let client: CyclesClient;
let config: BudgetGuardConfig;
let logger: OpenClawLogger;

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

export function initHooks(
  pluginConfig: BudgetGuardConfig,
  apiLogger?: OpenClawLogger,
): void {
  config = pluginConfig;
  // Prefer the OpenClaw-provided logger, fall back to our own
  logger = apiLogger ?? createLogger(config.logLevel);
  client = createCyclesClient(config);
  cachedSnapshot = undefined;
  cachedSnapshotAt = 0;
  totalReservationsMade = 0;
  activeReservations.clear();
  logger.info("Plugin initialized", { tenant: config.tenant } as unknown as string);
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
  event: ModelResolveEvent,
  _ctx: HookContext,
): Promise<ModelResolveResult | undefined> {
  const snapshot = await getSnapshot();
  logger.debug(`before_model_resolve: model=${event.model} level=${snapshot.level}`);

  if (snapshot.level === "healthy") {
    return undefined;
  }

  if (snapshot.level === "low") {
    const fallback = config.modelFallbacks[event.model];
    if (fallback) {
      logger.info(
        `Budget low (${snapshot.remaining} remaining) — downgrading model ${event.model} → ${fallback}`,
      );
      return { modelOverride: fallback };
    }
    logger.debug(`Budget low but no fallback configured for model ${event.model}`);
    return undefined;
  }

  // exhausted
  if (config.failClosed) {
    logger.warn(
      `Budget exhausted (${snapshot.remaining} remaining) — blocking model resolve for ${event.model}`,
    );
    throw new BudgetExhaustedError(snapshot.remaining);
  }

  logger.warn(
    `Budget exhausted (${snapshot.remaining} remaining) — failClosed=false, allowing ${event.model}`,
  );
  return undefined;
}

// ---------------------------------------------------------------------------
// Hook: before_prompt_build
// ---------------------------------------------------------------------------

export async function beforePromptBuild(
  _event: PromptBuildEvent,
  _ctx: HookContext,
): Promise<PromptBuildResult | undefined> {
  if (!config.injectPromptBudgetHint) return undefined;

  const snapshot = await getSnapshot();
  const hint = formatBudgetHint(snapshot, config);
  logger.debug(`before_prompt_build: injecting hint (${hint.length} chars)`);

  return { prependSystemContext: hint };
}

// ---------------------------------------------------------------------------
// Hook: before_tool_call
// ---------------------------------------------------------------------------

export async function beforeToolCall(
  event: ToolCallEvent,
  _ctx: HookContext,
): Promise<ToolCallResult | undefined> {
  const toolName = event.toolName;
  const estimate =
    config.toolBaseCosts[toolName] ?? DEFAULT_TOOL_COST;

  const actionKind = config.defaultToolActionKindPrefix + toolName;

  logger.debug(
    `before_tool_call: tool=${toolName} callId=${event.toolCallId} estimate=${estimate}`,
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
    });
  }

  // Invalidate cache since budget state changed after reservation
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

  // Use estimate as actual — no way to know real cost in phase 1 without proxy
  const actual = reservation.estimate;

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
  const snapshot = await getSnapshot();

  const summary = {
    remaining: snapshot.remaining,
    spent: snapshot.spent,
    reserved: snapshot.reserved,
    allocated: snapshot.allocated,
    level: snapshot.level,
    totalReservationsMade,
  };

  logger.info("Agent session budget summary:", summary as unknown as string);

  // Attach to context metadata if available
  if (ctx.metadata) {
    ctx.metadata["cycles-budget-guard"] = summary;
  }
}
