/**
 * Simulated Cycles client for dry-run mode (Gap 10).
 *
 * Implements the same interface as CyclesClient so it can be used
 * as a drop-in replacement. Tracks budget locally in-memory.
 */

let nextId = 0;

export class DryRunClient {
  private remaining: number;
  private spent = 0;
  private reserved = 0;
  private allocated: number;
  private reservations = new Map<string, number>();

  constructor(initialBudget: number) {
    this.remaining = initialBudget;
    this.allocated = initialBudget;
  }

  async getBalances(params: Record<string, string>) {
    return {
      isSuccess: true,
      status: 200,
      body: {
        balances: [
          {
            scope: `tenant:${params.tenant}`,
            scopePath: `/${params.tenant}`,
            remaining: { unit: "USD_MICROCENTS", amount: this.remaining },
            reserved: { unit: "USD_MICROCENTS", amount: this.reserved },
            spent: { unit: "USD_MICROCENTS", amount: this.spent },
            allocated: { unit: "USD_MICROCENTS", amount: this.allocated },
          },
        ],
      },
    };
  }

  async createReservation(body: Record<string, unknown>) {
    const estimate = (body.estimate as { amount: number }).amount;
    if (estimate > this.remaining) {
      return {
        isSuccess: true,
        body: {
          decision: "DENY",
          affectedScopes: [],
          reasonCode: "insufficient_budget",
        },
      };
    }

    const id = `dry-run-${++nextId}`;
    this.remaining -= estimate;
    this.reserved += estimate;
    this.reservations.set(id, estimate);

    return {
      isSuccess: true,
      body: {
        decision: "ALLOW",
        reservationId: id,
        affectedScopes: [],
      },
    };
  }

  async commitReservation(reservationId: string, body: Record<string, unknown>) {
    const reservedAmount = this.reservations.get(reservationId) ?? 0;
    const actual = (body.actual as { amount: number }).amount;

    this.reservations.delete(reservationId);
    this.reserved -= reservedAmount;
    this.spent += actual;

    // If actual differs from estimate, adjust remaining
    const diff = reservedAmount - actual;
    this.remaining += diff;

    return { isSuccess: true, status: 200, body: { status: "committed" } };
  }

  async releaseReservation(reservationId: string) {
    const reservedAmount = this.reservations.get(reservationId) ?? 0;
    this.reservations.delete(reservationId);
    this.reserved -= reservedAmount;
    this.remaining += reservedAmount;

    return { isSuccess: true, status: 200, body: { status: "released" } };
  }
}
