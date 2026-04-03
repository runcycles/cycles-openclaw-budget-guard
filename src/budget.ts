/** Budget classification, prompt hint formatting, and tool permission checks. */

import type { BudgetGuardConfig, BudgetLevel, BudgetSnapshot } from "./types.js";

export function classifyBudget(
  remaining: number,
  config: BudgetGuardConfig,
): BudgetLevel {
  if (remaining <= config.exhaustedThreshold) return "exhausted";
  if (remaining <= config.lowBudgetThreshold) return "low";
  return "healthy";
}

// ---------------------------------------------------------------------------
// Budget hint formatting (Gap 9: forecast, Gap 18: pool info)
// ---------------------------------------------------------------------------

export interface ForecastData {
  avgToolCost: number;
  avgModelCost: number;
  totalToolCalls: number;
  totalModelCalls: number;
}

export function formatBudgetHint(
  snapshot: BudgetSnapshot,
  config: BudgetGuardConfig,
  forecast?: ForecastData,
): string {
  const parts: string[] = [];

  parts.push(`Budget: ${snapshot.remaining} ${config.currency} remaining.`);

  if (snapshot.level === "low") {
    parts.push("Budget is low — prefer cheaper models and avoid expensive tools.");
  } else if (snapshot.level === "exhausted") {
    parts.push("Budget is exhausted — minimize resource usage.");
  }

  if (snapshot.allocated !== undefined && snapshot.allocated > 0) {
    const pct = Math.round((snapshot.remaining / snapshot.allocated) * 100);
    parts.push(`${pct}% of budget remaining.`);
  }

  // Gap 9: Forecast projection
  if (forecast && snapshot.remaining < Infinity) {
    const projections: string[] = [];
    if (forecast.totalToolCalls > 0 && forecast.avgToolCost > 0) {
      const remaining = Math.floor(snapshot.remaining / forecast.avgToolCost);
      projections.push(`~${remaining} tool calls`);
    }
    if (forecast.totalModelCalls > 0 && forecast.avgModelCost > 0) {
      const remaining = Math.floor(snapshot.remaining / forecast.avgModelCost);
      projections.push(`~${remaining} model calls`);
    }
    if (projections.length > 0) {
      parts.push(`Est. ${projections.join(" and ")} remaining at current rate.`);
    }
  }

  // Gap 18: Pool info
  if (snapshot.poolRemaining !== undefined) {
    parts.push(`Team pool: ${snapshot.poolRemaining} remaining.`);
  }

  const hint = parts.join(" ");
  if (hint.length > config.maxPromptHintChars) {
    return hint.slice(0, Math.max(0, config.maxPromptHintChars - 3)) + "...";
  }
  return hint;
}

// ---------------------------------------------------------------------------
// Tool permission checks (Gap 7)
// ---------------------------------------------------------------------------

export function isToolPermitted(
  toolName: string,
  allowlist?: string[],
  blocklist?: string[],
): { permitted: boolean; reason?: string } {
  if (blocklist) {
    for (const pattern of blocklist) {
      if (matchGlob(toolName, pattern)) {
        return { permitted: false, reason: `Tool "${toolName}" is blocklisted (pattern: ${pattern})` };
      }
    }
  }
  if (allowlist) {
    const allowed = allowlist.some((pattern) => matchGlob(toolName, pattern));
    if (!allowed) {
      return { permitted: false, reason: `Tool "${toolName}" is not on the allowlist` };
    }
  }
  return { permitted: true };
}

function matchGlob(value: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return value === pattern;
  const parts = pattern.split("*");
  const regexStr = "^" + parts.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$";
  return new RegExp(regexStr).test(value);
}
