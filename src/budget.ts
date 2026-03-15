/** Budget classification and prompt hint formatting. */

import type { BudgetGuardConfig, BudgetLevel, BudgetSnapshot } from "./types.js";

export function classifyBudget(
  remaining: number,
  config: BudgetGuardConfig,
): BudgetLevel {
  if (remaining <= config.exhaustedThreshold) return "exhausted";
  if (remaining <= config.lowBudgetThreshold) return "low";
  return "healthy";
}

export function formatBudgetHint(
  snapshot: BudgetSnapshot,
  config: BudgetGuardConfig,
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

  const hint = parts.join(" ");
  if (hint.length > config.maxPromptHintChars) {
    return hint.slice(0, config.maxPromptHintChars - 3) + "...";
  }
  return hint;
}
