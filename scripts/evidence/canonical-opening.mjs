#!/opt/homebrew/bin/node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";

const GIT = "/usr/bin/git";
const MANIFEST_NAME = "OPENING-MANIFEST.sha256";
const DETACHED_SELF_HASH_NAME = `${MANIFEST_NAME}.sha256`;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const FORBIDDEN_TOP_LEVEL_PATHS = new Set(["auracore", "AuraCore"]);

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const required = [
    "--repo-root",
    "--expected-branch",
    "--expected-head",
    "--predecessor-inventory",
    "--output-evidence-root",
    "--expected-path-count",
    "--allowed-evidence-prefix",
  ];
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    if (!required.includes(name) || values.has(name) || index + 1 >= argv.length) {
      fail(`invalid argument: ${name ?? "<missing>"}`);
    }
    values.set(name, argv[index + 1]);
  }
  if (values.size !== required.length) {
    fail(`expected arguments: ${required.join(" ")}`);
  }
  return {
    repoRoot: path.resolve(values.get("--repo-root")),
    expectedBranch: values.get("--expected-branch"),
    expectedHead: values.get("--expected-head"),
    predecessorInventory: path.resolve(values.get("--predecessor-inventory")),
    outputEvidenceRoot: path.resolve(values.get("--output-evidence-root")),
    expectedPathCount: Number(values.get("--expected-path-count")),
    allowedEvidencePrefix: path.resolve(values.get("--allowed-evidence-prefix")),
  };
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeRelativePath(rawPath) {
  if (rawPath.includes("\\")) {
    fail(`path contains backslash: ${JSON.stringify(rawPath)}`);
  }
  if (path.posix.isAbsolute(rawPath) || rawPath.startsWith("/")) {
    fail(`absolute path is forbidden: ${JSON.stringify(rawPath)}`);
  }
  const normalized = path.posix.normalize(rawPath);
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    fail(`path escape is forbidden: ${JSON.stringify(rawPath)}`);
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail(`invalid path segments: ${JSON.stringify(rawPath)}`);
  }
  if (segments.some((segment) => segment.toLowerCase() === "auracore")) {
    fail(`AuraCore path is forbidden: ${JSON.stringify(rawPath)}`);
  }
  return normalized;
}

function parsePorcelain(buffer) {
  if (buffer.includes(0x0a)) {
    fail("porcelain -z output unexpectedly contains LF");
  }
  const tokens = [];
  let start = 0;
  while (start < buffer.length) {
    const nul = buffer.indexOf(0, start);
    if (nul < 0) {
      fail("porcelain -z output is not NUL terminated");
    }
    tokens.push(buffer.subarray(start, nul));
    start = nul + 1;
  }

  const records = [];
  for (let index = 0; index < tokens.length;) {
    const token = tokens[index++];
    if (token.length < 3 || token[2] !== 0x20) {
      fail("invalid porcelain status token");
    }
    const status = token.subarray(0, 2).toString("latin1");
    const source = token.subarray(3);
    if (!source.length) {
      fail("empty porcelain path");
    }
    if (status[0] === "R" || status[0] === "C") {
      const target = tokens[index++];
      if (target === undefined || !target.length) {
        fail(`missing rename/copy target: ${status}`);
      }
      records.push({ status, source, target });
      continue;
    }
    const validStatus = (code) =>
      code === "??" ||
      ([" ", "M", "A", "D", "R", "C", "T", "U"].includes(code[0]) &&
        [" ", "M", "A", "D", "R", "C", "T", "U"].includes(code[1]));
    if (!validStatus(status)) {
      fail(`invalid porcelain status: ${status}`);
    }
    records.push({ status, source, target: source });
  }
  return records;
}

function sourcePath(record) {
  return normalizeRelativePath(record.source.toString("utf8"));
}

function targetPath(record) {
  return normalizeRelativePath(record.target.toString("utf8"));
}

function semanticRecords(porcelainRecords) {
  const pathsByRecord = new Map();
  const rawRecords = [];
  for (const record of porcelainRecords) {
    const current = sourcePath(record);
    const old = targetPath(record);
    if (pathsByRecord.has(current) || (old !== current && pathsByRecord.has(old))) {
      fail(`duplicate status path: ${current}`);
    }
    pathsByRecord.set(current, record);
    if (old !== current) pathsByRecord.set(old, record);
    rawRecords.push({
      status: record.status,
      path: current,
      ...(old === current ? {} : { old }),
    });
  }
  return rawRecords;
}

function comparePaths(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function readInventory(inputPath) {
  const parsed = JSON.parse(readFileSync(inputPath, "utf8"));
  const records = Array.isArray(parsed) ? parsed : parsed?.records;
  if (!Array.isArray(records)) {
    fail("predecessor inventory must be an array or {records:[...]}");
  }
  const inventory = new Map();
  for (const record of records) {
    const rawDigest = typeof record === "string" ? record : record?.sha256;
    const rawPath = typeof record === "string" ? record : record?.path;
    if (typeof rawDigest !== "string" || rawDigest.length < 64 || !DIGEST_PATTERN.test(rawDigest.slice(0, 64))) {
      fail("invalid predecessor digest");
    }
    if (typeof rawPath !== "string" || rawPath.length <= 64) {
      fail("invalid predecessor digest record");
    }
    // Fixed-width digest parsing makes any whitespace run a delimiter.
    // A filename with leading whitespace cannot be expressed unambiguously in
    // this format; exploiting that ambiguity requires a SHA-256 collision, and
    // any true mismatch still fails closed through the path-set comparison.
    const relativePath = normalizeRelativePath(rawPath.slice(64).trimStart());
    if (inventory.has(relativePath)) {
      fail(`duplicate predecessor path: ${relativePath}`);
    }
    inventory.set(relativePath, rawDigest.slice(0, 64));
  }
  return inventory;
}

function resolveRepositoryPath(repoRoot, relativePath) {
  const absolute = path.resolve(repoRoot, relativePath);
  if (absolute !== repoRoot && !absolute.startsWith(`${repoRoot}${path.sep}`)) {
    fail(`repository path escape: ${relativePath}`);
  }
  return absolute;
}

function runGit(repoRoot, arguments_, label, encoding) {
  const result = spawnSync(GIT, arguments_, {
    cwd: repoRoot,
    encoding,
    env: { ...process.env, PATH: "", LC_ALL: "C" },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    fail(`${label} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`${label} exited ${result.status}: ${result.stderr?.toString("utf8")}`);
  }
  return result.stdout;
}

function fileStatusRecords(repoRoot) {
  return parsePorcelain(runGit(repoRoot, [
    "--no-optional-locks",
    "status",
    "--porcelain=v1",
    "-z",
    "-uall",
  ], "git status", "buffer"));
}


function assertRepoIdentity(repoRoot, expectedBranch, expectedHead) {
  const symbolic = spawnSync(GIT, ["symbolic-ref", "-q", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, PATH: "", LC_ALL: "C" },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (symbolic.status !== 0) {
    fail("detached HEAD is not a branch identity");
  }
  const actualBranch = symbolic.stdout.trim().replace(/^refs\/heads\//, "");
  const actualHead = runGit(repoRoot, ["rev-parse", "HEAD"], "HEAD resolution", "utf8").trim();
  if (actualBranch !== expectedBranch) fail(`branch mismatch: ${actualBranch}`);
  if (actualHead !== expectedHead) fail(`HEAD mismatch: ${actualHead}`);
  return { actualBranch, actualHead };
}

function assertRegularFile(repoRoot, relativePath) {
  const absolute = resolveRepositoryPath(repoRoot, relativePath);
  const metadata = lstatSync(absolute);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail(`non-regular repository file: ${relativePath}`);
  }
  statSync(absolute);
  return absolute;
}

function realPathExisting(target) {
  let cursor = target;
  for (;;) {
    if (existsSync(cursor)) {
      return path.join(realpathSync(cursor), target.slice(cursor.length));
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      return target;
    }
    cursor = parent;
  }
}

function assertOutputAuthority(outputRoot, allowedEvidencePrefix, repoRoot) {
  if (outputRoot !== allowedEvidencePrefix && !outputRoot.startsWith(`${allowedEvidencePrefix}${path.sep}`)) {
    fail("output evidence root is outside the allowed prefix");
  }
  const realOutput = realPathExisting(outputRoot);
  const realPrefix = realPathExisting(allowedEvidencePrefix);
  if (realOutput !== realPrefix && !realOutput.startsWith(`${realPrefix}${path.sep}`)) {
    fail("output evidence root escapes the allowed prefix through symlinks");
  }
  if (outputRoot === repoRoot || outputRoot.startsWith(`${repoRoot}${path.sep}`)) {
    fail("output evidence root must be outside the repository");
  }
}

function abortStaging(stagingRoot, error) {
  if (!existsSync(stagingRoot)) {
    throw error;
  }
  const abortedBase = `${stagingRoot}.ABORTED-${sha256(Buffer.from(String(error?.stack ?? error))).slice(0, 16)}`;
  let abortedRoot = abortedBase;
  for (let attempt = 0; existsSync(abortedRoot); attempt += 1) {
    abortedRoot = `${abortedBase}-${attempt}`;
  }
  renameSync(stagingRoot, abortedRoot);
  throw error;
}

function run(arguments_) {
  const config = parseArguments(arguments_);
  if (!Number.isInteger(config.expectedPathCount) || config.expectedPathCount < 0) {
    fail("expected path count must be a non-negative integer");
  }
  if (!statSync(config.repoRoot).isDirectory() || !existsSync(path.join(config.repoRoot, ".git"))) {
    fail("repo root is not a Git repository");
  }
  assertOutputAuthority(config.outputEvidenceRoot, config.allowedEvidencePrefix, config.repoRoot);
  if (existsSync(config.outputEvidenceRoot)) {
    fail(`final evidence root already exists: ${config.outputEvidenceRoot}`);
  }
  const parent = path.dirname(config.outputEvidenceRoot);
  const stagingRoot = path.join(parent, `.${path.basename(config.outputEvidenceRoot)}.staging-${sha256(Buffer.from(process.execPath + config.outputEvidenceRoot)).slice(0, 12)}`);
  if (existsSync(stagingRoot)) {
    fail(`staging evidence root already exists: ${stagingRoot}`);
  }
  mkdirSync(parent, { recursive: true });
  mkdirSync(stagingRoot, { recursive: true });

  try {
    const identity = assertRepoIdentity(config.repoRoot, config.expectedBranch, config.expectedHead);
    const porcelainRecords = fileStatusRecords(config.repoRoot);
    const rawRecords = semanticRecords(porcelainRecords);
    const currentInventory = new Map();
    for (const record of porcelainRecords) {
      const relativePath = sourcePath(record);
      if (record.status.includes("D")) {
        continue;
      }
      const absolute = assertRegularFile(config.repoRoot, relativePath);
      currentInventory.set(relativePath, sha256(readFileSync(absolute)));
    }
    const predecessorInventory = readInventory(config.predecessorInventory);
    const currentPaths = [...currentInventory.keys()].sort(comparePaths);
    const predecessorPaths = [...predecessorInventory.keys()].sort(comparePaths);
    if (currentPaths.length !== config.expectedPathCount) {
      fail(`path count mismatch: expected ${config.expectedPathCount}, actual ${currentPaths.length}`);
    }
    if (currentPaths.length !== predecessorPaths.length) {
      fail(`predecessor path count mismatch: expected ${predecessorPaths.length}, actual ${currentPaths.length}`);
    }
    const pathSetDrift = [];
    for (let index = 0; index < currentPaths.length; index += 1) {
      if (currentPaths[index] !== predecessorPaths[index]) {
        pathSetDrift.push({ current: currentPaths[index], predecessor: predecessorPaths[index] });
      }
    }
    const contentDigestDrift = [];
    for (const relativePath of currentPaths) {
      if (currentInventory.get(relativePath) !== predecessorInventory.get(relativePath)) {
        contentDigestDrift.push(relativePath);
      }
    }
    if (pathSetDrift.length !== 0 || contentDigestDrift.length !== 0) {
      fail(`semantic drift: path=${pathSetDrift.length}, content=${contentDigestDrift.length}`);
    }

    const outputs = {
      "opening-capture.json": canonicalJson({
        actualBranch: identity.actualBranch,
        actualHead: identity.actualHead,
        auraCoreAccessObserved: "NONE",
        expectedBranch: config.expectedBranch,
        expectedHead: config.expectedHead,
        repoMutation: "NONE",
        repositoryRoot: config.repoRoot,
      }),
      "expanded-inventory.json": canonicalJson({
        count: rawRecords.length,
        records: rawRecords,
      }),
      "opening-file-digests.json": canonicalJson({
        count: currentInventory.size,
        records: currentPaths.map((relativePath) => ({
          path: relativePath,
          sha256: currentInventory.get(relativePath),
        })),
      }),
      "semantic-reconciliation.json": canonicalJson({
        current: {
          contentDigestDriftCount: contentDigestDrift.length,
          pathSetDriftCount: pathSetDrift.length,
          uniquePathCount: currentPaths.length,
        },
        predecessor: {
          uniquePathCount: predecessorPaths.length,
        },
        semanticDigestMapEqual: true,
      }),
      "verification.json": canonicalJson({
        auracoreAccess: "NONE",
        contentDigestDrift: 0,
        count: currentInventory.size,
        gitExecutable: GIT,
        pathSetDrift: 0,
        repoMutation: "NONE",
        status: "PASS",
        uniquePathCount: currentPaths.length,
      }),
    };
    for (const [name, content] of Object.entries(outputs)) {
      writeFileSync(path.join(stagingRoot, name), content);
    }

    const manifestEntries = readdirSync(stagingRoot).sort(comparePaths)
      .filter((name) => name !== MANIFEST_NAME && name !== DETACHED_SELF_HASH_NAME)
      .map((name) => `${sha256(readFileSync(path.join(stagingRoot, name)))}  ${name}\n`);
    if (manifestEntries.some((entry) => entry.includes(MANIFEST_NAME))) {
      fail("manifest self-reference detected");
    }
    const manifest = Buffer.from(manifestEntries.join(""), "utf8");
    writeFileSync(path.join(stagingRoot, MANIFEST_NAME), manifest);
    writeFileSync(path.join(stagingRoot, DETACHED_SELF_HASH_NAME), `${sha256(manifest)}\n`);

    const finalVerification = JSON.parse(readFileSync(path.join(stagingRoot, "verification.json"), "utf8"));
    if (finalVerification.status !== "PASS") {
      fail("verification did not pass before publication");
    }
    renameSync(stagingRoot, config.outputEvidenceRoot);
    return {
      contentDigestDrift: 0,
      evidenceRoot: config.outputEvidenceRoot,
      manifestSelfHash: sha256(readFileSync(path.join(config.outputEvidenceRoot, MANIFEST_NAME))),
      pathSetDrift: 0,
      pathCount: currentPaths.length,
      status: "PASS",
    };
  } catch (error) {
    abortStaging(stagingRoot, error);
  }
}

if (process.argv[1] === import.meta.filename) {
  try {
    console.log(JSON.stringify(run(process.argv.slice(2)), null, 2));
  } catch (error) {
    console.error(error?.stack ?? String(error));
    process.exitCode = 1;
  }
}

export {
  canonicalJson,
  comparePaths,
  normalizeRelativePath,
  parseArguments,
   parsePorcelain,
   readInventory,
    semanticRecords,
   run,
  sha256,
};
