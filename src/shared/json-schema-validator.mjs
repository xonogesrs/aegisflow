// shared/json-schema-validator.mjs
//
// Minimal JSON Schema draft-07 validator for AutoLoop schemas.
// Supports: type, required, properties, additionalProperties,
// enum, const, oneOf, minItems, maxItems, minLength, items.

export function validate(schema, data, path = "$") {
  const errors = [];
  if (schema === undefined || schema === null) return { valid: true, errors };

  // const
  if (schema.const !== undefined && data !== schema.const) {
    errors.push(`${path}: expected ${JSON.stringify(schema.const)}, got ${JSON.stringify(data)}`);
    return { valid: false, errors };
  }

  // enum
  if (schema.enum && !schema.enum.includes(data)) {
    errors.push(`${path}: expected one of [${schema.enum.join(", ")}], got ${JSON.stringify(data)}`);
    return { valid: false, errors };
  }

  // type
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    let typeMatch = false;
    for (const t of types) {
      if (t === "null" && data === null) { typeMatch = true; break; }
      if (t === "array" && Array.isArray(data)) { typeMatch = true; break; }
      if (t === "object" && data !== null && typeof data === "object" && !Array.isArray(data)) { typeMatch = true; break; }
      if (typeof data === t) { typeMatch = true; break; }
    }
    if (!typeMatch) {
      errors.push(`${path}: expected ${types.join("|")}, got ${data === null ? "null" : Array.isArray(data) ? "array" : typeof data}`);
      return { valid: false, errors };
    }
  }

  // string constraints
  if (typeof data === "string") {
    if (schema.minLength !== undefined && data.length < schema.minLength) {
      errors.push(`${path}: minLength ${schema.minLength}, got ${data.length}`);
    }
  }

  // array constraints
  if (Array.isArray(data)) {
    if (schema.minItems !== undefined && data.length < schema.minItems) {
      errors.push(`${path}: minItems ${schema.minItems}, got ${data.length}`);
    }
    if (schema.maxItems !== undefined && data.length > schema.maxItems) {
      errors.push(`${path}: maxItems ${schema.maxItems}, got ${data.length}`);
    }
    if (schema.items) {
      for (let i = 0; i < data.length; i++) {
        const r = validate(schema.items, data[i], `${path}[${i}]`);
        errors.push(...r.errors);
      }
    }
    return { valid: errors.length === 0, errors };
  }

  // object constraints
  if (data && typeof data === "object" && !Array.isArray(data)) {
    // required
    if (schema.required) {
      for (const req of schema.required) {
        if (!(req in data)) {
          errors.push(`${path}: missing required property "${req}"`);
        }
      }
    }

    // additionalProperties
    if (schema.properties) {
      const allowed = new Set(Object.keys(schema.properties));
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(data)) {
          if (!allowed.has(key)) {
            errors.push(`${path}: unexpected property "${key}"`);
          }
        }
      }
    }

    // properties
    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in data) {
          const r = validate(propSchema, data[key], `${path}.${key}`);
          errors.push(...r.errors);
        }
      }
    }

    // oneOf
    if (schema.oneOf) {
      let matchCount = 0;
      const oneOfErrors = [];
      for (let i = 0; i < schema.oneOf.length; i++) {
        const r = validate(schema.oneOf[i], data, `${path}[oneOf#${i}]`);
        if (r.errors.length === 0) matchCount++;
        oneOfErrors.push(r.errors);
      }
      if (matchCount === 0) {
        errors.push(`${path}: matches none of ${schema.oneOf.length} oneOf variants`);
      } else if (matchCount > 1) {
        errors.push(`${path}: matches ${matchCount} oneOf variants (expected exactly 1)`);
      }
    }

    return { valid: errors.length === 0, errors };
  }

  return { valid: errors.length === 0, errors };
}
