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

import type { BudgetGuardConfig, BudgetSnapshot } from "./types.js";
import { classifyBudget } from "./budget.js";
import type { Logger } from "./logger.js";

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

export async function fetchBudgetState(
  client: CyclesClient,
  config: BudgetGuardConfig,
  logger: Logger,
): Promise<BudgetSnapshot> {
  const params: Record<string, string> = { tenant: config.tenant };
  if (config.budgetId) {
    params.app = config.budgetId;
  }

  const response = await client.getBalances(params);

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

  // Find the most specific matching balance in the configured currency
  const match = findMatchingBalance(parsed.balances, config);

  if (!match) {
    logger.debug("No matching balance found for configured scope; assuming healthy");
    return { remaining: Infinity, reserved: 0, spent: 0, level: "healthy" };
  }

  const remaining = match.remaining.amount;
  const reserved = match.reserved?.amount ?? 0;
  const spent = match.spent?.amount ?? 0;
  const allocated = match.allocated?.amount;

  return {
    remaining,
    reserved,
    spent,
    allocated,
    level: classifyBudget(remaining, config),
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

  if (matching.length === 0) return balances[0];

  // If budgetId is set, prefer the balance whose scope matches it
  if (config.budgetId) {
    const specific = matching.find(
      (b) =>
        b.scope.includes(config.budgetId!) ||
        b.scopePath.includes(config.budgetId!),
    );
    if (specific) return specific;
  }

  // Return the most specific (longest scopePath) balance
  return matching.sort((a, b) => b.scopePath.length - a.scopePath.length)[0];
}

// ---------------------------------------------------------------------------
// Reserve
// ---------------------------------------------------------------------------

export interface ReserveOptions {
  actionKind: string;
  actionName: string;
  estimate: number;
}

export async function reserveBudget(
  client: CyclesClient,
  config: BudgetGuardConfig,
  opts: ReserveOptions,
): Promise<ReservationCreateResponse> {
  const body: Record<string, unknown> = {
    idempotency_key: randomUUID(),
    subject: { tenant: config.tenant },
    action: { kind: opts.actionKind, name: opts.actionName },
    estimate: { unit: config.currency, amount: opts.estimate },
    ttl_ms: 60_000,
    overage_policy: "REJECT",
  };

  const response = await client.createReservation(body);

  if (!response.isSuccess) {
    // Build a synthetic DENY response so callers can handle uniformly
    return {
      decision: "DENY" as ReservationCreateResponse["decision"],
      affectedScopes: [],
      reasonCode: response.errorMessage ?? "reservation_failed",
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
  logger: Logger,
): Promise<void> {
  try {
    const body: Record<string, unknown> = {
      idempotency_key: randomUUID(),
      actual: { unit, amount: actual },
    };
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
  logger: Logger,
): Promise<void> {
  try {
    const body: Record<string, unknown> = {
      idempotency_key: randomUUID(),
      reason,
    };
    const response = await client.releaseReservation(reservationId, body);
    if (!response.isSuccess) {
      logger.debug(
        `Release for reservation ${reservationId} returned status ${response.status}`,
      );
    }
  } catch (err) {
    logger.debug(`Release failed for reservation ${reservationId}:`, err);
  }
}
