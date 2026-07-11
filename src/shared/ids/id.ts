import { v7 as uuidv7 } from "uuid";
import { RESOURCE_PREFIXES, type ResourceId, type ResourceName } from "./registry.ts";

export function createResourceId<T extends ResourceName>(resource: T): ResourceId<T> {
  return `${resource}:${RESOURCE_PREFIXES[resource]}_${uuidv7()}` as ResourceId<T>;
}

export function createRequestId(): string {
  return `req_${uuidv7()}`;
}

export function isResourceId<T extends ResourceName>(
  value: string,
  resource: T,
): value is ResourceId<T> {
  const prefix = `${resource}:${RESOURCE_PREFIXES[resource]}_`;
  return value.startsWith(prefix) && value.length === prefix.length + 36;
}
