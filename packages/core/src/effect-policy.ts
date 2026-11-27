import type { Effect } from "./capabilities.ts";
import type { Permission } from "./state.ts";

// Scope checks (active task, borrow ceiling, explicit denial) precede this decision.
export function approvalRoute(effect: Effect, options: {
  internal: boolean; permission?: Permission; canReview: boolean;
}): "allow" | "review" | "ask" {
  if (effect === "read" || options.internal) return "allow";
  if (effect === "irreversible") return options.permission === "full" ? "allow" : "ask";
  return options.canReview ? "review" : "ask";
}

export function canonicalArguments(args: unknown): string {
  return JSON.stringify(args, (_, value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value) ?? "null";
}
