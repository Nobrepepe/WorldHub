/**
 * Generic validation for contract-defined field values. Deterministic:
 * the same contract and values always produce the same issues in the
 * same order. Issues carry stable codes and human sentences.
 */

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate one value against a field definition.
 * refs: { entityExists(id, types), assetExists(id, kinds) } lets the
 * caller ground references without coupling this engine to SQL.
 * Returns a list of { code, message } problems (empty when valid).
 */
export function validateFieldValue(def, value, refs) {
  const problems = [];
  const missing = value === undefined || value === null || value === '';

  if (missing) {
    if (def.required) problems.push({ code: 'field.required', message: `“${def.label}” is required.` });
    return problems;
  }

  switch (def.type) {
    case 'shortText':
    case 'multilineText':
    case 'markdown': {
      if (typeof value !== 'string') { problems.push(bad(def, 'expected text')); break; }
      if (def.type === 'shortText' && value.includes('\n')) problems.push({ code: 'field.single_line', message: `“${def.label}” must be a single line.` });
      if (def.minLength !== undefined && value.length < def.minLength) problems.push({ code: 'field.too_short', message: `“${def.label}” must be at least ${def.minLength} characters.` });
      if (def.maxLength !== undefined && value.length > def.maxLength) problems.push({ code: 'field.too_long', message: `“${def.label}” must be at most ${def.maxLength} characters.` });
      if (def.pattern) {
        try {
          if (!new RegExp(def.pattern).test(value)) problems.push({ code: 'field.pattern', message: `“${def.label}” does not match the expected pattern.` });
        } catch { /* malformed pattern is a contract problem, not a value problem */ }
      }
      break;
    }
    case 'integer': {
      if (typeof value !== 'number' || !Number.isInteger(value)) { problems.push(bad(def, 'expected a whole number')); break; }
      checkRange(def, value, problems);
      break;
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) { problems.push(bad(def, 'expected a number')); break; }
      checkRange(def, value, problems);
      break;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') problems.push(bad(def, 'expected yes or no'));
      break;
    }
    case 'enum': {
      const allowed = (def.options ?? []).map((o) => o.value);
      if (!allowed.includes(value)) problems.push({ code: 'field.enum', message: `“${def.label}” must be one of: ${allowed.join(', ')}.` });
      break;
    }
    case 'color': {
      if (typeof value !== 'string' || !COLOR_RE.test(value)) problems.push({ code: 'field.color', message: `“${def.label}” must be a color like #e9a94f.` });
      break;
    }
    case 'entityRef': {
      if (typeof value !== 'string' || !UUID_RE.test(value)) { problems.push(bad(def, 'expected a record reference')); break; }
      if (refs && !refs.entityExists(value, def.entityTypes ?? null)) {
        problems.push({ code: 'field.entity_missing', message: `“${def.label}” points to a record that no longer exists or has the wrong type.` });
      }
      break;
    }
    case 'assetRef': {
      if (typeof value !== 'string' || !UUID_RE.test(value)) { problems.push(bad(def, 'expected an asset reference')); break; }
      if (refs && !refs.assetExists(value, def.assetKinds ?? null)) {
        problems.push({ code: 'field.asset_missing', message: `“${def.label}” points to an asset that no longer exists or has the wrong kind.` });
      }
      break;
    }
    case 'list': {
      if (!Array.isArray(value)) { problems.push(bad(def, 'expected a list')); break; }
      if (def.minItems !== undefined && value.length < def.minItems) problems.push({ code: 'field.list_short', message: `“${def.label}” needs at least ${def.minItems} item(s).` });
      if (def.maxItems !== undefined && value.length > def.maxItems) problems.push({ code: 'field.list_long', message: `“${def.label}” allows at most ${def.maxItems} item(s).` });
      value.forEach((entry, index) => {
        if (def.fields) {
          if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
            problems.push({ code: 'field.list_entry', message: `Item ${index + 1} of “${def.label}” is not a group.` });
            return;
          }
          for (const sub of def.fields) {
            for (const problem of validateFieldValue(sub, entry[sub.id], refs)) {
              problems.push({ ...problem, message: `Item ${index + 1} of “${def.label}”: ${problem.message}` });
            }
          }
        } else if (def.item) {
          for (const problem of validateFieldValue(def.item, entry, refs)) {
            problems.push({ ...problem, message: `Item ${index + 1} of “${def.label}”: ${problem.message}` });
          }
        }
      });
      break;
    }
    default:
      problems.push({ code: 'field.unknown_type', message: `“${def.label}” uses an unknown field type.` });
  }
  return problems;
}

function bad(def, why) {
  return { code: 'field.type', message: `“${def.label}”: ${why}.` };
}

function checkRange(def, value, problems) {
  if (def.min !== undefined && value < def.min) problems.push({ code: 'field.min', message: `“${def.label}” must be at least ${def.min}.` });
  if (def.max !== undefined && value > def.max) problems.push({ code: 'field.max', message: `“${def.label}” must be at most ${def.max}.` });
}

/** Count constraints for selections and asset sets. */
export function countBounds(def) {
  if (def.exact !== undefined) return { min: def.exact, max: def.exact, exact: def.exact };
  return { min: def.min ?? 0, max: def.max ?? Infinity, exact: undefined };
}
