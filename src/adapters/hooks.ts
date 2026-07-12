/**
 * Shared surgical hook removal for adapters that append command hooks to a
 * `{ hooks: { <event>: [...] } }` JSON config. Removes only entries the adapter
 * recognizes as its own (via `isHollrEntry`), prunes an event array it empties,
 * and drops the `hooks` object when nothing remains — preserving `version`, all
 * unrelated events, and any foreign entries. Pure; no I/O.
 */

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function removeHollrHooks(
  json: JsonObject,
  eventKeys: readonly string[],
  isHollrEntry: (entry: unknown) => boolean,
): JsonObject {
  if (!isRecord(json.hooks)) {
    return json;
  }
  const hooks: JsonObject = { ...json.hooks };
  for (const event of eventKeys) {
    const arr = hooks[event];
    if (!Array.isArray(arr)) {
      continue;
    }
    const kept = arr.filter((entry) => !isHollrEntry(entry));
    if (kept.length > 0) {
      hooks[event] = kept;
    } else {
      delete hooks[event];
    }
  }
  if (Object.keys(hooks).length === 0) {
    const { hooks: _drop, ...rest } = json;
    return rest;
  }
  return { ...json, hooks };
}
