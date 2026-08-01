#!/usr/bin/env node
// generation-manifest.mjs
//
// Phase C2A: generation manifest writer + component path registry.
// Tracks material changes that reset adoption trust and resolves logical
// component IDs to actual repository paths.

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, openSync, closeSync, fsyncSync, renameSync, unlinkSync } from "node:fs";
import { join, dirname, resolve, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// From scripts/ai/autoloop/ → repo root: ../../../
const DEFAULT_MANIFEST_DIR = resolve(HERE, "..", "..", "..", "docs", "loop", "metadata");
const GENERATION_SCHEMA_VERSION = "1";
const CURRENT_GENERATION_POINTER = "current-generation.json";
let pointerTempSequence = 0;

const MATERIAL_CHANGE_PATTERNS = [
  { type: "runner_control_flow", patterns: ["run-card.mjs"] },
  { type: "reviewer_normalization", patterns: ["normalize-reviewer-json.mjs"] },
  { type: "executor_prompt", patterns: ["prompts/executor.md"] },
  { type: "reviewer_prompt", patterns: ["prompts/reviewer.md"] },
  { type: "model_family", patterns: [] },
  { type: "validation_policy", patterns: ["schema/card-input.schema.json"] },
  { type: "scope_matcher", patterns: ["run-card.mjs"] },
  { type: "authority_policy", patterns: [] },
  { type: "facts_schema", patterns: ["analyze-meta.mjs"] },
  { type: "candidate_derivation", patterns: [] },
];

const COMPONENT_REGISTRY = {
  "system:reviewer_prompt": "scripts/ai/autoloop/prompts/reviewer.md",
  "system:executor_prompt": "scripts/ai/autoloop/prompts/executor.md",
  "system:runner_execution": "scripts/ai/autoloop/run-card.mjs",
  "system:test_fixtures": "scripts/ai/autoloop/test/fixtures/",
  "system:analyzer_facts": "scripts/ai/autoloop/analyze-meta.mjs",
  "system:runner_orchestration": "scripts/ai/autoloop/run-card.mjs",
  "system:sidecar_persistence": "scripts/ai/autoloop/run-card.mjs",
  "governance:authority_boundary": "docs/loop/self-improvement-candidate-derivation.md",
  "governance:policy_definition": "docs/loop/self-improvement-candidate-derivation.md",
  "system:unknown": null,  // explicitly unresolved → PROPOSAL_ONLY
};

function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 15000 });
  return r.status === 0 ? (r.stdout || "").trim() : null;
}

export function detectMaterialChanges(baselineCommit, currentCommit, cwd) {
  if (!baselineCommit || !currentCommit) return [];
  const diff = git(["diff", "--name-only", `${baselineCommit}..${currentCommit}`], cwd);
  if (!diff) return [];
  const changedFiles = diff.split("\n").filter(Boolean);
  const changes = [];
  for (const entry of MATERIAL_CHANGE_PATTERNS) {
    const matched = entry.patterns.some((p) => changedFiles.some((f) => f.includes(p)));
    if (matched) changes.push(entry.type);
  }
  return changes;
}

export function generateManifestId({
  generationSchemaVersion = GENERATION_SCHEMA_VERSION,
  previousGenerationId = null,
  materialBoundaryCommit,
  materialChangeTypes = [],
} = {}) {
  const payload = JSON.stringify({
    generation_schema_version: generationSchemaVersion,
    previous_generation_id: previousGenerationId,
    material_boundary_commit: materialBoundaryCommit || null,
    material_change_types: [...new Set(materialChangeTypes)].sort(),
  });
  return `gen-${createHash("sha256").update(payload).digest("hex").slice(0, 16)}`;
}

export function resolveComponentId(componentId, manifest) {
  if (manifest?.component_path_registry?.[componentId]) {
    return manifest.component_path_registry[componentId];
  }
  if (COMPONENT_REGISTRY[componentId]) {
    return COMPONENT_REGISTRY[componentId];
  }
  return null;
}

function generationManifestFiles(manifestDir) {
  if (!existsSync(manifestDir)) return [];
  return readdirSync(manifestDir).filter((file) =>
    file.startsWith("generation-") && file.endsWith(".json"));
}

function isCanonicalGenerationId(value) {
  return typeof value === "string" && /^gen-[0-9a-f]{16}$/.test(value);
}

function validateGenerationContract(record, label) {
  if (!record || record.generation_schema_version !== GENERATION_SCHEMA_VERSION) {
    throw new Error(`generation state unresolved: ${label} has unsupported generation schema version`);
  }
  if (!isCanonicalGenerationId(record.generation_id)) {
    throw new Error(`generation state unresolved: ${label} has malformed generation_id`);
  }
  if (record.previous_generation_id !== null && !isCanonicalGenerationId(record.previous_generation_id)) {
    throw new Error(`generation state unresolved: ${label} has malformed previous_generation_id`);
  }
  if (record.previous_generation_id === record.generation_id) {
    throw new Error(`generation state unresolved: ${label} has self-referential lineage`);
  }
}

function readCurrentGeneration(manifestDir) {
  const pointerPath = join(manifestDir, CURRENT_GENERATION_POINTER);
  const manifestFiles = generationManifestFiles(manifestDir);
  if (!existsSync(pointerPath)) {
    if (manifestFiles.length === 0) return null;
    throw new Error("generation state unresolved: current-generation.json is missing");
  }

  let pointer;
  try {
    pointer = JSON.parse(readFileSync(pointerPath, "utf8"));
  } catch {
    throw new Error("generation state unresolved: current-generation.json is malformed");
  }

  if (!pointer || typeof pointer.generation_id !== "string" ||
      typeof pointer.latest_manifest !== "string" ||
      typeof pointer.latest_head_commit !== "string" ||
      basename(pointer.latest_manifest) !== pointer.latest_manifest) {
    throw new Error("generation state unresolved: current-generation.json is invalid");
  }
  validateGenerationContract(pointer, "current-generation.json");

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(manifestDir, pointer.latest_manifest), "utf8"));
  } catch {
    throw new Error("generation state unresolved: pointed manifest cannot be read");
  }
  validateGenerationContract(manifest, "pointed manifest");

  if (manifest.generation_id !== pointer.generation_id ||
      manifest.head_commit !== pointer.latest_head_commit ||
      manifest.previous_generation_id !== (pointer.previous_generation_id || null) ||
      manifest.material_boundary_commit !== pointer.material_boundary_commit) {
    throw new Error("generation state unresolved: pointer and manifest disagree");
  }
  return { pointer, manifest };
}

export function findPreviousManifestId(manifestDir) {
  const current = readCurrentGeneration(manifestDir);
  return current?.pointer.generation_id || null;
}

function replaceCurrentGenerationPointer(dir, pointer, { renamePointer = renameSync } = {}) {
  const pointerPath = join(dir, CURRENT_GENERATION_POINTER);
  const tempPath = join(dir, `${CURRENT_GENERATION_POINTER}.tmp-${process.pid}-${Date.now()}-${pointerTempSequence++}`);
  let descriptor = null;
  try {
    descriptor = openSync(tempPath, "wx", 0o600);
    writeFileSync(descriptor, JSON.stringify(pointer, null, 2), "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renamePointer(tempPath, pointerPath);
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    if (existsSync(tempPath)) unlinkSync(tempPath);
    throw error;
  }
}

export function writeGenerationManifest(manifestDir, baselineCommit, cwd, options) {
  const head = git(["rev-parse", "HEAD"], cwd);
  if (!head) throw new Error("cannot resolve HEAD");
  const dir = manifestDir || DEFAULT_MANIFEST_DIR;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const current = readCurrentGeneration(dir);
  if (current?.pointer.latest_head_commit === head) return current.manifest;

  const changeBoundary = current?.pointer.latest_head_commit || baselineCommit;
  const materialChanges = detectMaterialChanges(changeBoundary, head, cwd).sort();
  const isInitialGeneration = !current;
  const isMaterialGeneration = isInitialGeneration || materialChanges.length > 0;
  const previousGenerationId = isMaterialGeneration
    ? (current?.pointer.generation_id || null)
    : (current.pointer.previous_generation_id || null);
  const materialBoundaryCommit = isMaterialGeneration
    ? (isInitialGeneration ? (baselineCommit || head) : head)
    : current.pointer.material_boundary_commit;
  const generationId = isMaterialGeneration
    ? generateManifestId({
      previousGenerationId,
      materialBoundaryCommit,
      materialChangeTypes: materialChanges,
    })
    : current.pointer.generation_id;

  if (previousGenerationId === generationId) {
    throw new Error("generation state unresolved: self-referential lineage");
  }

  const manifest = {
    generation_schema_version: GENERATION_SCHEMA_VERSION,
    generation_id: generationId,
    baseline_commit: baselineCommit,
    head_commit: head,
    material_change_types: materialChanges,
    created_at: new Date().toISOString(),
    previous_generation_id: previousGenerationId,
    material_boundary_commit: materialBoundaryCommit,
    component_path_registry: { ...COMPONENT_REGISTRY },
  };

  const filename = `generation-${head}.json`;
  const path = join(dir, filename);
  writeFileSync(path, JSON.stringify(manifest, null, 2), "utf8");
  const pointer = {
    generation_schema_version: GENERATION_SCHEMA_VERSION,
    generation_id: generationId,
    previous_generation_id: previousGenerationId,
    material_boundary_commit: materialBoundaryCommit,
    latest_manifest: filename,
    latest_head_commit: head,
  };
  replaceCurrentGenerationPointer(dir, pointer, options);
  return manifest;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("Usage: generation-manifest.mjs <write|resolve> [options]");
    process.exit(2);
  }

  const command = args[0];

  if (command === "write") {
    const baselineIdx = args.indexOf("--baseline");
    const baselineCommit = baselineIdx >= 0 ? args[baselineIdx + 1] : git(["rev-parse", "HEAD~1"], process.cwd());
    const manifestDirIdx = args.indexOf("--manifest-dir");
    const manifestDir = manifestDirIdx >= 0 ? resolve(args[manifestDirIdx + 1]) : DEFAULT_MANIFEST_DIR;
    try {
      const m = writeGenerationManifest(manifestDir, baselineCommit, process.cwd());
      console.log(JSON.stringify(m, null, 2));
    } catch (e) {
      console.error(`[generation-manifest] ERROR: ${e.message}`);
      process.exit(1);
    }
  } else if (command === "resolve") {
    const componentId = args[1];
    if (!componentId) {
      console.error("Usage: generation-manifest.mjs resolve <component_id> [--manifest-path <path>]");
      process.exit(2);
    }
    const pathIdx = args.indexOf("--manifest-path");
    let manifest = null;
    if (pathIdx >= 0) {
      try {
        manifest = JSON.parse(readFileSync(resolve(args[pathIdx + 1]), "utf8"));
      } catch {
        console.error(`[generation-manifest] cannot read manifest: ${args[pathIdx + 1]}`);
        process.exit(1);
      }
    }
    const resolved = resolveComponentId(componentId, manifest);
    if (resolved) {
      console.log(resolved);
    } else {
      console.error(`[generation-manifest] unresolved component: ${componentId}`);
      process.exit(1);
    }
  } else {
    console.error(`Unknown command: ${command}`);
    process.exit(2);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
