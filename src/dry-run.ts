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
  private currency: string;

  constructor(initialBudget: number, currency = "USD_MICROCENTS") {
    this.remaining = initialBudget;
    this.allocated = initialBudget;
    this.currency = currency;
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
            remaining: { unit: this.currency, amount: this.remaining },
            reserved: { unit: this.currency, amount: this.reserved },
            spent: { unit: this.currency, amount: this.spent },
            allocated: { unit: this.currency, amount: this.allocated },
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
        status: 200,
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
      status: 200,
      body: {
        decision: "ALLOW",
        reservationId: id,
        affectedScopes: [],
      },
    };
  }

  async commitReservation(reservationId: string, body: Record<string, unknown>) {
    if (!this.reservations.has(reservationId)) {
      return { isSuccess: false, status: 409, errorMessage: "RESERVATION_FINALIZED" };
    }
    const reservedAmount = this.reservations.get(reservationId)!;
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
    if (!this.reservations.has(reservationId)) {
      return { isSuccess: false, status: 409, errorMessage: "RESERVATION_FINALIZED" };
    }
    const reservedAmount = this.reservations.get(reservationId)!;
    this.reservations.delete(reservationId);
    this.reserved -= reservedAmount;
    this.remaining += reservedAmount;

    return { isSuccess: true, status: 200, body: { status: "released" } };
  }
}
