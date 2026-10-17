// schemaAnalyzer.js - DDL/JSON Schema parsing, schema inference, and field-level discrepancy classification

import { maskStringPII } from "./piiMasker.js";

/**
 * Normalized standard types
 */
export const TYPE_CATEGORIES = {
  STRING: "string",
  INTEGER: "integer",
  FLOAT: "float",
  NUMERIC: "numeric",
  TIMESTAMP: "timestamp",
  DATE: "date",
  BOOLEAN: "boolean",
  OBJECT: "object",
  ARRAY: "array"
};

/**
 * Parses SQL CREATE TABLE DDL
 * @param {string} ddlText 
 * @returns {Map<string, { type: string, notNull: boolean, rawType: string }>}
 */
export function parseSqlDdl(ddlText) {
  const schema = new Map();
  if (!ddlText) return schema;

  // Extract column definitions inside outermost parentheses
  const firstParen = ddlText.indexOf("(");
  const lastParen = ddlText.lastIndexOf(")");
  const block = (firstParen !== -1 && lastParen > firstParen)
    ? ddlText.substring(firstParen + 1, lastParen)
    : ddlText;

  const lines = block.split(/,\s*\n|,\s*(?=[a-zA-Z_`])/);
  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith("--") || line.startsWith("PRIMARY KEY") || line.startsWith("CONSTRAINT")) {
      continue;
    }

    // Match column name and type e.g.: `transaction_id` STRING NOT NULL
    const match = line.match(/^[`"']?([a-zA-Z0-9_.]+)`?"?'?\s+([a-zA-Z0-9_()]+)(.*)/i);
    if (match) {
      const colName = match[1];
      const rawType = match[2].toUpperCase();
      const rest = match[3] ? match[3].toUpperCase() : "";
      const notNull = rest.includes("NOT NULL");

      schema.set(colName, {
        type: normalizeSqlType(rawType),
        rawType,
        notNull
      });
    }
  }

  return schema;
}

/**
 * Normalizes SQL type strings to canonical representation
 */
function normalizeSqlType(raw) {
  const t = raw.toUpperCase();
  if (t.includes("INT") || t === "BIGINT" || t === "SMALLINT" || t === "TINYINT" || t === "LONG") return TYPE_CATEGORIES.INTEGER;
  if (t === "NUMERIC" || t === "DECIMAL" || t === "BIGNUMERIC") return TYPE_CATEGORIES.NUMERIC;
  if (t.includes("FLOAT") || t.includes("DOUBLE") || t === "REAL") return TYPE_CATEGORIES.FLOAT;
  if (t.includes("TIMESTAMP") || t.includes("DATETIME")) return TYPE_CATEGORIES.TIMESTAMP;
  if (t.includes("DATE")) return TYPE_CATEGORIES.DATE;
  if (t.includes("BOOL")) return TYPE_CATEGORIES.BOOLEAN;
  if (t.includes("JSON") || t.includes("STRUCT")) return TYPE_CATEGORIES.OBJECT;
  return TYPE_CATEGORIES.STRING;
}

/**
 * Parses JSON Schema definition
 * @param {object} jsonSchema 
 * @returns {Map<string, { type: string, required: boolean, format?: string }>}
 */
export function parseJsonSchema(jsonSchema) {
  const schemaMap = new Map();
  if (!jsonSchema || typeof jsonSchema !== "object") return schemaMap;

  function traverse(obj, prefix = "") {
    if (!obj || typeof obj !== "object") return;

    const properties = obj.properties || {};
    const requiredList = Array.isArray(obj.required) ? obj.required : [];

    for (const [key, propDef] of Object.entries(properties)) {
      const fullPath = prefix ? `${prefix}.${key}` : key;
      const isRequired = requiredList.includes(key);
      const rawType = (propDef.type || "string").toLowerCase();

      schemaMap.set(fullPath, {
        type: rawType,
        rawType: propDef.type || "string",
        required: isRequired,
        format: propDef.format,
        items: propDef.items
      });

      if (rawType === "object" && propDef.properties) {
        traverse(propDef, fullPath);
      } else if (rawType === "array" && propDef.items && propDef.items.properties) {
        traverse(propDef.items, `${fullPath}[]`);
      }
    }
  }

  traverse(jsonSchema);
  return schemaMap;
}

/**
 * Infers expected schema from log error messages when schema input is not provided
 * @param {string} logText 
 * @param {object} payload 
 * @returns {Map<string, { type: string, rawType: string, notNull: boolean }>}
 */
export function inferSchemaFromLog(logText, payload) {
  const inferred = new Map();

  if (logText) {
    // 1. Check for BigQuery timestamp conversion errors
    const tsMatch = logText.match(/Could not convert value .*? to TIMESTAMP for column ['"`]([a-zA-Z0-9_.]+)['"`]/i);
    if (tsMatch) {
      inferred.set(tsMatch[1], { type: TYPE_CATEGORIES.TIMESTAMP, rawType: "TIMESTAMP", notNull: true });
    }

    // 2. Check for numeric type mismatch
    const numMatch = logText.match(/Field ['"`]([a-zA-Z0-9_.]+)['"`] has type (NUMERIC|INT\d+|FLOAT\d+|STRING|TIMESTAMP)/i);
    if (numMatch) {
      inferred.set(numMatch[1], {
        type: normalizeSqlType(numMatch[2]),
        rawType: numMatch[2],
        notNull: true
      });
    }

    // 3. DuckDB conversion error
    const duckMatch = logText.match(/Could not convert string .*? to (INT\d+|INTEGER|BIGINT|DOUBLE|FLOAT|TIMESTAMP) in column ['"`]([a-zA-Z0-9_.]+)['"`]/i);
    if (duckMatch) {
      inferred.set(duckMatch[2], {
        type: normalizeSqlType(duckMatch[1]),
        rawType: duckMatch[1],
        notNull: true
      });
    }

    // 4. Postgres / Redshift invalid input syntax
    const pgMatch = logText.match(/invalid input syntax for type (integer|numeric|timestamp|date|boolean): .*? on column ['"]?([a-zA-Z0-9_.]+)['"]?/i);
    if (pgMatch) {
      inferred.set(pgMatch[2], {
        type: normalizeSqlType(pgMatch[1]),
        rawType: pgMatch[1].toUpperCase(),
        notNull: true
      });
    }

    // 5. Snowflake unrecognized value
    const sfMatch = logText.match(/(?:Numeric|Timestamp|Date) value .*? is not recognized for column ['"]?([a-zA-Z0-9_.]+)['"]?/i);
    if (sfMatch) {
      inferred.set(sfMatch[1], {
        type: TYPE_CATEGORIES.NUMERIC,
        rawType: "NUMERIC",
        notNull: true
      });
    }

    // 6. Spark Cannot cast
    const sparkMatch = logText.match(/Cannot cast .*? from string to (int|long|double|float|timestamp) for field ['"]?([a-zA-Z0-9_.]+)['"]?/i);
    if (sparkMatch) {
      inferred.set(sparkMatch[2], {
        type: normalizeSqlType(sparkMatch[1]),
        rawType: sparkMatch[1].toUpperCase(),
        notNull: true
      });
    }

    // 7. Pydantic missing field: "customer.email\n  Field required"
    const missingMatches = logText.matchAll(/([a-zA-Z0-9_.]+)\s*\n\s*Field required/gi);
    for (const m of missingMatches) {
      inferred.set(m[1], { type: TYPE_CATEGORIES.STRING, rawType: "string", notNull: true, required: true });
    }

    // 8. Pydantic integer parsing error: "items.0.quantity\n  Input should be a valid integer"
    const pydanticInt = logText.matchAll(/([a-zA-Z0-9_.]+)\s*\n\s*Input should be a valid integer/gi);
    for (const m of pydanticInt) {
      inferred.set(m[1], { type: TYPE_CATEGORIES.INTEGER, rawType: "integer", notNull: true });
    }
  }

  // Populate remainder from payload if available
  if (payload) {
    const item = Array.isArray(payload) ? payload[0] : payload;
    if (item && typeof item === "object") {
      for (const [key, val] of Object.entries(item)) {
        if (!inferred.has(key)) {
          let detectedType = TYPE_CATEGORIES.STRING;
          if (typeof val === "number") {
            detectedType = Number.isInteger(val) ? TYPE_CATEGORIES.INTEGER : TYPE_CATEGORIES.FLOAT;
          } else if (typeof val === "boolean") {
            detectedType = TYPE_CATEGORIES.BOOLEAN;
          }
          inferred.set(key, {
            type: detectedType,
            rawType: detectedType.toUpperCase(),
            notNull: false
          });
        }
      }
    }
  }

  return inferred;
}

/**
 * Validates a value against an expected type
 * @param {any} val 
 * @param {string} expectedType 
 * @returns {{ valid: boolean, reason?: string, detectedType: string }}
 */
export function checkTypeConformance(val, expectedType) {
  if (val === null || val === undefined) {
    return { valid: false, reason: "Null or missing value", detectedType: "null" };
  }

  const rawStr = String(val).trim();

  switch (expectedType.toLowerCase()) {
    case TYPE_CATEGORIES.INTEGER: {
      if (typeof val === "number" && Number.isInteger(val)) {
        return { valid: true, detectedType: "integer" };
      }
      if (typeof val === "string") {
        if (/^-?\d+$/.test(rawStr)) {
          return { valid: true, detectedType: "string (integer)" };
        }
        if (/^-?\d+\.\d+$/.test(rawStr)) {
          return { valid: false, reason: "Float string passed to integer column", detectedType: "string (float)" };
        }
        return { valid: false, reason: "Non-numeric string", detectedType: `string ("${rawStr}")` };
      }
      return { valid: false, reason: `Type ${typeof val} not an integer`, detectedType: typeof val };
    }

    case TYPE_CATEGORIES.FLOAT:
    case TYPE_CATEGORIES.NUMERIC: {
      if (typeof val === "number" && !isNaN(val)) {
        return { valid: true, detectedType: "number" };
      }
      if (typeof val === "string") {
        if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(rawStr)) {
          return { valid: true, detectedType: "string (numeric)" };
        }
        return { valid: false, reason: `Invalid numeric literal '${rawStr}'`, detectedType: `string ("${rawStr}")` };
      }
      return { valid: false, reason: `Expected numeric, got ${typeof val}`, detectedType: isNaN(val) ? "NaN" : typeof val };
    }

    case TYPE_CATEGORIES.TIMESTAMP: {
      if (typeof val === "string") {
        if (/20\d\d-02-(?:30|31)/.test(rawStr)) {
          return { valid: false, reason: "Invalid calendar date (e.g., Feb 30th)", detectedType: `invalid timestamp ("${rawStr}")` };
        }
        const parsed = Date.parse(rawStr);
        if (isNaN(parsed)) {
          return { valid: false, reason: "Unparseable ISO timestamp", detectedType: `string ("${rawStr}")` };
        }
        return { valid: true, detectedType: "timestamp string" };
      }
      return { valid: false, reason: "Timestamp must be string or epoch", detectedType: typeof val };
    }

    case TYPE_CATEGORIES.DATE: {
      if (typeof val === "string") {
        if (/20\d\d-02-(?:30|31)/.test(rawStr)) {
          return { valid: false, reason: "Invalid calendar date (e.g., Feb 30th)", detectedType: `invalid date ("${rawStr}")` };
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(rawStr) || isNaN(Date.parse(rawStr))) {
          return { valid: false, reason: "Expected YYYY-MM-DD date format", detectedType: `string ("${rawStr}")` };
        }
        return { valid: true, detectedType: "date string" };
      }
      return { valid: false, reason: "Expected date string (YYYY-MM-DD)", detectedType: typeof val };
    }

    case TYPE_CATEGORIES.BOOLEAN: {
      if (typeof val === "boolean") return { valid: true, detectedType: "boolean" };
      if (rawStr === "true" || rawStr === "false") return { valid: true, detectedType: "string (boolean)" };
      return { valid: false, reason: "Invalid boolean", detectedType: typeof val };
    }

    case TYPE_CATEGORIES.OBJECT: {
      if (typeof val === "object" && !Array.isArray(val)) return { valid: true, detectedType: "object" };
      return { valid: false, reason: "Expected JSON object", detectedType: typeof val };
    }

    case TYPE_CATEGORIES.ARRAY: {
      if (Array.isArray(val)) return { valid: true, detectedType: "array" };
      return { valid: false, reason: "Expected array", detectedType: typeof val };
    }

    case TYPE_CATEGORIES.STRING:
    default: {
      if (typeof val === "string") return { valid: true, detectedType: "string" };
      return { valid: true, detectedType: typeof val };
    }
  }
}

/**
 * Main Schema Diffing Engine
 * @param {object} payload - Failing JSON payload extracted from log
 * @param {string} rawSchemaInput - Optional expected schema DDL / JSON Schema
 * @param {string} rawLog - Raw error log text
 * @returns {Array<object>} List of categorized discrepancies
 */
export function analyzeSchemaDiscrepancies(payload, rawSchemaInput, rawLog) {
  const discrepancies = [];
  if (!payload) return discrepancies;

  // 1. Determine expected schema
  let schemaMap = new Map();
  const trimmedSchema = (rawSchemaInput || "").trim();

  if (trimmedSchema.startsWith("{") || trimmedSchema.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmedSchema);
      if (parsed.properties || parsed.$schema || parsed.type === "object") {
        schemaMap = parseJsonSchema(parsed);
      } else {
        // Treat as sample valid JSON
        schemaMap = inferSchemaFromLog("", parsed);
      }
    } catch {
      schemaMap = inferSchemaFromLog(rawLog, payload);
    }
  } else if (/CREATE\s+TABLE/i.test(trimmedSchema)) {
    schemaMap = parseSqlDdl(trimmedSchema);
  } else {
    // Inferred from log and payload
    schemaMap = inferSchemaFromLog(rawLog, payload);
  }

  // Work with first object if array
  const record = Array.isArray(payload) ? payload[0] : payload;
  if (!record || typeof record !== "object") return discrepancies;

  // Helper to extract nested value by path (e.g. "customer.email" or "items[0].quantity")
  function getNestedValue(obj, path) {
    const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".");
    let curr = obj;
    for (const part of parts) {
      if (curr === null || curr === undefined) return undefined;
      curr = curr[part];
    }
    return curr;
  }

  // Expand array paths e.g. "items[].price" across all elements in record
  function resolveFieldPaths(fieldPath) {
    if (!fieldPath.includes("[]")) return [fieldPath];
    const prefix = fieldPath.substring(0, fieldPath.indexOf("[]"));
    const suffix = fieldPath.substring(fieldPath.indexOf("[]") + 2);
    const arr = getNestedValue(record, prefix);
    if (!Array.isArray(arr) || arr.length === 0) {
      return [`${prefix}[0]${suffix}`];
    }
    return arr.map((_, idx) => `${prefix}[${idx}]${suffix}`);
  }

  // 2. Check each expected field in Schema
  for (const [fieldPath, fieldDef] of schemaMap.entries()) {
    const resolvedPaths = resolveFieldPaths(fieldPath);

    for (const cleanPath of resolvedPaths) {
      const val = getNestedValue(record, cleanPath);
      const expectedDisplayType = fieldDef.rawType || fieldDef.type;
      const isRequired = fieldDef.notNull || fieldDef.required;

      // Check: Missing Required Field
      if (val === undefined) {
        if (isRequired) {
          discrepancies.push({
            fieldPath: cleanPath,
            expectedType: `${expectedDisplayType} (Required)`,
            observedValue: "None (Field omitted)",
            receivedType: "undefined",
            issueCategory: "Missing Required Field",
            actionNeeded: "Inject default fallback or make field nullable in schema"
          });
        }
        continue;
      }

      // Check: Null Constraint Violation
      if (val === null) {
        if (isRequired) {
          discrepancies.push({
            fieldPath: cleanPath,
            expectedType: `${expectedDisplayType} (NOT NULL)`,
            observedValue: "null",
            receivedType: "null",
            issueCategory: "Null Constraint Violation",
            actionNeeded: "Provide non-null coalesced value or relax NOT NULL constraint"
          });
        }
        continue;
      }

      // Check: Type Mismatch
      const conformance = checkTypeConformance(val, fieldDef.type);
      if (!conformance.valid) {
        const maskedVal = maskStringPII(typeof val === "object" ? JSON.stringify(val) : String(val));
        discrepancies.push({
          fieldPath: cleanPath,
          expectedType: expectedDisplayType,
          observedValue: maskedVal,
          receivedType: conformance.detectedType,
          issueCategory: "Type Mismatch",
          actionNeeded: `Apply ${fieldDef.type.toUpperCase()} safe coercion or regex data cleaning`
        });
      }
    }
  }

  // 3. Check for Unexpected Extra Keys (Schema Drift)
  function findExtraKeys(obj, prefix = "") {
    if (!obj || typeof obj !== "object") return;

    for (const key of Object.keys(obj)) {
      const fullPath = prefix ? `${prefix}.${key}` : key;
      const isExpected = schemaMap.has(fullPath) || 
                         schemaMap.has(key) ||
                         schemaMap.has(fullPath.replace(/\[\d+\]/, "[]"));

      if (!isExpected) {
        const val = obj[key];
        const maskedVal = maskStringPII(typeof val === "object" ? JSON.stringify(val) : String(val));
        discrepancies.push({
          fieldPath: fullPath,
          expectedType: "Not defined in target schema",
          observedValue: maskedVal,
          receivedType: Array.isArray(val) ? "array" : typeof val,
          issueCategory: "Unexpected Extra Key",
          actionNeeded: "Add column to destination DDL (Schema Drift) or prune during ingest"
        });
      } else if (typeof obj[key] === "object" && obj[key] !== null) {
        findExtraKeys(obj[key], fullPath);
      }
    }
  }

  if (schemaMap.size >= 3) {
    findExtraKeys(record);
  }

  return discrepancies;
}
