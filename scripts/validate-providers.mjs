#!/usr/bin/env node
// Validates every provider JSON in providers/ against providers/schema.json,
// and checks index.json consistency in both directions.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const providersDir = path.resolve(__dirname, "..", "providers");
const schemaPath = path.join(providersDir, "schema.json");
const indexPath = path.join(providersDir, "index.json");

// Files in providers/ that are not themselves providers.
const NON_PROVIDER = new Set(["index.json", "schema.json"]);

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function formatAjvError(err) {
  const where = err.instancePath || "(root)";
  let detail = "";
  if (err.keyword === "additionalProperties") {
    detail = ` (unknown property "${err.params.additionalProperty}")`;
  } else if (err.keyword === "enum") {
    detail = ` (allowed: ${err.params.allowedValues.join(", ")})`;
  } else if (err.keyword === "const") {
    detail = ` (must be ${JSON.stringify(err.params.allowedValue)})`;
  } else if (err.keyword === "required") {
    detail = ` ("${err.params.missingProperty}")`;
  }
  return `  ${where} ${err.message}${detail}`;
}

const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(readJson(schemaPath));

const files = readdirSync(providersDir)
  .filter((f) => f.endsWith(".json") && !NON_PROVIDER.has(f))
  .sort();

let validCount = 0;
const fileIds = [];
let hadFileError = false;

for (const file of files) {
  const rel = `providers/${file}`;
  const fileErrors = [];
  let data;

  try {
    data = readJson(path.join(providersDir, file));
  } catch (e) {
    console.log(`✗ ${rel}`);
    console.log(`  invalid JSON — ${e.message}`);
    hadFileError = true;
    continue;
  }

  const expectedId = path.basename(file, ".json");
  if (data.id !== expectedId) {
    fileErrors.push(`  id "${data.id}" does not match filename (expected "${expectedId}")`);
  }
  fileIds.push(data.id);

  if (!validate(data)) {
    for (const err of validate.errors) fileErrors.push(formatAjvError(err));
  }

  if (fileErrors.length === 0) {
    validCount++;
    console.log(`✓ ${rel}`);
  } else {
    hadFileError = true;
    console.log(`✗ ${rel}`);
    for (const line of fileErrors) console.log(line);
  }
}

// --- index.json consistency (both directions) ---
const indexErrors = [];
let index;
try {
  index = readJson(indexPath);
} catch (e) {
  indexErrors.push(`invalid JSON — ${e.message}`);
}

if (index !== undefined && !Array.isArray(index)) {
  indexErrors.push("index.json must be a JSON array of provider ids");
} else if (Array.isArray(index)) {
  const fileIdSet = new Set(fileIds);

  const seen = new Set();
  for (const id of index) {
    if (seen.has(id)) indexErrors.push(`"${id}" is listed more than once`);
    seen.add(id);
    if (!fileIdSet.has(id)) {
      indexErrors.push(`"${id}" is listed but providers/${id}.json is missing (or its id differs)`);
    }
  }

  for (const id of fileIds) {
    const count = index.filter((x) => x === id).length;
    if (count === 0) indexErrors.push(`provider "${id}" is not listed in index.json`);
  }
}

console.log("");
if (indexErrors.length) {
  console.log("index.json consistency errors:");
  for (const e of indexErrors) console.log(`  ${e}`);
  console.log("");
}

console.log(`${validCount}/${files.length} providers valid`);

if (hadFileError || indexErrors.length) {
  console.log("VALIDATION FAILED");
  process.exit(1);
}
console.log("VALIDATION PASSED");
