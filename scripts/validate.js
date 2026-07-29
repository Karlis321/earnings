#!/usr/bin/env node
/**
 * Zero-dependency validator for data/summaries/*.json against
 * data/summaries-schema.json. Also enforces filename<->content
 * consistency: file <TICKER>_<PERIOD>.json must have body.ticker
 * matching TICKER (with '_' → ' ') and body.period matching PERIOD.
 *
 *   node scripts/validate.js                  # scans all summaries
 *   node scripts/validate.js path/to/one.json # single-file mode
 *
 * Wired into scripts/test-standing.mjs so summaries can never regress
 * past the invariant gate.
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SUMMARIES_DIR = path.join(ROOT, "data", "summaries");
const SCHEMA_PATH = path.join(ROOT, "data", "summaries-schema.json");

function loadSchema() {
  return JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf-8"));
}

function typeMatches(spec, value) {
  const types = Array.isArray(spec.type) ? spec.type : [spec.type];
  for (const t of types) {
    if (t === "null" && value === null) return true;
    if (t === "string" && typeof value === "string") return true;
    if (t === "number" && typeof value === "number") return true;
    if (t === "boolean" && typeof value === "boolean") return true;
    if (t === "array" && Array.isArray(value)) return true;
    if (t === "object" && value !== null && typeof value === "object" && !Array.isArray(value)) return true;
  }
  return false;
}

// Draft-07 subset — supports the shapes in summaries-schema.json.
function validateAgainst(schema, value, pathParts, errors) {
  if (!typeMatches(schema, value)) {
    errors.push(`${pathParts.join(".") || "<root>"}: expected type ${JSON.stringify(schema.type)}, got ${value === null ? "null" : Array.isArray(value) ? "array" : typeof value}`);
    return;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${pathParts.join(".")}: value ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`);
  }
  if (schema.type === "string") {
    if (schema.minLength != null && value.length < schema.minLength) {
      errors.push(`${pathParts.join(".")}: length ${value.length} < minLength ${schema.minLength}`);
    }
    if (schema.maxLength != null && value.length > schema.maxLength) {
      errors.push(`${pathParts.join(".")}: length ${value.length} > maxLength ${schema.maxLength}`);
    }
    if (schema.pattern) {
      const re = new RegExp(schema.pattern);
      if (!re.test(value)) {
        errors.push(`${pathParts.join(".")}: does not match pattern /${schema.pattern}/`);
      }
    }
    if (schema.format === "date") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
        errors.push(`${pathParts.join(".")}: not a valid ISO date`);
      }
    }
    if (schema.format === "date-time") {
      if (Number.isNaN(Date.parse(value))) {
        errors.push(`${pathParts.join(".")}: not a valid ISO date-time`);
      }
    }
    if (schema.format === "uri") {
      try { new URL(value); } catch { errors.push(`${pathParts.join(".")}: not a valid URI`); }
    }
    return;
  }
  if (schema.type === "array") {
    if (schema.minItems != null && value.length < schema.minItems) {
      errors.push(`${pathParts.join(".")}: array length ${value.length} < minItems ${schema.minItems}`);
    }
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        validateAgainst(schema.items, value[i], [...pathParts, `[${i}]`], errors);
      }
    }
    return;
  }
  if (schema.type === "object") {
    const props = schema.properties ?? {};
    for (const req of schema.required ?? []) {
      if (!(req in value)) errors.push(`${pathParts.join(".") || "<root>"}: missing required property "${req}"`);
    }
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(value)) {
        if (!(k in props)) errors.push(`${pathParts.join(".") || "<root>"}: unexpected additional property "${k}"`);
      }
    }
    for (const [k, sub] of Object.entries(props)) {
      if (k in value) validateAgainst(sub, value[k], [...pathParts, k], errors);
    }
    return;
  }
}

// summary_short MUST contain at least one number — enforce here since
// JSON Schema's pattern is awkward for "contains a digit anywhere".
function extraChecks(body, errors) {
  if (typeof body.summary_short === "string" && !/\d/.test(body.summary_short)) {
    errors.push(`summary_short: must contain at least one numeric figure`);
  }
  if (typeof body.summary_long === "string") {
    const wordCount = body.summary_long.trim().split(/\s+/).filter(Boolean).length;
    if (wordCount > 120) errors.push(`summary_long: ${wordCount} words > 120`);
  }
  if (typeof body.headline === "string" && /\d/.test(body.headline)) {
    errors.push(`headline: must not contain digits (verdict-style, no numbers)`);
  }
  // Aggregator blocklist for source_url.
  if (typeof body.source_url === "string") {
    const bad = ["yahoo.com", "finance.yahoo.com", "reuters.com/markets", "seekingalpha.com", "marketwatch.com", "cnbc.com", "bloomberg.com", "investing.com", "zacks.com", "fool.com", "benzinga.com"];
    const hit = bad.find((d) => body.source_url.includes(d));
    if (hit) errors.push(`source_url: aggregator "${hit}" not allowed — use the company release or EDGAR`);
  }
}

function filenameConsistency(fp, body, errors) {
  const base = path.basename(fp, ".json");
  const parts = base.split("_");
  if (parts.length < 4) {
    errors.push(`filename: "${base}" must match <TICKER>_<PERIOD> (e.g. HBM_US_FY2026_Q2)`);
    return;
  }
  const period = parts.slice(-2).join(" ");
  const ticker = parts.slice(0, -2).join(" ");
  if (body.ticker !== ticker) errors.push(`filename: ticker "${ticker}" in name vs body "${body.ticker}"`);
  if (body.period !== period) errors.push(`filename: period "${period}" in name vs body "${body.period}"`);
}

function validateFile(fp, schema) {
  let body;
  try {
    body = JSON.parse(fs.readFileSync(fp, "utf-8"));
  } catch (e) {
    return { file: fp, errors: [`could not parse JSON: ${e.message}`] };
  }
  const errors = [];
  validateAgainst(schema, body, [], errors);
  extraChecks(body, errors);
  filenameConsistency(fp, body, errors);
  return { file: fp, errors };
}

function main() {
  const schema = loadSchema();
  const args = process.argv.slice(2);
  let files;
  if (args.length > 0) {
    files = args.map((a) => path.resolve(a));
  } else if (fs.existsSync(SUMMARIES_DIR)) {
    files = fs
      .readdirSync(SUMMARIES_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => path.join(SUMMARIES_DIR, f));
  } else {
    files = [];
  }

  if (files.length === 0) {
    console.log("validate: no summaries to check (data/summaries/ empty or missing)");
    process.exit(0);
  }

  let bad = 0;
  for (const fp of files) {
    const { errors } = validateFile(fp, schema);
    if (errors.length === 0) {
      console.log(`✓ ${path.relative(ROOT, fp)}`);
    } else {
      bad++;
      console.log(`✗ ${path.relative(ROOT, fp)}`);
      for (const e of errors) console.log(`    ${e}`);
    }
  }
  console.log(`\n${files.length - bad}/${files.length} passed`);
  if (bad > 0) process.exit(1);
}

main();
