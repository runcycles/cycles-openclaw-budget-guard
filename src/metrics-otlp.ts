/**
 * Lightweight OTLP HTTP metrics adapter (v0.5.0).
 *
 * Implements the MetricsEmitter interface by buffering datapoints and
 * flushing them as OTLP JSON via HTTP POST. No dependency on the full
 * OpenTelemetry SDK — just plain fetch().
 */

import type { MetricsEmitter } from "./types.js";

interface DataPoint {
  name: string;
  type: "gauge" | "sum" | "histogram";
  value: number;
  tags: Record<string, string>;
  timestampMs: number;
}

export interface OtlpEmitterOptions {
  endpoint: string;
  headers?: Record<string, string>;
  flushIntervalMs?: number;
  maxBufferSize?: number;
}

export function createOtlpEmitter(opts: OtlpEmitterOptions): MetricsEmitter & { flush(): Promise<void> } {
  const buffer: DataPoint[] = [];
  const flushIntervalMs = opts.flushIntervalMs ?? 10_000;
  const maxBufferSize = opts.maxBufferSize ?? 1000;

  let flushTimer: ReturnType<typeof setInterval> | undefined;

  async function flush(): Promise<void> {
    if (buffer.length === 0) return;
    const batch = buffer.splice(0, buffer.length);
    const payload = toOtlpPayload(batch);
    try {
      await fetch(opts.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...opts.headers,
        },
        body: JSON.stringify(payload),
      });
    } catch {
      // Best-effort — metrics loss is acceptable
    }
  }

  function enqueue(dp: DataPoint): void {
    buffer.push(dp);
    if (buffer.length >= maxBufferSize) {
      flush();
    }
    if (!flushTimer) {
      flushTimer = setInterval(() => { flush(); }, flushIntervalMs);
      // Don't block process exit
      if (typeof flushTimer === "object" && "unref" in flushTimer) {
        flushTimer.unref();
      }
    }
  }

  return {
    gauge(name: string, value: number, tags: Record<string, string> = {}) {
      enqueue({ name, type: "gauge", value, tags, timestampMs: Date.now() });
    },
    counter(name: string, delta: number, tags: Record<string, string> = {}) {
      enqueue({ name, type: "sum", value: delta, tags, timestampMs: Date.now() });
    },
    histogram(name: string, value: number, tags: Record<string, string> = {}) {
      enqueue({ name, type: "histogram", value, tags, timestampMs: Date.now() });
    },
    flush,
  };
}

function toOtlpPayload(batch: DataPoint[]): Record<string, unknown> {
  const metrics: Record<string, unknown>[] = [];

  for (const dp of batch) {
    const attributes = Object.entries(dp.tags).map(([key, value]) => ({
      key,
      value: { stringValue: value },
    }));
    const timeUnixNano = String(dp.timestampMs * 1_000_000);

    const dataPoint = {
      attributes,
      timeUnixNano,
      asDouble: dp.value,
    };

    const metric: Record<string, unknown> = { name: dp.name };
    if (dp.type === "gauge") {
      metric.gauge = { dataPoints: [dataPoint] };
    } else if (dp.type === "sum") {
      metric.sum = {
        dataPoints: [dataPoint],
        aggregationTemporality: 1, // DELTA
        isMonotonic: true,
      };
    } else {
      // Histogram approximation: single-bucket representation
      metric.gauge = { dataPoints: [dataPoint] };
    }

    metrics.push(metric);
  }

  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "cycles-budget-guard" } },
          ],
        },
        scopeMetrics: [
          {
            scope: { name: "cycles-budget-guard", version: "0.6.0" },
            metrics,
          },
        ],
      },
    ],
  };
}
