// src/admission/search-scope-governor.mjs
//
// RB-SSG — SEARCH-SCOPE / RECURSIVE-TRAVERSAL GOVERNOR
//
// Root-cause class repaired here: SEARCH_SCOPE_EXPANSION /
// UNBOUNDED_RECURSIVE_TRAVERSAL (not "grep specifically").
//
// ── INCIDENT RECORD (preserved evidence) ────────────────────────────────
// 1. `find /Users/zhengfengqing -name "*gov-closeout-bundle*"` traversed
//    HOME and ran ~738.7s (NO_PROGRESS).
// 2. The agent incorrectly described filename filtering as making the search
//    "bounded".
// 3. After that NO_PROGRESS event, another materially equivalent HOME-wide
//    `find` was attempted.
// 4. Recursive `grep -rls` was also used over broad Desktop/repo roots.
// 5. Root-cause class: SEARCH_SCOPE_EXPANSION / UNBOUNDED_RECURSIVE_TRAVERSAL,
//    not grep specifically.
//
// ── INVARIANTS ENFORCED (mechanical) ─────────────────────────────────────
// A. Traversal boundary — a recursive search is bounded ONLY by traversal
//    scope, never by result filtering. `-name` / regex / query / `| head` /
//    output limits are NOT boundaries. maxdepth, prune, exclusions,
//    tracked/indexed lookup, an explicit subtree allowlist, or an exact path
//    ARE boundaries.
// B. Forbidden roots — recursive traversal may not start at $HOME, a user
//    home dir, Desktop-as-a-whole, the filesystem root, or a multi-user /
//    repo-collection parent, unless explicitly authorized via allowlist or
//    declaration.
// C. Default exclusions — recursive discovery must exclude .git,
//    node_modules, target, build/dist/output, cache, tmp, databases, and
//    generated artifacts where applicable.
// D. Escalation — authoritative exact location → tracked/indexed files →
//    known card/artifact subtree → REPLAN → HOLD. Never auto-widen to HOME.
// E. Failed-strategy fingerprint — equivalence is keyed on (normalized
//    traversal root(s) × recursive mode × discovery intent). Changing the
//    filename, the pattern, or the tool (find → rg → grep) does NOT reset a
//    materially overlapping strategy.
// F. NO_PROGRESS enforcement — a timeout / interruption / excessive runtime /
//    prolonged lack of useful progress marks the strategy FAILED; a second
//    materially equivalent attempt must be rejected.
// G. Pre-execution declaration — a recursive search requires
//    SEARCH ROOT / WHY THIS ROOT IS AUTHORITATIVE / BOUNDARY-OR-EXCLUSIONS.
//
// This module is PURE and DETERMINISTIC: it performs no filesystem traversal
// of its own, no network access, and no side effects other than the injectable
// failed-strategy registry. Paths are only resolved/normalized, never walked.

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";

export const SEARCH_GOVERNOR_SCHEMA = "autoloop.search-scope-governor/v1";

// ── Invariant C: default exclusions (generated / transient trees) ───────
export const DEFAULT_EXCLUSIONS = Object.freeze([
  ".git", "node_modules", "target", "dist", "build", "out", "coverage",
  ".cache", "cache", "tmp", ".tmp", ".next", ".turbo", "venv", ".venv",
  "__pycache__", ".gradle", "databases", ".yarn", ".pnpm-store",
]);

// ── Invariant B: forbidden-root classification ──────────────────────────
export const ROOT_KINDS = Object.freeze({
  BOUNDED: "BOUNDED",
  HOME: "HOME",
  DESKTOP: "DESKTOP",
  USER_DIR: "USER_DIR",
  FILESYSTEM_ROOT: "FILESYSTEM_ROOT",
});

export const SEARCH_HOLDS = Object.freeze({
  UNBOUNDED_HOME_TRAVERSAL: "UNBOUNDED_HOME_TRAVERSAL",
  UNBOUNDED_DESKTOP_TRAVERSAL: "UNBOUNDED_DESKTOP_TRAVERSAL",
  UNBOUNDED_USER_DIR_TRAVERSAL: "UNBOUNDED_USER_DIR_TRAVERSAL",
  UNBOUNDED_FILESYSTEM_ROOT: "UNBOUNDED_FILESYSTEM_ROOT",
  REPEATED_FAILED_SEARCH_STRATEGY: "REPEATED_FAILED_SEARCH_STRATEGY",
  MISSING_SEARCH_DECLARATION: "MISSING_SEARCH_DECLARATION",
  UNBOUNDED_RECURSIVE_TRAVERSAL: "UNBOUNDED_RECURSIVE_TRAVERSAL",
});

/** Tracked/indexed lookup families — bounded to the git index by construction. */
export const TRACKED_INDEXED_FAMILIES = Object.freeze([
  "git-grep",
  "git-ls-files",
  "git-log",
]);

const canonicalJson = (value) => {
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]));
    }
    return v;
  };
  return JSON.stringify(sort(value));
};

export const sha256Hex = (text) =>
  createHash("sha256").update(String(text)).digest("hex");

// ── Path normalization ───────────────────────────────────────────────────

/**
 * Normalize a path for scope comparison: expand ~ / $HOME, resolve relative
 * paths against cwd, collapse "." / "..", strip trailing separators.
 * Returns null for empty input. Never touches the filesystem.
 */
export function normalizeSearchPath(p, { cwd = process.cwd(), home = homedir() } = {}) {
  let s = String(p ?? "").trim();
  if (s === "") return null;
  if (s === "~") s = home;
  else if (s.startsWith("~/")) s = join(home, s.slice(2));
  else if (s === "$HOME" || s === "${HOME}") s = home;
  else if (s.startsWith("$HOME/")) s = join(home, s.slice(6));
  else if (s.startsWith("${HOME}/")) s = join(home, s.slice(8));
  const abs = isAbsolute(s) ? s : resolve(cwd, s);
  const n = normalize(abs);
  const stripped = n.length > 1 ? n.replace(/\/+$/, "") : n;
  return stripped || sep;
}

/**
 * Classify a traversal root against the forbidden-root invariants (B).
 * Pure — no filesystem access.
 */
export function classifySearchRoot(root, { home = homedir() } = {}) {
  const h = normalizeSearchPath(home, { home });
  const parent = dirname(h); // e.g. /Users (or /home)
  const desktop = join(h, "Desktop");
  const raw = String(root ?? "").trim();
  if (raw === "") return { kind: ROOT_KINDS.BOUNDED, forbidden: false, holdCode: null, reason: "empty root" };
  const n = normalizeSearchPath(raw, { home });

  if (n === sep) {
    return { kind: ROOT_KINDS.FILESYSTEM_ROOT, forbidden: true, holdCode: SEARCH_HOLDS.UNBOUNDED_FILESYSTEM_ROOT, reason: "filesystem root" };
  }
  if (n === parent) {
    return { kind: ROOT_KINDS.USER_DIR, forbidden: true, holdCode: SEARCH_HOLDS.UNBOUNDED_USER_DIR_TRAVERSAL, reason: `multi-user / repo-collection parent ${parent}` };
  }
  if (n === h) {
    return { kind: ROOT_KINDS.HOME, forbidden: true, holdCode: SEARCH_HOLDS.UNBOUNDED_HOME_TRAVERSAL, reason: "home directory" };
  }
  if (n === desktop || n.startsWith(desktop + "/")) {
    return { kind: ROOT_KINDS.DESKTOP, forbidden: true, holdCode: SEARCH_HOLDS.UNBOUNDED_DESKTOP_TRAVERSAL, reason: "Desktop traversal" };
  }
  // Any direct child of the multi-user parent is a user home dir; a
  // <home>/Desktop/<…> subtree is a Desktop traversal (both forbidden as
  // roots — a specific authoritative subtree must be allowlisted/declared).
  if (n.startsWith(parent + "/")) {
    const rest = n.slice(parent.length + 1);
    const segs = rest.split("/");
    if (segs.length === 1) {
      return { kind: ROOT_KINDS.HOME, forbidden: true, holdCode: SEARCH_HOLDS.UNBOUNDED_HOME_TRAVERSAL, reason: `user home directory ${n}` };
    }
    if (segs[1] === "Desktop") {
      return { kind: ROOT_KINDS.DESKTOP, forbidden: true, holdCode: SEARCH_HOLDS.UNBOUNDED_DESKTOP_TRAVERSAL, reason: `Desktop traversal ${n}` };
    }
  }
  return { kind: ROOT_KINDS.BOUNDED, forbidden: false, holdCode: null, reason: "not a forbidden root" };
}

// ── Shell tokenization (quotes + pipeline separators) ───────────────────

function splitShellSegments(command) {
  const segs = [];
  let cur = "";
  let inS = false;
  let inD = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (inS) {
      cur += ch;
      if (ch === "'") inS = false;
      continue;
    }
    if (inD) {
      cur += ch;
      if (ch === '"') inD = false;
      continue;
    }
    if (ch === "'") { inS = true; cur += ch; continue; }
    if (ch === '"') { inD = true; cur += ch; continue; }
    if (ch === "|" || ch === ";" || ch === "&" || ch === "\n") {
      segs.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  segs.push(cur);
  return segs.map((s) => s.trim()).filter(Boolean);
}

/**
 * Extract commands embedded in $( ... ) command substitutions and `...`
 * backtick substitutions, so a search command hidden inside a shell
 * assignment (`FILES=$(find /src/docs ...)`) is still governed. Quotes are
 * respected; nesting depth is tracked for $( ... ).
 */
function extractSubcommands(command) {
  const out = [];
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (ch === "$" && command[i + 1] === "(") {
      let depth = 1;
      let j = i + 2;
      let inS = false;
      let inD = false;
      let inner = "";
      while (j < command.length && depth > 0) {
        const c = command[j];
        if (inS) {
          inner += c;
          if (c === "'") inS = false;
          j++;
          continue;
        }
        if (inD) {
          inner += c;
          if (c === '"') inD = false;
          j++;
          continue;
        }
        if (c === "'") { inS = true; inner += c; j++; continue; }
        if (c === '"') { inD = true; inner += c; j++; continue; }
        if (c === "(") depth++;
        else if (c === ")") {
          depth--;
          if (depth === 0) { j++; break; }
        }
        inner += c;
        j++;
      }
      if (inner.trim()) out.push(inner);
      i = j;
      continue;
    }
    if (ch === "`") {
      let j = i + 1;
      let inner = "";
      while (j < command.length && command[j] !== "`") {
        inner += command[j];
        j++;
      }
      if (inner.trim()) out.push(inner);
      i = j + 1;
      continue;
    }
    i++;
  }
  return out;
}

function tokenize(segment) {
  const toks = [];
  let cur = "";
  let inS = false;
  let inD = false;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (inS) {
      if (ch === "'") inS = false;
      else cur += ch;
      continue;
    }
    if (inD) {
      if (ch === '"') inD = false;
      else cur += ch;
      continue;
    }
    if (ch === "'") { inS = true; continue; }
    if (ch === '"') { inD = true; continue; }
    if (ch === " " || ch === "\t") {
      if (cur) { toks.push(cur); cur = ""; }
      continue;
    }
    cur += ch;
  }
  if (cur) toks.push(cur);
  return toks;
}

const programBase = (prog) => String(prog ?? "").split("/").pop().replace(/\.exe$/i, "");

// Shell redirections must never leak into root/pattern extraction.
// `2>/dev/null`, `>out`, `<in`, `2>&1` are operators, not traversal roots.
const isRedirection = (t) => /^(?:[0-9]*[<>]+|&>)/.test(t);
const isBareRedirect = (t) => /^(?:[0-9]*[<>]+|&>)$/.test(t);
const skipRedirect = (tokens, i) => {
  if (isBareRedirect(tokens[i])) return i + 2; // operator + separate target
  return i + 1; // operator glued to target (2>/dev/null)
};

const matchesExclusion = (value) => {
  const v = String(value ?? "").toLowerCase();
  return DEFAULT_EXCLUSIONS.some((e) => v.includes(e.toLowerCase()));
};

// ── Command family detection + parsing ──────────────────────────────────

/**
 * Parse a single shell command (one pipeline segment) into a search-command
 * descriptor. Recognized families: find, rg/ripgrep, grep/egrep/fgrep,
 * git grep / git ls-files / git log. Everything else is `other` (not a
 * search command) and is ignored by the governor.
 */
export function parseSearchCommand(command, { cwd = process.cwd(), home = homedir() } = {}) {
  const tokens = tokenize(String(command ?? "").trim());
  if (tokens.length === 0) {
    return { recognized: false, family: "other", raw: String(command ?? "") };
  }
  const base = programBase(tokens[0]);

  if (base === "find") {
    return parseFind(tokens, { cwd, home });
  }
  if (base === "rg" || base === "ripgrep") {
    return parseRg(tokens, { cwd, home });
  }
  if (base === "grep" || base === "egrep" || base === "fgrep") {
    return parseGrep(tokens, { cwd, home });
  }
  if (base === "git") {
    const sub = tokens[1];
    if (sub === "grep") return { recognized: true, family: "git-grep", recursive: true, roots: [], boundaries: [{ kind: "tracked-indexed", detail: "git grep" }], pattern: tokens.slice(2).join(" "), exact: false, raw: String(command) };
    if (sub === "ls-files") return { recognized: true, family: "git-ls-files", recursive: true, roots: [], boundaries: [{ kind: "tracked-indexed", detail: "git ls-files" }], pattern: null, exact: false, raw: String(command) };
    if (sub === "log") return { recognized: true, family: "git-log", recursive: true, roots: [], boundaries: [{ kind: "tracked-indexed", detail: "git log" }], pattern: tokens.slice(2).join(" "), exact: false, raw: String(command) };
    return { recognized: false, family: "git", raw: String(command) };
  }
  return { recognized: false, family: "other", raw: String(command) };
}

function parseFind(tokens, { cwd, home }) {
  let i = 1;
  // Skip leading mode flags (-H -L -P -D).
  while (i < tokens.length && /^-[HLPD]$/.test(tokens[i])) i++;
  const roots = [];
  while (i < tokens.length && !tokens[i].startsWith("-") && !["!", "(", ")"].includes(tokens[i])) {
    if (isRedirection(tokens[i])) {
      i = skipRedirect(tokens, i);
      continue;
    }
    roots.push(tokens[i]);
    i++;
  }
  const boundaries = [];
  let maxdepth = null;
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "-maxdepth" || t === "-mindepth") {
      maxdepth = tokens[i + 1];
      boundaries.push({ kind: "maxdepth", detail: `${t} ${tokens[i + 1] ?? ""}` });
      i++;
    } else if (t === "-prune") {
      boundaries.push({ kind: "prune", detail: "-prune" });
    } else if (t === "-not" || t === "!") {
      const nt = tokens[i + 1];
      const val = tokens[i + 2];
      if ((nt === "-path" || nt === "-name" || nt === "-wholename" || nt === "-regex") && val && matchesExclusion(val)) {
        boundaries.push({ kind: "exclusion", detail: val });
      }
    } else if ((t === "-path" || t === "-name" || t === "-wholename" || t === "-regex") && tokens[i - 1] === "-prune" && tokens[i + 1] && matchesExclusion(tokens[i + 1])) {
      boundaries.push({ kind: "exclusion", detail: tokens[i + 1] });
    }
  }
  const normRoots = (roots.length ? roots : ["."]).map((r) => normalizeSearchPath(r, { cwd, home })).filter(Boolean);
  const recursive = maxdepth !== "0"; // -maxdepth 0 => the root itself only (exact)
  return {
    recognized: true,
    family: "find",
    recursive,
    roots: normRoots,
    boundaries,
    pattern: tokens.filter((t) => t.startsWith("-name") || t.startsWith("-iname") || t.startsWith("-regex")).join(" ") || null,
    exact: !recursive,
    raw: tokens.join(" "),
  };
}

// ripgrep long options that consume the NEXT token as a value.
const RG_VALUE_OPTIONS = new Set([
  "--type", "--type-add", "--type-clear", "--max-count", "--max-columns",
  "--max-columns-preview", "--max-filesize", "--min-filesize", "--context",
  "--sort", "--sortr", "--colors", "--replace", "--file", "--files",
  "--regexp", "--glob", "--pre", "--pre-glob", "--encoding", "--messages",
  "--field-context-separator", "--field-match-separator",
]);

function parseRg(tokens, { cwd, home }) {
  const positional = [];
  const boundaries = [];
  let i = 1;
  let afterDashDash = false;
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (!afterDashDash && t === "--") { afterDashDash = true; continue; }
    if (!afterDashDash && t.startsWith("--")) {
      const eq = t.indexOf("=");
      const key = eq >= 0 ? t.slice(0, eq) : t;
      const inline = eq >= 0 ? t.slice(eq + 1) : null;
      if (key === "--max-depth" || key === "--maxdepth") {
        boundaries.push({ kind: "maxdepth", detail: inline ?? tokens[i + 1] ?? "" });
        if (inline === null) i++;
      } else if (key === "--exclude" || key === "--exclude-dir" || key === "--exclude-from") {
        boundaries.push({ kind: "exclusion", detail: inline ?? tokens[i + 1] ?? "" });
        if (inline === null) i++;
      } else if (key === "--glob") {
        const v = inline ?? tokens[i + 1];
        if (v && String(v).startsWith("!")) boundaries.push({ kind: "exclusion", detail: v });
        if (inline === null) i++;
      } else if (RG_VALUE_OPTIONS.has(key) && inline === null) {
        i++;
      }
      continue;
    }
    if (!afterDashDash && t.startsWith("-") && t.length > 1) {
      // Short option cluster. -g/-m/-A/-B/-C/-t/-e/-f consume a value.
      if (t === "-g") {
        const v = tokens[i + 1];
        if (v && String(v).startsWith("!")) boundaries.push({ kind: "exclusion", detail: v });
        i++;
      } else if (["-m", "-A", "-B", "-C", "-t", "-e", "-f"].includes(t)) {
        i++;
      }
      continue;
    }
    if (isRedirection(t)) {
      i = skipRedirect(tokens, i) - 1;
      continue;
    }
    positional.push(t);
  }
  const pattern = positional[0] ?? null;
  const pathArgs = positional.slice(1);
  const normRoots = (pathArgs.length ? pathArgs : ["."]).map((r) => normalizeSearchPath(r, { cwd, home })).filter(Boolean);
  return {
    recognized: true,
    family: "rg",
    recursive: true, // ripgrep recurses by default
    roots: normRoots,
    boundaries,
    pattern,
    exact: false,
    raw: tokens.join(" "),
  };
}

function parseGrep(tokens, { cwd, home }) {
  const positional = [];
  const boundaries = [];
  let recursive = false;
  let afterDashDash = false;
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (!afterDashDash && t === "--") { afterDashDash = true; continue; }
    if (!afterDashDash && t.startsWith("--")) {
      const eq = t.indexOf("=");
      const key = eq >= 0 ? t.slice(0, eq) : t;
      const inline = eq >= 0 ? t.slice(eq + 1) : null;
      if (key === "--recursive") recursive = true;
      else if (key === "--exclude" || key === "--exclude-dir") {
        boundaries.push({ kind: "exclusion", detail: inline ?? tokens[i + 1] ?? "" });
        if (inline === null) i++;
      } else if (key === "--include" || key === "--exclude-from" || key === "--max-count" || key === "--label") {
        if (inline === null) i++;
      }
      continue;
    }
    if (!afterDashDash && t.startsWith("-") && t.length > 1) {
      // Combined short flags: -r, -R, -rl, -riR, -rls all imply recursive.
      if (/[rR]/.test(t.slice(1))) recursive = true;
      continue;
    }
    if (isRedirection(t)) {
      i = skipRedirect(tokens, i) - 1;
      continue;
    }
    positional.push(t);
  }
  const pattern = positional[0] ?? null;
  const fileArgs = positional.slice(1);
  const normRoots = (recursive ? (fileArgs.length ? fileArgs : ["."]) : fileArgs)
    .map((r) => normalizeSearchPath(r, { cwd, home }))
    .filter(Boolean);
  return {
    recognized: true,
    family: "grep",
    recursive,
    roots: normRoots,
    boundaries,
    pattern,
    exact: !recursive,
    raw: tokens.join(" "),
  };
}

// ── Strategy fingerprint (invariant E) ──────────────────────────────────

/**
 * Tool-agnostic equivalence key. The fingerprint is keyed on the normalized
 * traversal root(s) × recursive mode × discovery intent ONLY — the tool
 * family (find/rg/grep) and the concrete filename/pattern are deliberately
 * excluded so that "find foo" → "rg bar" over the same root still collides.
 */
export function strategyFingerprint(parsedOrRoots, { cwd = process.cwd(), home = homedir(), intent = null } = {}) {
  let roots;
  let recursive;
  if (Array.isArray(parsedOrRoots)) {
    roots = parsedOrRoots;
    recursive = arguments[1]?.recursive === true;
  } else if (parsedOrRoots && typeof parsedOrRoots === "object") {
    roots = parsedOrRoots.roots ?? [];
    recursive = parsedOrRoots.recursive === true;
  } else {
    roots = [];
    recursive = false;
  }
  const norm = [...new Set((roots ?? []).map((r) => normalizeSearchPath(r, { cwd, home })).filter(Boolean))].sort();
  const payload = { roots: norm, recursive };
  if (intent) payload.intent = String(intent);
  return sha256Hex(canonicalJson(payload));
}

// ── Failed-strategy registry (invariant F) ──────────────────────────────

/**
 * Injectable in-memory registry of FAILED strategies. A strategy is recorded
 * when it is rejected (unbounded) or explicitly marked no-progress / timeout.
 * `isFailed` compares tool-agnostic fingerprints, so a materially equivalent
 * re-attempt (different filename, different tool) is still recognized.
 */
export function createFailedStrategyRegistry() {
  const failed = new Map();
  return {
    recordFailure(fingerprint, meta = {}) {
      if (!fingerprint) return false;
      failed.set(String(fingerprint), {
        reason: meta.reason ?? null,
        toolFamily: meta.toolFamily ?? null,
        recordedAt: meta.recordedAt ?? new Date().toISOString(),
      });
      return true;
    },
    isFailed(fingerprint) {
      return !!fingerprint && failed.has(String(fingerprint));
    },
    entries() {
      return [...failed.entries()].map(([fingerprint, m]) => ({ fingerprint, ...m }));
    },
    reset() {
      failed.clear();
    },
    get size() {
      return failed.size;
    },
  };
}

// ── Boundary / allowlist / declaration helpers ──────────────────────────

const isUnderAllowlist = (root, allowlist, { cwd, home }) => {
  const n = normalizeSearchPath(root, { cwd, home });
  if (!n) return false;
  for (const a of allowlist ?? []) {
    const an = normalizeSearchPath(a, { cwd, home });
    if (!an || an === sep) continue; // "/" grants nothing (equivalent to no boundary)
    if (n === an || n.startsWith(an + "/")) return true;
  }
  return false;
};

/**
 * Validate a pre-execution declaration (invariant G). The declaration must
 * name the SEARCH ROOT, justify WHY it is authoritative, and carry a
 * BOUNDARY or EXCLUSIONS; the declared root must match the actual traversal
 * root(s).
 */
export function validateSearchDeclaration(declaration, parsed, { cwd = process.cwd(), home = homedir() } = {}) {
  if (!declaration || typeof declaration !== "object" || Array.isArray(declaration)) {
    return { ok: false, reason: "declaration missing" };
  }
  const root = declaration.root ?? declaration.searchRoot ?? null;
  if (!root) return { ok: false, reason: "declaration missing SEARCH ROOT" };
  const why = declaration.why ?? declaration.justification ?? null;
  if (!why || String(why).trim().length === 0) {
    return { ok: false, reason: "declaration missing WHY THIS ROOT IS AUTHORITATIVE" };
  }
  const boundary = declaration.boundary ?? declaration.boundaries ?? declaration.exclusions ?? null;
  if (!boundary || (Array.isArray(boundary) && boundary.length === 0)) {
    return { ok: false, reason: "declaration missing BOUNDARY / EXCLUSIONS" };
  }
  const declared = normalizeSearchPath(root, { cwd, home });
  if (!declared) return { ok: false, reason: "declaration SEARCH ROOT unparseable" };
  const matches = (parsed.roots?.length ?? 0) > 0 && parsed.roots.every((r) => {
    const rn = normalizeSearchPath(r, { cwd, home });
    return rn === declared || rn.startsWith(declared + "/") || declared.startsWith(rn + "/");
  });
  if (!matches) return { ok: false, reason: "declared root does not match the actual traversal root" };
  return { ok: true, reason: "declaration provides authoritative root + boundary" };
}

// ── Decision assembly ───────────────────────────────────────────────────

const admit = (parsed, fp, boundaryKind, reason) => ({
  command: parsed.raw ?? null,
  family: parsed.family,
  recursive: parsed.recursive === true,
  roots: [...(parsed.roots ?? [])],
  boundaries: [...(parsed.boundaries ?? [])],
  decision: "ADMIT",
  admit: true,
  holdCode: null,
  reason,
  boundaryKind,
  fingerprint: fp,
});

const reject = (parsed, fp, holdCode, reason) => ({
  command: parsed.raw ?? null,
  family: parsed.family,
  recursive: parsed.recursive === true,
  roots: [...(parsed.roots ?? [])],
  boundaries: [...(parsed.boundaries ?? [])],
  decision: "REJECT",
  admit: false,
  holdCode,
  reason,
  boundaryKind: null,
  fingerprint: fp,
});

function governSegment(parsed, ctx) {
  const { intent, declaration, authorizedRoots, registry, home } = ctx;
  const fp = strategyFingerprint(parsed, { intent, home, cwd: ctx.cwd });

  // (D2) tracked/indexed lookup — bounded to the git index by construction.
  if (TRACKED_INDEXED_FAMILIES.includes(parsed.family)) {
    return admit(parsed, fp, "tracked-indexed", "tracked/indexed lookup is bounded to the git index");
  }

  // (F) repeated failed strategy — checked BEFORE forbidden-root so a
  // materially equivalent re-attempt is reported as a repeat, not re-derived.
  if (registry && registry.isFailed(fp)) {
    return reject(parsed, fp, SEARCH_HOLDS.REPEATED_FAILED_SEARCH_STRATEGY, "repeated failed search strategy (materially equivalent traversal)");
  }

  // (B) forbidden roots.
  const forbidden = (parsed.roots ?? [])
    .map((r) => ({ root: r, cls: classifySearchRoot(r, { home }) }))
    .find((x) => x.cls.forbidden);
  if (forbidden) {
    if (registry) registry.recordFailure(fp, { reason: forbidden.cls.reason, toolFamily: parsed.family });
    return reject(parsed, fp, forbidden.cls.holdCode, `unbounded traversal from ${forbidden.root}: ${forbidden.cls.reason}`);
  }

  // (A) non-recursive (exact path / stdin) — bounded.
  if (!parsed.recursive) {
    return admit(parsed, fp, "exact", "non-recursive lookup is bounded to the named paths");
  }

  // (A) recursive: require an explicit traversal boundary.
  if (parsed.boundaries.length > 0) {
    return admit(parsed, fp, parsed.boundaries.map((b) => b.kind).join("+"), "recursive search carries an explicit traversal boundary");
  }
  if ((parsed.roots?.length ?? 0) > 0 && isUnderAllowlist(parsed.roots[0], authorizedRoots, ctx) && parsed.roots.every((r) => isUnderAllowlist(r, authorizedRoots, ctx))) {
    return admit(parsed, fp, "allowlist", "recursive root is inside the explicit subtree allowlist");
  }
  if (declaration) {
    const dv = validateSearchDeclaration(declaration, parsed, ctx);
    if (dv.ok) return admit(parsed, fp, "declaration", dv.reason);
    return reject(parsed, fp, SEARCH_HOLDS.MISSING_SEARCH_DECLARATION, `recursive search declaration invalid: ${dv.reason}`);
  }
  return reject(parsed, fp, SEARCH_HOLDS.MISSING_SEARCH_DECLARATION, "recursive search requires a pre-execution declaration (SEARCH ROOT / WHY THIS ROOT IS AUTHORITATIVE / BOUNDARY-OR-EXCLUSIONS)");
}

/**
 * The governor gate. Accepts a raw shell command string (possibly a
 * multi-segment script) and governs every recognized recursive-search
 * command within it.
 *
 * @param {object} request
 * @param {string} request.command — raw shell command / script
 * @param {string} [request.cwd] — current working directory for relative roots
 * @param {string} [request.home] — home dir (defaults to os.homedir())
 * @param {string} [request.intent] — discovery intent for the fingerprint
 * @param {object} [request.declaration] — pre-execution declaration (G)
 * @param {string[]} [request.authorizedRoots] — explicit subtree allowlist
 * @param {object} [request.registry] — injectable failed-strategy registry
 * @returns {{admit: boolean, decision: string, holdCode: string|null, reason: string, fingerprint: string|null, segments: object[]}}
 */
export function governSearch(request = {}) {
  const {
    command,
    cwd = process.cwd(),
    home = homedir(),
    intent = null,
    declaration = null,
    authorizedRoots = null,
    registry = null,
  } = request;
  const ctx = { cwd, home, intent, declaration, authorizedRoots, registry };
  const results = [];
  const seen = new Set();
  const worklist = [String(command ?? "")];
  while (worklist.length) {
    const chunk = worklist.pop();
    if (seen.has(chunk)) continue;
    seen.add(chunk);
    const segments = splitShellSegments(chunk);
    for (const seg of segments) {
      const parsed = parseSearchCommand(seg, ctx);
      if (parsed.recognized) results.push(governSegment(parsed, ctx));
      for (const sub of extractSubcommands(seg)) worklist.push(sub);
    }
  }
  if (results.length === 0) {
    return { admit: true, decision: "NOT_A_SEARCH_COMMAND", holdCode: null, reason: "no recursive search command detected", fingerprint: null, segments: [] };
  }
  const rejected = results.find((r) => r.decision === "REJECT");
  if (rejected) {
    return { admit: false, decision: "REJECT", holdCode: rejected.holdCode, reason: rejected.reason, fingerprint: rejected.fingerprint, segments: results };
  }
  return { admit: true, decision: "ADMIT", holdCode: null, reason: results.map((r) => `${r.family}:${r.boundaryKind ?? "admit"}`).join("; "), fingerprint: results[0]?.fingerprint ?? null, segments: results };
}

/**
 * Conservative helper for governance-boundary wiring (envelope authorizedPaths):
 * reject only ABSOLUTE paths that are forbidden roots. Relative paths are
 * scoped to an authorized worktree and are never flagged here.
 */
export function assertAuthorizedPathsBounded(authorizedPaths, { home = homedir(), cwd = process.cwd() } = {}) {
  const errors = [];
  for (const p of authorizedPaths ?? []) {
    const s = String(p ?? "").trim();
    if (s === "" || !isAbsolute(s)) continue; // relative → bounded to a worktree
    const cls = classifySearchRoot(normalizeSearchPath(s, { cwd, home }), { home });
    if (cls.forbidden) {
      errors.push(`authorizedPath_unbounded:${s}:${cls.kind}:${cls.holdCode}`);
    }
  }
  return { ok: errors.length === 0, errors };
}
