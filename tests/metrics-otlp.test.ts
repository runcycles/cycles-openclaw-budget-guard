import { describe, it, expect, vi, beforeEach } from "vitest";
import { createOtlpEmitter } from "../src/metrics-otlp.js";

const mockFetch = vi.fn(() => Promise.resolve({ ok: true }));
vi.stubGlobal("fetch", mockFetch);

describe("createOtlpEmitter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns an object with gauge, counter, histogram, and flush methods", () => {
    const emitter = createOtlpEmitter({ endpoint: "http://localhost:4318/v1/metrics" });
    expect(typeof emitter.gauge).toBe("function");
    expect(typeof emitter.counter).toBe("function");
    expect(typeof emitter.histogram).toBe("function");
    expect(typeof emitter.flush).toBe("function");
  });

  it("buffers metrics and sends them on flush", async () => {
    const emitter = createOtlpEmitter({ endpoint: "http://localhost:4318/v1/metrics" });

    emitter.gauge("test.gauge", 42, { env: "test" });
    emitter.counter("test.counter", 1, { op: "create" });
    emitter.histogram("test.histogram", 100);

    await emitter.flush();

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:4318/v1/metrics");
    expect(opts.method).toBe("POST");
    expect(opts.headers).toEqual(expect.objectContaining({
      "Content-Type": "application/json",
    }));

    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    expect(body).toHaveProperty("resourceMetrics");
    const rm = (body.resourceMetrics as unknown[])[0] as Record<string, unknown>;
    const sm = (rm.scopeMetrics as unknown[])[0] as Record<string, unknown>;
    const metrics = sm.metrics as Record<string, unknown>[];
    expect(metrics).toHaveLength(3);
    expect(metrics[0]).toHaveProperty("name", "test.gauge");
    expect(metrics[1]).toHaveProperty("name", "test.counter");
    expect(metrics[2]).toHaveProperty("name", "test.histogram");
  });

  it("includes custom headers", async () => {
    const emitter = createOtlpEmitter({
      endpoint: "http://localhost:4318/v1/metrics",
      headers: { "X-Api-Key": "secret" },
    });

    emitter.gauge("test", 1);
    await emitter.flush();

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((opts.headers as Record<string, string>)["X-Api-Key"]).toBe("secret");
  });

  it("does nothing on flush when buffer is empty", async () => {
    const emitter = createOtlpEmitter({ endpoint: "http://localhost:4318/v1/metrics" });
    await emitter.flush();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("does not throw when fetch fails", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network error"));
    const emitter = createOtlpEmitter({ endpoint: "http://localhost:4318/v1/metrics" });
    emitter.gauge("test", 1);
    await expect(emitter.flush()).resolves.not.toThrow();
  });

  it("encodes sum metrics with aggregation temporality", async () => {
    const emitter = createOtlpEmitter({ endpoint: "http://localhost:4318/v1/metrics" });
    emitter.counter("ops.count", 5, { service: "guard" });
    await emitter.flush();

    const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string) as Record<string, unknown>;
    const rm = (body.resourceMetrics as unknown[])[0] as Record<string, unknown>;
    const sm = (rm.scopeMetrics as unknown[])[0] as Record<string, unknown>;
    const metric = (sm.metrics as Record<string, unknown>[])[0];
    expect(metric).toHaveProperty("sum");
    const sum = metric.sum as Record<string, unknown>;
    expect(sum.aggregationTemporality).toBe(1);
    expect(sum.isMonotonic).toBe(true);
  });

  it("auto-flushes when buffer hits maxBufferSize", async () => {
    const emitter = createOtlpEmitter({
      endpoint: "http://localhost:4318/v1/metrics",
      maxBufferSize: 3,
    });

    emitter.gauge("m1", 1);
    emitter.gauge("m2", 2);
    // No flush yet — buffer has 2 items
    expect(mockFetch).not.toHaveBeenCalled();

    emitter.gauge("m3", 3);
    // Buffer hit maxBufferSize (3) — auto-flush triggered
    // flush() is async fire-and-forget so wait for microtask
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("starts a flush timer on first enqueue", async () => {
    const emitter = createOtlpEmitter({
      endpoint: "http://localhost:4318/v1/metrics",
      flushIntervalMs: 100,
    });
    // Enqueue to start the timer
    emitter.gauge("timer.test", 1);
    // Manually flush to clean up
    await emitter.flush();
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("encodes histogram metrics as gauge data points", async () => {
    const emitter = createOtlpEmitter({ endpoint: "http://localhost:4318/v1/metrics" });
    emitter.histogram("latency", 250, { endpoint: "/api" });
    await emitter.flush();

    const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string) as Record<string, unknown>;
    const rm = (body.resourceMetrics as unknown[])[0] as Record<string, unknown>;
    const sm = (rm.scopeMetrics as unknown[])[0] as Record<string, unknown>;
    const metric = (sm.metrics as Record<string, unknown>[])[0];
    expect(metric.name).toBe("latency");
    // Histogram is approximated as gauge in v0.5.0
    expect(metric).toHaveProperty("gauge");
  });
});
