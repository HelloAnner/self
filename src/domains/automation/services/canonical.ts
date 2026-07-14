import { sha256Text } from "../../../shared/hash/sha256.ts";

export function canonicalAutomationJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function automationInputHash(value: unknown): string {
  return sha256Text(canonicalAutomationJson(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortValue(child)]),
    );
  }
  return value;
}
