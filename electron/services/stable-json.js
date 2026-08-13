/**
 * Deterministic JSON for published packages: recursively sorted object
 * keys, stable record sorting left to callers, UTF-8, two-space
 * indentation, trailing newline. The same data always produces the
 * same bytes.
 */
export function stableJson(value) {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys(value[key]);
    }
    return out;
  }
  return value;
}
