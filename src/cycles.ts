/**
 * Thin helpers around the runcycles CyclesClient for budget operations.
 *
 * All functions accept the client and config explicitly — no hidden state.
 */

import { randomUUID } from "node:crypto";
import {
  CyclesClient,
  CyclesConfig,
  balanceResponseFromWire,
  reservationCreateResponseFromWire,
  type Balance,
  type ReservationCreateResponse,
} from "runcycles";

import type { BudgetGuardConfig, BudgetSnapshot, OpenClawLogger, StandardMetrics } from "./types.js";
import { classifyBudget } from "./budget.js";

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

export function createCyclesClient(config: BudgetGuardConfig): CyclesClient {
  const cyclesConfig = new CyclesConfig({
    baseUrl: config.cyclesBaseUrl,
    apiKey: config.cyclesApiKey,
    tenant: config.tenant,
  });
  return new CyclesClient(cyclesConfig);
}

// ---------------------------------------------------------------------------
// Budget state
// ---------------------------------------------------------------------------

export interface FetchBudgetStateOptions {
  userId?: string;
  sessionId?: string;
}

export async function fetchBudgetState(
  client: CyclesClient,
  config: BudgetGuardConfig,
  logger: OpenClawLogger,
  opts?: FetchBudgetStateOptions,
): Promise<BudgetSnapshot> {
  const params: Record<string, string> = {
    tenant: config.tenant,
    ...(config.budgetScope ?? {}),
  };

  let response;
  try {
    response = await client.getBalances(params);
  } catch (err) {
    logger.warn(`Failed to fetch balances (network error): ${err}`);
    // Fail-open: assume healthy so we don't block on transient errors
    return { remaining: Infinity, reserved: 0, spent: 0, level: "healthy" };
  }

  if (!response.isSuccess) {
    logger.warn(
      `Failed to fetch balances (status ${response.status}): ${response.errorMessage ?? "unknown"}`,
    );
    // Fail-open for balance fetch: assume healthy so we don't block on transient errors
    return { remaining: Infinity, reserved: 0, spent: 0, level: "healthy" };
  }

  const parsed = balanceResponseFromWire(
    response.body as Record<string, unknown>,
  );

  // Find the matching balance in the configured currency
  const match = findMatchingBalance(parsed.balances, config);

  if (!match) {
    if (config.budgetScope) {
      const scopeStr = Object.entries(config.budgetScope).map(([k, v]) => `${k}=${v}`).join(", ");
      logger.warn(
        `No balance found for budgetScope {${scopeStr}} (currency=${config.currency}). ` +
        `Verify the scope exists in Cycles and has an allocated budget. ` +
        `Falling back to healthy (remaining=Infinity).`,
      );
    } else {
      logger.debug("No matching balance found for configured scope; assuming healthy");
    }
    return { remaining: Infinity, reserved: 0, spent: 0, level: "healthy" };
  }

  const remaining = match.remaining.amount;
  const reserved = match.reserved?.amount ?? 0;
  const spent = match.spent?.amount ?? 0;
  const allocated = match.allocated?.amount;

  // Gap 18: Pool balance — fetch parent scope balance if configured
  let poolRemaining: number | undefined;
  let poolAllocated: number | undefined;
  if (config.parentBudgetId) {
    const poolBalance = parsed.balances.find(
      (b) =>
        b.remaining.unit === config.currency &&
        (b.scope.includes(config.parentBudgetId!) ||
          b.scopePath.includes(config.parentBudgetId!)),
    );
    if (poolBalance) {
      poolRemaining = poolBalance.remaining.amount;
      poolAllocated = poolBalance.allocated?.amount;
    }
  }

  return {
    remaining,
    reserved,
    spent,
    allocated,
    level: classifyBudget(remaining, config),
    poolRemaining,
    poolAllocated,
  };
}

function findMatchingBalance(
  balances: Balance[],
  config: BudgetGuardConfig,
): Balance | undefined {
  // Prefer balances matching the configured currency
  const matching = balances.filter(
    (b) => b.remaining.unit === config.currency,
  );

  if (matching.length === 0) return undefined;

  // If budgetScope is set, prefer the balance whose scope/scopePath matches all segments
  if (config.budgetScope && Object.keys(config.budgetScope).length > 0) {
    // Cycles server lowercases all scope values — match case-insensitively
    const scopeValues = Object.values(config.budgetScope).map((v) => v.toLowerCase());
    const specific = matching.find(
      (b) =>
        scopeValues.every((v) => b.scope.toLowerCase().includes(v) || b.scopePath.toLowerCase().includes(v)),
    );
    if (specific) return specific;
    // budgetScope is set but no balance matches — don't fall back to tenant balance
    // as that would silently ignore the budgetScope config
    return undefined;
  }

  // No budgetScope configured — return the least specific (shortest scopePath)
  // balance, which corresponds to the tenant-level budget the user configured.
  return matching.sort((a, b) => a.scopePath.length - b.scopePath.length)[0];
}

// ---------------------------------------------------------------------------
// Reserve
// ---------------------------------------------------------------------------

export interface ReserveOptions {
  actionKind: string;
  actionName: string;
  estimate: number;
  ttlMs?: number;
  overagePolicy?: string;
  userId?: string;
  sessionId?: string;
  unit?: string;
}

export async function reserveBudget(
  client: CyclesClient,
  config: BudgetGuardConfig,
  opts: ReserveOptions,
): Promise<ReservationCreateResponse> {
  const userId = opts.userId ?? config.userId;
  const sessionId = opts.sessionId ?? config.sessionId;

  // Build dimensions for user/session scoping (Gap 3)
  const dimensions: Record<string, string> = {};
  if (userId) dimensions.user = userId;
  if (sessionId) dimensions.session = sessionId;

  const body: Record<string, unknown> = {
    idempotency_key: randomUUID(),
    subject: {
      tenant: config.tenant,
      ...(config.budgetScope ?? {}),
      ...(Object.keys(dimensions).length > 0 ? { dimensions } : {}),
    },
    action: { kind: opts.actionKind, name: opts.actionName },
    estimate: { unit: opts.unit ?? config.currency, amount: opts.estimate },
    ttl_ms: opts.ttlMs ?? config.reservationTtlMs,
    overage_policy: opts.overagePolicy ?? config.overagePolicy,
  };

  let response: { isSuccess: boolean; status: number; body?: unknown; errorMessage?: string } | undefined;
  const maxAttempts = 1 + config.transientRetryMaxAttempts;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      response = await client.createReservation(body);
    } catch {
      // Network-level error — retry if attempts remain, otherwise DENY
      if (attempt < maxAttempts - 1) {
        await sleepMs(config.transientRetryBaseDelayMs * Math.pow(2, attempt));
        continue;
      }
      return {
        decision: "DENY" as ReservationCreateResponse["decision"],
        affectedScopes: [],
        reasonCode: "reservation_network_error",
      };
    }

    // v0.6.0: Retry on transient HTTP errors (429, 503, 504)
    if (!response.isSuccess && config.retryableStatusCodes.includes(response.status) && attempt < maxAttempts - 1) {
      await sleepMs(config.transientRetryBaseDelayMs * Math.pow(2, attempt));
      continue;
    }
    break;
  }

  if (!response || !response.isSuccess) {
    return {
      decision: "DENY" as ReservationCreateResponse["decision"],
      affectedScopes: [],
      reasonCode: response?.errorMessage ?? "reservation_failed",
    };
  }

  return reservationCreateResponseFromWire(
    response.body as Record<string, unknown>,
  );
}

// ---------------------------------------------------------------------------
// Commit (best-effort — never throws)
// ---------------------------------------------------------------------------

export async function commitUsage(
  client: CyclesClient,
  reservationId: string,
  actual: number,
  unit: string,
  logger: OpenClawLogger,
  metrics?: StandardMetrics,
): Promise<void> {
  try {
    const body: Record<string, unknown> = {
      idempotency_key: randomUUID(),
      actual: { unit, amount: actual },
    };
    if (metrics) {
      body.metrics = metrics;
    }
    const response = await client.commitReservation(reservationId, body);
    if (!response.isSuccess) {
      logger.warn(
        `Commit for reservation ${reservationId} returned status ${response.status}`,
      );
    }
  } catch (err) {
    logger.warn(`Commit failed for reservation ${reservationId}:`, err);
  }
}

// ---------------------------------------------------------------------------
// Release (best-effort — never throws)
// ---------------------------------------------------------------------------

export async function releaseReservation(
  client: CyclesClient,
  reservationId: string,
  reason: string,
  logger: OpenClawLogger,
): Promise<void> {
  try {
    const body: Record<string, unknown> = {
      idempotency_key: randomUUID(),
      reason,
    };
    const response = await client.releaseReservation(reservationId, body);
    if (!response.isSuccess) {
      logger.warn(
        `Release for reservation ${reservationId} returned status ${response.status} — budget may remain locked until TTL expires`,
      );
    }
  } catch (err) {
    logger.warn(`Release failed for reservation ${reservationId} — budget may remain locked until TTL expires:`, err);
  }
}
