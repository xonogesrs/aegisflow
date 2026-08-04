// scripts/shared/gov-args.mjs
// Minimal argv parser for governance CLI scripts (no dependencies).
// Supports: --key value, --flag, --key=v.

export function parseArgs(argv) {
  const out = { flags: {} };
  const set = (key, value) => {
    out.flags[key] = value;
    // camelCase alias for kebab-case keys (--authority-file → authorityFile)
    if (key.includes("-")) {
      const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      out.flags[camel] = value;
    }
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq !== -1) {
      set(a.slice(2, eq), a.slice(eq + 1));
    } else {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        set(key, next);
        i++;
      } else {
        set(key, true);
      }
    }
  }
  return out;
}

export function asBool(v, def = false) {
  if (v === undefined || v === null) return def;
  if (typeof v === "boolean") return v;
  return v === "true" || v === "1" || v === "yes";
}

export function splitList(v) {
  if (v === undefined || v === null) return [];
  return String(v).split(",").map((s) => s.trim()).filter(Boolean);
}
