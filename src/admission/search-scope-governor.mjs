// src/admission/search-scope-governor.mjs
//
// RB-SSG4-FR4 — SEARCH-SCOPE / RECURSIVE-TRAVERSAL GOVERNOR (COARSE GUARD)
//
// Frozen by RB-SSG4-RC1: Bounded Search Execution Governance.
//
//   Recursive search is allowed. Unbounded, unresolved, resource-wasting,
//   and repeatedly-failed recursive search is not.
//
// The system controls SCOPE + RESOURCES + RETRY, and SHALL NOT model more
// shell semantics than that objective requires.
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
// 6. FR3 review found `~user` tilde expansion and wrapper / find -exec
//    re-tokenization provenance loss (VALID_FINDINGS, reconciled by RC1).
//
// ── FR4 COARSE MODEL (replaces the retired shell-semantic engine) ────────
// The Bash guard answers exactly three questions:
//   EXPLICIT BOUNDED ROOT            → ELIGIBLE
//   EXPLICIT FORBIDDEN / OVERSIZED   → REJECT
//   ROOT NOT STATICALLY CONCRETE     → REJECT / RESTATE
// A recursive search hidden behind indirection (wrapper chains, shell -c,
// xargs, find -exec, command substitution) is REJECT/RESTATE — never
// reconstructed by emulating the shell.
//
// RETIRED_BY_RC1_BOUNDARY_CHANGE (removed in FR4):
//   wrapper contracts, shell -c cluster parsing, env -S tokenizer,
//   xargs -I replacement tracking, find -exec payload reconstruction,
//   positional-parameter substitution, per-token expansion-provenance table.
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
  MISSING_SEARCH_DECLARATION: "MISSING_SEARCH_DECLARATION",
  UNBOUNDED_RECURSIVE_TRAVERSAL: "UNBOUNDED_RECURSIVE_TRAVERSAL",
  // RB-SSG4 — no-progress / repeated-search governor.
  REPLAN_REQUIRED: "REPLAN_REQUIRED",
  SEARCH_STRATEGY_FAILED: "SEARCH_STRATEGY_FAILED",
  // FR4 — a recursive search hidden behind indirection we no longer
  // reconstruct (wrapper / shell -c / xargs / find -exec / command subst).
  UNRESOLVED_EXECUTION_STRUCTURE: "UNRESOLVED_EXECUTION_STRUCTURE",
  // FR4 — a recursive root that is not statically concrete (runtime shell
  // expansion, named-user tilde, glob, command substitution, …).
  INDETERMINATE_SEARCH_ROOT: "INDETERMINATE_SEARCH_ROOT",
});

// ── RB-SSG4 — deterministic search-request classification ───────────────
export const SEARCH_CLASSIFICATIONS = Object.freeze({
  SAFE_BOUNDED: "SAFE_BOUNDED",
  REWRITABLE_UNSAFE: "REWRITABLE_UNSAFE",
  NON_REWRITABLE_UNSAFE: "NON_REWRITABLE_UNSAFE",
  SEARCH_STRATEGY_FAILED: "SEARCH_STRATEGY_FAILED",
});

// ── RB-SSG4 — progressive widening ladder（monotonic, evidence-gated）───
export const WIDENING_LEVELS = Object.freeze({
  EXACT_FILE: 0,
  KNOWN_MODULE: 1,
  TRACKED_REPO: 2,
  BOUNDED_SURFACE: 3,
  NEIGHBORING_SCOPE: 4,
  BROADER_AUTHORIZED: 5,
});

export const REWRITE_STRATEGIES = Object.freeze({
  GIT_GREP: "git-grep",
  GIT_LS_FILES: "git-ls-files",
  BOUNDED_RG: "bounded-rg",
  BOUNDED_GREP: "bounded-grep",
  BOUNDED_FIND: "bounded-find",
});

/** Tracked/indexed lookup families — bounded to the git index by construction. */
export const TRACKED_INDEXED_FAMILIES = Object.freeze([
  "git-grep",
  "git-ls-files",
  "git-log",
]);

// ── FR4 — principle-based "statically concrete root" predicate ──────────
// A root token is concrete IFF the governor can resolve it WITHOUT the shell
// performing any expansion. Concretely: an absolute/relative path, own-home
// tilde (`~`, `~/…`), or the known `$HOME` / `${HOME}` forms. Everything else
// (named-user tilde `~user`, `$VAR`, `${VAR}`, `$(…)`, backticks, globs,
// process substitution, brace expansion) is runtime expansion → INDETERMINATE.
const SHELL_ACTIVE_RE = /[\$`*?\[\](){}<>]/;

export function isConcreteRootToken(t) {
  const s = String(t ?? "").trim();
  if (s === "") return false;
  if (s === "~" || s.startsWith("~/")) return true;
  if (s === "$HOME" || s === "${HOME}" || s.startsWith("$HOME/") || s.startsWith("${HOME}/")) return true;
  if (s.startsWith("~")) return false; // ~user / ~user/path → runtime tilde expansion
  return !SHELL_ACTIVE_RE.test(s);
}

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
    // Backslash escapes the next character (e.g. find -exec … \; must not
    // split on the escaped semicolon).
    if (ch === "\\" && i + 1 < command.length) {
      cur += ch + command[i + 1];
      i++;
      continue;
    }
    if (ch === "\n" || ch === ";") {
      segs.push(cur);
      cur = "";
      continue;
    }
    if (ch === "|") {
      // `||` is a compound separator; a single `|` is a pipeline.
      segs.push(cur);
      cur = "";
      if (command[i + 1] === "|") i++;
      continue;
    }
    if (ch === "&") {
      const next = command[i + 1];
      const prev = command[i - 1];
      if (next === "&") { segs.push(cur); cur = ""; i++; continue; } // &&
      if (next === ">") { cur += ch; continue; } // &> redirection
      if (prev === ">") { cur += ch; continue; } // n>&m redirection
      segs.push(cur); cur = ""; continue; // background `&`
    }
    cur += ch;
  }
  segs.push(cur);
  return segs.map((s) => s.trim()).filter(Boolean);
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
    // POSIX backslash escape OUTSIDE quotes: `\X` is the literal `X`.
    if (ch === "\\" && i + 1 < segment.length) {
      cur += segment[i + 1];
      i++;
      continue;
    }
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

// Quote a single shell token so re-tokenization preserves its boundaries.
const shellQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
const rejoinTokens = (tokens) => tokens.map(shellQuote).join(" ");

const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const isEnvAssignment = (tok) => ENV_ASSIGNMENT_RE.test(String(tok ?? ""));

/** Skip leading POSIX environment assignments (`NAME=VALUE …`). */
function skipLeadingAssignments(tokens) {
  let i = 0;
  while (i < tokens.length && isEnvAssignment(tokens[i])) i++;
  return i;
}

const isCwdRelativePath = (t) => {
  const s = String(t ?? "").trim();
  if (s === "") return false;
  if (isAbsolute(s)) return false;
  if (s === "~" || s.startsWith("~/")) return false;
  if (s === "$HOME" || s === "${HOME}" || s.startsWith("$HOME/") || s.startsWith("${HOME}/")) return false;
  return true;
};

// ── FR4 — indirection classification (coarse, no reconstruction) ────────
// Programs that can spawn a nested command. A recursive search hidden behind
// one of these is REJECT/RESTATE, not reconstructed.
const SEARCH_INDIRECTION_BASES = new Set([
  "bash", "sh", "zsh", "dash", "ksh", "env", "sudo", "xargs",
  "nohup", "timeout", "nice", "busybox", "command",
]);

// Presence of a search family token (find/rg/grep) as a command word.
const SEARCH_FAMILY_TOKEN_RE = /(^|[^A-Za-z0-9_.\/-])(find|rg|ripgrep|grep|egrep|fgrep)([^A-Za-z0-9_.\/-]|$)/;

/**
 * FR4 — classify a single shell segment as a COMPLEX execution form whose
 * recursive-search scope cannot be statically established without shell
 * reconstruction. Returns null when the segment is a plain direct search
 * command or an unrelated command.
 */
function classifyComplexForm(segment) {
  const tokens = tokenize(String(segment ?? "").trim());
  if (tokens.length === 0) return null;
  const start = skipLeadingAssignments(tokens);
  if (start >= tokens.length) return null;
  const base = programBase(tokens[start]);
  const tail = tokens.slice(start + 1).join(" ");

  if (base === "find") {
    // find -exec / -execdir spawn nested commands we will not reconstruct.
    if (tokens.some((t) => t === "-exec" || t === "-execdir")) return `find ${tokens.find((t) => t === "-exec" || t === "-execdir")}`;
    return null;
  }
  if (SEARCH_INDIRECTION_BASES.has(base)) {
    if (SEARCH_FAMILY_TOKEN_RE.test(tail)) return `indirection via ${base}`;
    return null;
  }
  // Command substitution / backtick can hide a nested search command.
  if (/(\$\(|`)/.test(segment) && SEARCH_FAMILY_TOKEN_RE.test(segment)) {
    return "command substitution";
  }
  return null;
}

// ── Command family detection + parsing ──────────────────────────────────

/**
 * Parse a single shell command (one pipeline segment) into a search-command
 * descriptor. Recognized families: find, rg/ripgrep, grep/egrep/fgrep,
 * git grep / git ls-files / git log. Everything else is `other`.
 */
export function parseSearchCommand(command, { cwd = process.cwd(), home = homedir() } = {}) {
  const tokens = tokenize(String(command ?? "").trim());
  if (tokens.length === 0) {
    return { recognized: false, family: "other", raw: String(command ?? "") };
  }
  const start = skipLeadingAssignments(tokens);
  if (start >= tokens.length) {
    return { recognized: false, family: "other", raw: String(command ?? "") };
  }
  const base = programBase(tokens[start]);

  if (base === "find") return parseFind(tokens, { cwd, home });
  if (base === "rg" || base === "ripgrep") return parseRg(tokens, { cwd, home });
  if (base === "grep" || base === "egrep" || base === "fgrep") return parseGrep(tokens, { cwd, home });
  if (base === "git") {
    // Skip global options that may precede the subcommand so
    // `git -C <dir> grep` / `git --no-pager grep` are still classified.
    let idx = start + 1;
    while (idx < tokens.length) {
      const t = tokens[idx];
      if (t === "-C" && tokens[idx + 1] !== undefined) { idx += 2; continue; }
      if (t === "--no-pager" || t === "--paginate" || t === "--help") { idx += 1; continue; }
      if ((t === "-c" || t === "--git-dir" || t === "--work-tree") && tokens[idx + 1] !== undefined) { idx += 2; continue; }
      if (t.startsWith("-c") && t.includes("=")) { idx += 1; continue; }
      break;
    }
    const sub = tokens[idx];
    const rest = tokens.slice(idx + 1);
    if (sub === "grep") return { recognized: true, family: "git-grep", recursive: true, roots: [], boundaries: [{ kind: "tracked-indexed", detail: "git grep" }], pattern: rest.join(" "), exact: false, raw: String(command), indeterminateRoots: false, rawPathArgs: [], pathArgsExplicit: false, options: [] };
    if (sub === "ls-files") return { recognized: true, family: "git-ls-files", recursive: true, roots: [], boundaries: [{ kind: "tracked-indexed", detail: "git ls-files" }], pattern: null, exact: false, raw: String(command), indeterminateRoots: false, rawPathArgs: [], pathArgsExplicit: false, options: [] };
    if (sub === "log") return { recognized: true, family: "git-log", recursive: true, roots: [], boundaries: [{ kind: "tracked-indexed", detail: "git log" }], pattern: rest.join(" "), exact: false, raw: String(command), indeterminateRoots: false, rawPathArgs: [], pathArgsExplicit: false, options: [] };
    return { recognized: false, family: "git", raw: String(command) };
  }
  return { recognized: false, family: "other", raw: String(command) };
}

function parseFind(tokens, { cwd, home }) {
  const start = skipLeadingAssignments(tokens);
  let i = start + 1;
  // Skip leading mode flags (-H -L -P -D).
  while (i < tokens.length && /^-[HLPD]$/.test(tokens[i])) i++;
  const rawPathArgs = [];
  while (i < tokens.length && !tokens[i].startsWith("-") && !["!", "(", ")"].includes(tokens[i])) {
    if (isRedirection(tokens[i])) {
      i = skipRedirect(tokens, i);
      continue;
    }
    rawPathArgs.push(tokens[i]);
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
  const indeterminateRoots = rawPathArgs.some((r) => !isConcreteRootToken(r));
  const normRoots = (rawPathArgs.length ? rawPathArgs : ["."]).map((r) => normalizeSearchPath(r, { cwd, home })).filter(Boolean);
  const recursive = maxdepth !== "0"; // -maxdepth 0 => the root itself only (exact)
  return {
    recognized: true,
    family: "find",
    recursive,
    roots: normRoots,
    boundaries,
    pattern: tokens.filter((t) => t.startsWith("-name") || t.startsWith("-iname") || t.startsWith("-regex")).join(" ") || null,
    exact: !recursive,
    pathArgsExplicit: rawPathArgs.length > 0,
    rawPathArgs: [...rawPathArgs],
    indeterminateRoots,
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
  const start = skipLeadingAssignments(tokens);
  const positional = [];
  const boundaries = [];
  const options = [];
  let hasOptionPattern = false;
  let i = start + 1;
  let afterDashDash = false;
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (!afterDashDash && t === "--") { afterDashDash = true; options.push(t); continue; }
    if (!afterDashDash && t.startsWith("--")) {
      const eq = t.indexOf("=");
      const key = eq >= 0 ? t.slice(0, eq) : t;
      const inline = eq >= 0 ? t.slice(eq + 1) : null;
      options.push(t);
      if (key === "--max-depth" || key === "--maxdepth") {
        boundaries.push({ kind: "maxdepth", detail: inline ?? tokens[i + 1] ?? "" });
        if (inline === null && tokens[i + 1] !== undefined) { options.push(tokens[i + 1]); i++; }
      } else if (key === "--exclude" || key === "--exclude-dir" || key === "--exclude-from") {
        boundaries.push({ kind: "exclusion", detail: inline ?? tokens[i + 1] ?? "" });
        if (inline === null && tokens[i + 1] !== undefined) { options.push(tokens[i + 1]); i++; }
      } else if (key === "--glob") {
        const v = inline ?? tokens[i + 1];
        if (v && String(v).startsWith("!")) boundaries.push({ kind: "exclusion", detail: v });
        if (inline === null && tokens[i + 1] !== undefined) { options.push(tokens[i + 1]); i++; }
      } else if (RG_VALUE_OPTIONS.has(key) && inline === null) {
        if (tokens[i + 1] !== undefined) { options.push(tokens[i + 1]); i++; }
      }
      if (key === "--regexp" || key === "--file") hasOptionPattern = true;
      continue;
    }
    if (!afterDashDash && t.startsWith("-") && t.length > 1) {
      options.push(t);
      if (t === "-g") {
        const v = tokens[i + 1];
        if (v && String(v).startsWith("!")) boundaries.push({ kind: "exclusion", detail: v });
        if (tokens[i + 1] !== undefined) { options.push(tokens[i + 1]); i++; }
      } else if (["-m", "-A", "-B", "-C", "-t", "-e", "-f"].includes(t)) {
        if (t === "-e" || t === "-f") hasOptionPattern = true;
        if (tokens[i + 1] !== undefined) { options.push(tokens[i + 1]); i++; }
      }
      continue;
    }
    if (isRedirection(t)) {
      i = skipRedirect(tokens, i) - 1;
      continue;
    }
    positional.push(t);
  }
  const pattern = hasOptionPattern ? null : (positional[0] ?? null);
  const pathArgs = hasOptionPattern ? positional : positional.slice(1);
  const indeterminateRoots = pathArgs.some((r) => !isConcreteRootToken(r));
  const normRoots = (pathArgs.length ? pathArgs : ["."]).map((r) => normalizeSearchPath(r, { cwd, home })).filter(Boolean);
  return {
    recognized: true,
    family: "rg",
    recursive: true, // ripgrep recurses by default
    roots: normRoots,
    boundaries,
    pattern,
    options,
    hasOptionPattern,
    exact: false,
    pathArgsExplicit: pathArgs.length > 0,
    rawPathArgs: [...pathArgs],
    indeterminateRoots,
    raw: tokens.join(" "),
  };
}

// GNU grep options that consume the NEXT token as a value.
const GREP_VALUE_LONG = new Set([
  "--include", "--exclude", "--exclude-dir", "--exclude-from", "--max-count",
  "--label", "--group-separator", "--binary-files", "--context",
  "--after-context", "--before-context", "--regexp", "--file", "--color",
  "--colour", "--directories", "--devices",
]);
const GREP_VALUE_SHORT = new Set(["-m", "-A", "-B", "-C", "-e", "-f", "-d", "-D"]);

function parseGrep(tokens, { cwd, home }) {
  const start = skipLeadingAssignments(tokens);
  const positional = [];
  const boundaries = [];
  const options = [];
  let recursive = false;
  let hasOptionPattern = false;
  let afterDashDash = false;
  for (let i = start + 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (!afterDashDash && t === "--") { afterDashDash = true; options.push(t); continue; }
    if (!afterDashDash && t.startsWith("--")) {
      const eq = t.indexOf("=");
      const key = eq >= 0 ? t.slice(0, eq) : t;
      const inline = eq >= 0 ? t.slice(eq + 1) : null;
      options.push(t);
      if (key === "--recursive") recursive = true;
      else if (key === "--exclude" || key === "--exclude-dir") {
        boundaries.push({ kind: "exclusion", detail: inline ?? tokens[i + 1] ?? "" });
        if (inline === null && tokens[i + 1] !== undefined) { options.push(tokens[i + 1]); i++; }
      } else if (GREP_VALUE_LONG.has(key) && inline === null) {
        if (tokens[i + 1] !== undefined) { options.push(tokens[i + 1]); i++; }
      }
      if (key === "--regexp" || key === "--file") hasOptionPattern = true;
      continue;
    }
    if (!afterDashDash && t.startsWith("-") && t.length > 1) {
      options.push(t);
      // Combined short flags: -r, -R, -rl, -riR, -rls all imply recursive.
      if (/[rR]/.test(t.slice(1))) recursive = true;
      if (GREP_VALUE_SHORT.has(t)) {
        if (t === "-e" || t === "-f") hasOptionPattern = true;
        if (tokens[i + 1] !== undefined) { options.push(tokens[i + 1]); i++; }
      }
      continue;
    }
    if (isRedirection(t)) {
      i = skipRedirect(tokens, i) - 1;
      continue;
    }
    positional.push(t);
  }
  const pattern = hasOptionPattern ? null : (positional[0] ?? null);
  const fileArgs = hasOptionPattern ? positional : positional.slice(1);
  const indeterminateRoots = fileArgs.some((r) => !isConcreteRootToken(r));
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
    options,
    hasOptionPattern,
    exact: !recursive,
    pathArgsExplicit: fileArgs.length > 0,
    rawPathArgs: [...fileArgs],
    indeterminateRoots,
    raw: tokens.join(" "),
  };
}

// ── Strategy fingerprint (invariant E) ──────────────────────────────────

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

export function createFailedStrategyRegistry() {
  const failed = new Map();
  return {
    recordFailure(fingerprint, meta = {}) {
      if (!fingerprint) return false;
      const key = String(fingerprint);
      const prev = failed.get(key);
      failed.set(key, {
        count: (prev?.count ?? 0) + 1,
        reason: meta.reason ?? prev?.reason ?? null,
        toolFamily: meta.toolFamily ?? prev?.toolFamily ?? null,
        firstRecordedAt: prev?.firstRecordedAt ?? meta.recordedAt ?? new Date().toISOString(),
        lastRecordedAt: meta.recordedAt ?? new Date().toISOString(),
      });
      return true;
    },
    isFailed(fingerprint) {
      return !!fingerprint && failed.has(String(fingerprint));
    },
    countFor(fingerprint) {
      return !!fingerprint ? (failed.get(String(fingerprint))?.count ?? 0) : 0;
    },
    entries() {
      return [...failed.entries()].map(([fingerprint, m]) => ({ fingerprint, ...m }));
    },
    /** FR4 — reconstruct state from a persisted entries array (session-scoped). */
    hydrate(entries) {
      for (const e of entries ?? []) {
        if (!e || !e.fingerprint) continue;
        const count = Number(e.count) || 0;
        if (count <= 0) continue;
        failed.set(String(e.fingerprint), {
          count,
          reason: e.reason ?? null,
          toolFamily: e.toolFamily ?? null,
          firstRecordedAt: e.firstRecordedAt ?? new Date().toISOString(),
          lastRecordedAt: e.lastRecordedAt ?? new Date().toISOString(),
        });
      }
      return this;
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

// ── RB-SSG4 — bounded-search rewrite derivation（pure）────────────────────

const findExclusionArgs = () => DEFAULT_EXCLUSIONS.map((e) => `-not -path '*/${e}/*'`).join(" ");

function normalizeCandidateRoots(roots, { cwd, home }) {
  const out = [];
  for (const r of roots ?? []) {
    const n = normalizeSearchPath(r, { cwd, home });
    if (n && n !== sep) out.push(n);
  }
  return [...new Set(out)];
}

function rebuildBoundedFind(parsed, target) {
  const tokens = tokenize(parsed.raw ?? "");
  const kept = [];
  let i = skipLeadingAssignments(tokens) + 1;
  while (i < tokens.length) {
    const t = tokens[i];
    if (["-name", "-iname", "-regex", "-iregex", "-type"].includes(t) && tokens[i + 1] !== undefined) {
      kept.push(t, tokens[i + 1]);
      i += 2;
      continue;
    }
    i += 1;
  }
  return ["find", shellQuote(target), ...kept.map(shellQuote), findExclusionArgs()].join(" ");
}

function rebuildBoundedContentSearch(parsed, target, tool) {
  const opts = (parsed.options ?? []).filter((t) => typeof t === "string" && t.length > 0);
  const segs = [tool, ...opts.map(shellQuote)];
  if (!parsed.hasOptionPattern) {
    if (parsed.pattern == null || String(parsed.pattern).length === 0) return null;
    segs.push(shellQuote(parsed.pattern));
  }
  segs.push(shellQuote(target));
  return segs.join(" ");
}

export function deriveSafeSearchReplacement(parsed, { cwd = process.cwd(), home = homedir(), authoritativeRoots = null, authorizedRoots = null } = {}) {
  if (!parsed || typeof parsed !== "object") return { ok: false, reason: "no_parsed_command" };
  const family = parsed.family;
  if (!["grep", "rg", "find"].includes(family)) return { ok: false, reason: `family_not_rewritable:${family}` };
  const candidates = normalizeCandidateRoots(authoritativeRoots ?? authorizedRoots ?? [], { cwd, home })
    .filter((c) => classifySearchRoot(c, { home }).forbidden === false);
  if (candidates.length === 0) return { ok: false, reason: "no_authoritative_root_known" };
  const roots = normalizeCandidateRoots(parsed.roots ?? [], { cwd, home });
  if (roots.length === 0) return { ok: false, reason: "no_traversal_root" };

  const targets = new Set();
  for (const root of roots) {
    for (const c of candidates) {
      if (c === root || c.startsWith(root + "/")) targets.add(c);
    }
  }
  if (targets.size === 0) return { ok: false, reason: "no_safe_narrowing_target" };
  if (targets.size > 1) return { ok: false, reason: "ambiguous_authoritative_roots" };
  const target = [...targets][0];

  if (family === "find") {
    return {
      ok: true,
      replacement: {
        command: rebuildBoundedFind(parsed, target),
        family: "find",
        authoritativeRoot: target,
        strategy: REWRITE_STRATEGIES.BOUNDED_FIND,
        wideningLevel: WIDENING_LEVELS.BOUNDED_SURFACE,
        exclusions: [...DEFAULT_EXCLUSIONS],
        reason: `narrowed traversal to authoritative root ${target} with canonical exclusions`,
      },
    };
  }

  const tool = family === "rg" ? "rg" : "grep";
  const command = rebuildBoundedContentSearch(parsed, target, tool);
  if (command == null) return { ok: false, reason: "pattern_not_reconstructible" };
  return {
    ok: true,
    replacement: {
      command,
      family,
      authoritativeRoot: target,
      strategy: family === "rg" ? REWRITE_STRATEGIES.BOUNDED_RG : REWRITE_STRATEGIES.BOUNDED_GREP,
      wideningLevel: WIDENING_LEVELS.BOUNDED_SURFACE,
      exclusions: [],
      reason: `narrowed filesystem search to authoritative root ${target} (result-affecting options preserved)`,
    },
  };
}

export function buildSearchGovernorTelemetry(request = {}, decision = {}) {
  return {
    schema: "autoloop.search-governor-telemetry/v1",
    commandFamily: decision.segments?.[0]?.family ?? decision.family ?? null,
    classification: decision.classification ?? null,
    requestedScope: decision.segments?.[0]?.roots ?? decision.roots ?? [],
    resolvedAuthoritativeScope: decision.authoritativeRoot ?? null,
    rewriteStrategy: decision.replacement?.strategy ?? null,
    wideningLevel: decision.wideningLevel ?? null,
    denialReason: decision.holdCode ?? null,
    repeatedStrategyCount: decision.repeatedStrategyCount ?? 0,
    replanTrigger: decision.replanRequired === true,
    executionOutcome: decision.admit === true ? "admitted" : (decision.replacement ? "rewritten" : "rejected"),
    intent: request.intent ?? null,
  };
}

// ── Decision assembly ───────────────────────────────────────────────────

const admit = (parsed, fp, boundaryKind, reason, opts = {}) => ({
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
  classification: SEARCH_CLASSIFICATIONS.SAFE_BOUNDED,
  replacement: opts.replacement ?? null,
  wideningLevel: opts.wideningLevel ?? null,
  exclusions: opts.exclusions ?? [],
  authoritativeRoot: opts.authoritativeRoot ?? null,
  replanRequired: false,
  repeatedStrategyCount: 0,
});

const reject = (parsed, fp, holdCode, reason, opts = {}) => ({
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
  classification: opts.classification ?? SEARCH_CLASSIFICATIONS.NON_REWRITABLE_UNSAFE,
  replacement: opts.replacement ?? null,
  wideningLevel: opts.wideningLevel ?? null,
  exclusions: opts.exclusions ?? [],
  authoritativeRoot: opts.authoritativeRoot ?? null,
  replanRequired: opts.replanRequired ?? false,
  repeatedStrategyCount: opts.repeatedStrategyCount ?? 0,
});

function governSegment(parsed, ctx) {
  const { intent, declaration, authorizedRoots, registry, home, cwdIndeterminate = false } = ctx;
  const fp = strategyFingerprint(parsed, { intent, home, cwd: ctx.cwd });

  // (D2) tracked/indexed lookup — bounded to the git index by construction.
  if (TRACKED_INDEXED_FAMILIES.includes(parsed.family)) {
    return admit(parsed, fp, "tracked-indexed", "tracked/indexed lookup is bounded to the git index");
  }

  // (FR4) repeated failed strategy — count-aware ladder, checked BEFORE
  // forbidden-root so a materially equivalent re-attempt is reported as a
  // repeat (REPLAN_REQUIRED on 2nd, mechanical block on 3rd+).
  const failedCount = registry ? registry.countFor(fp) : 0;
  if (failedCount >= 1) {
    if (registry) registry.recordFailure(fp, { reason: "repeated search strategy", toolFamily: parsed.family });
    const mechanicalBlock = failedCount >= 2;
    return reject(
      parsed, fp,
      mechanicalBlock ? SEARCH_HOLDS.SEARCH_STRATEGY_FAILED : SEARCH_HOLDS.REPLAN_REQUIRED,
      mechanicalBlock
        ? "search strategy failed: materially equivalent traversal mechanically blocked after repeated failures"
        : "repeated failed search strategy: REPLAN_REQUIRED before this command family/scope may retry",
      { classification: SEARCH_CLASSIFICATIONS.SEARCH_STRATEGY_FAILED, replanRequired: !mechanicalBlock, repeatedStrategyCount: failedCount + 1 },
    );
  }

  // (FR4 B3) a recursive root that is not statically concrete must never
  // enter the bounded-literal ADMIT lane.
  if (parsed.recursive && parsed.indeterminateRoots) {
    return reject(
      parsed, fp, SEARCH_HOLDS.INDETERMINATE_SEARCH_ROOT,
      "recursive search root is not statically concrete (runtime expansion / unresolved tilde): restate using an explicit bounded root or structured search",
      { classification: SEARCH_CLASSIFICATIONS.NON_REWRITABLE_UNSAFE },
    );
  }

  // (FR4) a recursive root that DEPENDS on an indeterminate effective cwd
  // (a `cd` target substituted at runtime) cannot be statically bounded.
  if (cwdIndeterminate && parsed.recursive &&
      ((parsed.rawPathArgs ?? []).some(isCwdRelativePath) || parsed.pathArgsExplicit === false)) {
    return reject(
      parsed, fp, SEARCH_HOLDS.INDETERMINATE_SEARCH_ROOT,
      "recursive search root depends on an indeterminate runtime working directory",
      { classification: SEARCH_CLASSIFICATIONS.NON_REWRITABLE_UNSAFE },
    );
  }

  // (B) forbidden roots.
  const forbidden = (parsed.roots ?? [])
    .map((r) => ({ root: r, cls: classifySearchRoot(r, { home }) }))
    .find((x) => x.cls.forbidden);
  if (forbidden) {
    if (registry) registry.recordFailure(fp, { reason: forbidden.cls.reason, toolFamily: parsed.family });
    const rewrite = deriveSafeSearchReplacement(parsed, { ...ctx, cwd: ctx.cwd });
    if (rewrite.ok) {
      return reject(parsed, fp, forbidden.cls.holdCode, `unbounded traversal from ${forbidden.root}: ${forbidden.cls.reason}`, {
        classification: SEARCH_CLASSIFICATIONS.REWRITABLE_UNSAFE,
        replacement: rewrite.replacement,
        wideningLevel: rewrite.replacement.wideningLevel,
        exclusions: rewrite.replacement.exclusions,
        authoritativeRoot: rewrite.replacement.authoritativeRoot,
      });
    }
    return reject(parsed, fp, forbidden.cls.holdCode, `unbounded traversal from ${forbidden.root}: ${forbidden.cls.reason}`, {
      classification: SEARCH_CLASSIFICATIONS.NON_REWRITABLE_UNSAFE,
    });
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
  const rewrite = deriveSafeSearchReplacement(parsed, { ...ctx, cwd: ctx.cwd });
  if (rewrite.ok) {
    if (registry) registry.recordFailure(fp, { reason: "missing declaration", toolFamily: parsed.family });
    return reject(
      parsed, fp,
      SEARCH_HOLDS.MISSING_SEARCH_DECLARATION,
      "recursive search requires a pre-execution declaration (SEARCH ROOT / WHY THIS ROOT IS AUTHORITATIVE / BOUNDARY-OR-EXCLUSIONS)",
      {
        classification: SEARCH_CLASSIFICATIONS.REWRITABLE_UNSAFE,
        replacement: rewrite.replacement,
        wideningLevel: rewrite.replacement.wideningLevel,
        exclusions: rewrite.replacement.exclusions,
        authoritativeRoot: rewrite.replacement.authoritativeRoot,
      },
    );
  }
  return reject(parsed, fp, SEARCH_HOLDS.MISSING_SEARCH_DECLARATION, "recursive search requires a pre-execution declaration (SEARCH ROOT / WHY THIS ROOT IS AUTHORITATIVE / BOUNDARY-OR-EXCLUSIONS)");
}

/**
 * Parse a `cd <dir>` builtin from a sequential shell segment so relative
 * traversal roots resolve against the post-`cd` working directory.
 *
 * @returns {{target: string, indeterminate: boolean}|null} the cd target, or
 *   null when the segment is not a trackable `cd` (including `cd -`).
 */
export function parseCdCommand(segment) {
  const tokens = tokenize(String(segment ?? "").trim());
  if (tokens.length === 0 || programBase(tokens[0]) !== "cd") return null;
  let i = 1;
  while (i < tokens.length && (tokens[i] === "-P" || tokens[i] === "-L" || tokens[i] === "--")) i++;
  const target = tokens[i];
  if (target === undefined) return { target: "~", indeterminate: false };
  if (target === "-") return null; // previous directory — untrackable
  return { target, indeterminate: !isConcreteRootToken(target) };
}

// ── FR4 — structured-search explicit-root policy ────────────────────────

/**
 * Govern an explicit structured-search root (the `path` parameter of the
 * native grep/find tools) BEFORE execution.
 *
 * @returns {{decision: "ELIGIBLE"|"REJECT"|"INDETERMINATE", holdCode: string|null, reason: string, normalized: string|null}}
 */
export function governStructuredRoot(root, { cwd = process.cwd(), home = homedir(), authorizedRoots = null } = {}) {
  const raw = String(root ?? "").trim();
  if (raw === "") {
    return { decision: "INDETERMINATE", holdCode: SEARCH_HOLDS.INDETERMINATE_SEARCH_ROOT, reason: "root is empty", normalized: null };
  }
  if (!isConcreteRootToken(raw)) {
    return { decision: "INDETERMINATE", holdCode: SEARCH_HOLDS.INDETERMINATE_SEARCH_ROOT, reason: "root is not statically concrete", normalized: null };
  }
  const n = normalizeSearchPath(raw, { cwd, home });
  if (!n) {
    return { decision: "INDETERMINATE", holdCode: SEARCH_HOLDS.INDETERMINATE_SEARCH_ROOT, reason: "root unparseable", normalized: null };
  }
  const cls = classifySearchRoot(n, { home });
  if (cls.forbidden) {
    return { decision: "REJECT", holdCode: cls.holdCode, reason: cls.reason, normalized: n };
  }
  const allowlist = authorizedRoots ?? [cwd];
  if (isUnderAllowlist(n, allowlist, { cwd, home })) {
    return { decision: "ELIGIBLE", holdCode: null, reason: "bounded root inside authorized scope", normalized: n };
  }
  return { decision: "REJECT", holdCode: SEARCH_HOLDS.UNBOUNDED_RECURSIVE_TRAVERSAL, reason: "root outside authorized scope", normalized: n };
}

/**
 * The governor gate (coarse). Accepts a raw shell command string and governs
 * every DIRECT recursive-search command within it. Sequential `cd` segments
 * update the effective cwd. A recursive search hidden behind indirection is
 * REJECT/RESTATE.
 */
export function governSearch(request = {}) {
  const {
    command,
    cwd = process.cwd(),
    home = homedir(),
    intent = null,
    declaration = null,
    authorizedRoots = null,
    authoritativeRoots = null,
    registry = null,
  } = request;
  const authority = authoritativeRoots ?? authorizedRoots ?? null;
  const ctx = { home, intent, declaration, authorizedRoots, authoritativeRoots: authority, registry };
  const results = [];
  let runningCwd = cwd;
  let runningCwdIndeterminate = false;

  for (const seg of splitShellSegments(String(command ?? ""))) {
    const cd = parseCdCommand(seg);
    if (cd) {
      if (cd.indeterminate) {
        runningCwdIndeterminate = true;
      } else {
        const next = normalizeSearchPath(cd.target, { cwd: runningCwd, home });
        if (next) {
          runningCwd = next;
          runningCwdIndeterminate = false;
        }
      }
      continue;
    }

    const segCtx = { ...ctx, cwd: runningCwd, cwdIndeterminate: runningCwdIndeterminate };

    // FR4 — complex indirection: REJECT/RESTATE (never reconstruct).
    const complex = classifyComplexForm(seg);
    if (complex) {
      const fp = null;
      results.push(reject(
        {
          recognized: true, family: "indirection", recursive: true, roots: [], boundaries: [],
          pattern: null, exact: false, pathArgsExplicit: false, rawPathArgs: [],
          indeterminateRoots: false, raw: seg,
        },
        fp, SEARCH_HOLDS.UNRESOLVED_EXECUTION_STRUCTURE,
        `recursive search hidden behind ${complex}: restate using an explicit bounded root or the structured find/grep tool`,
        { classification: SEARCH_CLASSIFICATIONS.NON_REWRITABLE_UNSAFE },
      ));
      continue;
    }

    const parsed = parseSearchCommand(seg, segCtx);
    if (parsed.recognized) {
      results.push(governSegment(parsed, segCtx));
    }
  }

  const rejected = results.find((r) => r.decision === "REJECT");
  if (rejected) {
    const d = {
      admit: false,
      decision: "REJECT",
      holdCode: rejected.holdCode,
      reason: rejected.reason,
      fingerprint: rejected.fingerprint,
      segments: results,
      classification: rejected.classification,
      replacement: rejected.replacement ?? null,
      wideningLevel: rejected.wideningLevel ?? null,
      authoritativeRoot: rejected.authoritativeRoot ?? null,
      exclusions: rejected.exclusions ?? [],
      replanRequired: rejected.replanRequired ?? false,
      repeatedStrategyCount: rejected.repeatedStrategyCount ?? 0,
    };
    d.telemetry = buildSearchGovernorTelemetry(request, d);
    return d;
  }

  if (results.length === 0) {
    const d = { admit: true, decision: "NOT_A_SEARCH_COMMAND", holdCode: null, reason: "no recursive search command detected", fingerprint: null, segments: [] };
    return d;
  }

  const d = {
    admit: true,
    decision: "ADMIT",
    holdCode: null,
    reason: results.map((r) => `${r.family}:${r.boundaryKind ?? "admit"}`).join("; "),
    fingerprint: results[0]?.fingerprint ?? null,
    segments: results,
    classification: SEARCH_CLASSIFICATIONS.SAFE_BOUNDED,
    replacement: null,
    wideningLevel: null,
    authoritativeRoot: null,
    exclusions: [],
    replanRequired: false,
    repeatedStrategyCount: 0,
  };
  d.telemetry = buildSearchGovernorTelemetry(request, d);
  return d;
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
