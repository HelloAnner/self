import { sha256Text } from "../../../infrastructure/filesystem/hash.ts";
import type { VectorSpaceDefinition } from "../model/types.ts";

export function vectorSpaceFingerprint(definition: VectorSpaceDefinition): string {
  return sha256Text(JSON.stringify(canonical(definition)));
}

export function canonical<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, item]),
  ) as T;
}
