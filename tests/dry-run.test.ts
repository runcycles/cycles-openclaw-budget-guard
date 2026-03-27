import { describe, it, expect } from "vitest";
import { DryRunClient } from "../src/dry-run.js";

describe("DryRunClient", () => {
  it("returns initial balance on getBalances", async () => {
    const client = new DryRunClient(10_000_000);
    const res = await client.getBalances({ tenant: "test" });
    expect(res.isSuccess).toBe(true);
    const balance = res.body.balances[0];
    expect(balance.remaining.amount).toBe(10_000_000);
    expect(balance.allocated.amount).toBe(10_000_000);
    expect(balance.spent.amount).toBe(0);
  });

  it("allows reservation when budget sufficient", async () => {
    const client = new DryRunClient(10_000_000);
    const res = await client.createReservation({
      estimate: { amount: 5_000_000 },
    });
    expect(res.isSuccess).toBe(true);
    expect(res.body.decision).toBe("ALLOW");
    expect(res.body.reservationId).toBeDefined();
  });

  it("denies reservation when budget insufficient", async () => {
    const client = new DryRunClient(1_000);
    const res = await client.createReservation({
      estimate: { amount: 5_000_000 },
    });
    expect(res.isSuccess).toBe(true);
    expect(res.body.decision).toBe("DENY");
  });

  it("decrements remaining on reservation", async () => {
    const client = new DryRunClient(10_000_000);
    await client.createReservation({ estimate: { amount: 3_000_000 } });

    const bal = await client.getBalances({ tenant: "t" });
    expect(bal.body.balances[0].remaining.amount).toBe(7_000_000);
    expect(bal.body.balances[0].reserved.amount).toBe(3_000_000);
  });

  it("commit moves reserved to spent", async () => {
    const client = new DryRunClient(10_000_000);
    const res = await client.createReservation({ estimate: { amount: 3_000_000 } });
    const resId = res.body.reservationId;

    await client.commitReservation(resId, { actual: { amount: 3_000_000 } });

    const bal = await client.getBalances({ tenant: "t" });
    expect(bal.body.balances[0].remaining.amount).toBe(7_000_000);
    expect(bal.body.balances[0].reserved.amount).toBe(0);
    expect(bal.body.balances[0].spent.amount).toBe(3_000_000);
  });

  it("commit adjusts remaining when actual differs from estimate", async () => {
    const client = new DryRunClient(10_000_000);
    const res = await client.createReservation({ estimate: { amount: 5_000_000 } });
    const resId = res.body.reservationId;

    // Actual is less than estimate — refund the difference
    await client.commitReservation(resId, { actual: { amount: 2_000_000 } });

    const bal = await client.getBalances({ tenant: "t" });
    // 10M - 5M (reserved) + 3M (diff refund) = 8M remaining
    expect(bal.body.balances[0].remaining.amount).toBe(8_000_000);
    expect(bal.body.balances[0].spent.amount).toBe(2_000_000);
  });

  it("release refunds reserved amount", async () => {
    const client = new DryRunClient(10_000_000);
    const res = await client.createReservation({ estimate: { amount: 4_000_000 } });
    const resId = res.body.reservationId;

    await client.releaseReservation(resId);

    const bal = await client.getBalances({ tenant: "t" });
    expect(bal.body.balances[0].remaining.amount).toBe(10_000_000);
    expect(bal.body.balances[0].reserved.amount).toBe(0);
    expect(bal.body.balances[0].spent.amount).toBe(0);
  });

  it("handles multiple concurrent reservations", async () => {
    const client = new DryRunClient(10_000_000);
    const r1 = await client.createReservation({ estimate: { amount: 2_000_000 } });
    const r2 = await client.createReservation({ estimate: { amount: 3_000_000 } });

    const bal = await client.getBalances({ tenant: "t" });
    expect(bal.body.balances[0].remaining.amount).toBe(5_000_000);
    expect(bal.body.balances[0].reserved.amount).toBe(5_000_000);

    await client.commitReservation(r1.body.reservationId, { actual: { amount: 2_000_000 } });
    await client.releaseReservation(r2.body.reservationId);

    const bal2 = await client.getBalances({ tenant: "t" });
    expect(bal2.body.balances[0].remaining.amount).toBe(8_000_000);
    expect(bal2.body.balances[0].spent.amount).toBe(2_000_000);
    expect(bal2.body.balances[0].reserved.amount).toBe(0);
  });

  it("commit with unknown reservationId returns 409", async () => {
    const client = new DryRunClient(10_000_000);
    const result = await client.commitReservation("unknown-id", { actual: { amount: 1_000 } });
    expect(result.isSuccess).toBe(false);
    expect(result.status).toBe(409);

    const bal = await client.getBalances({ tenant: "t" });
    expect(bal.body.balances[0].remaining.amount).toBe(10_000_000);
    expect(bal.body.balances[0].spent.amount).toBe(0);
  });

  it("release with unknown reservationId returns 409", async () => {
    const client = new DryRunClient(10_000_000);
    const result = await client.releaseReservation("unknown-id");
    expect(result.isSuccess).toBe(false);
    expect(result.status).toBe(409);

    const bal = await client.getBalances({ tenant: "t" });
    expect(bal.body.balances[0].remaining.amount).toBe(10_000_000);
    expect(bal.body.balances[0].reserved.amount).toBe(0);
  });

  it("uses configured currency in balance responses", async () => {
    const client = new DryRunClient(5_000_000, "TOKENS");
    const res = await client.getBalances({ tenant: "test" });
    expect(res.body.balances[0].remaining.unit).toBe("TOKENS");
    expect(res.body.balances[0].spent.unit).toBe("TOKENS");
  });
});
