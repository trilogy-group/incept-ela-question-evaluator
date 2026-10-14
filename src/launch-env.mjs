// Explicit, nonexecuting launch-file input. Only adapter settings cross this boundary.
import fs from "node:fs";

const PORTABLE_CHILD_KEYS = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "TEMP", "TMP", "SystemRoot", "SYSTEMROOT"];
const JEV_KEYS = ["TYPESAFE_API_KEY", "TYPESAFE_MODEL"];
const GEMINI_KEYS = ["MAAT_API_TOKEN", "TFY_API_KEY", "TFY_INDIVIDUAL_TOKEN", "TFY_GATEWAY_URL", "GEMINI_FLASH_MODEL"];
const ALLOWED = new Set([...JEV_KEYS, ...GEMINI_KEYS]);

const invalid = () => { throw new TypeError("invalid launch environment file"); };
const LINE_BREAK = /[\r\n\u2028\u2029]/;

function valueOf(raw) {
  const text = raw.trimStart();
  if (LINE_BREAK.test(text) || text.includes("\0")) invalid();
  if (!text || text.startsWith("#")) return null;
  if (text[0] === "'" || text[0] === '"') {
    const quote = text[0];
    let value = "", end = -1;
    for (let i = 1; i < text.length; i++) {
      const char = text[i];
      if (char === "\\" && (text[i + 1] === quote || text[i + 1] === "\\")) {
        value += text[++i];
      } else if (char === quote) {
        end = i;
        break;
      } else {
        value += char;
      }
    }
    if (end < 0 || !/^(?:\s*|\s*#.*)$/.test(text.slice(end + 1))) invalid();
    return value.trim() ? value : null;
  }
  const value = text.replace(/\s+#.*$/, "").trimEnd();
  if (/['"\0]/.test(value) || value.endsWith("\\")) invalid();
  return value || null;
}

/** Read only the named file; its values never run as shell code or enter reports. */
export function loadLaunchEnv(file, baseEnv = process.env) {
  const env = { ...baseEnv };
  if (file === undefined || file === null) return env;
  if (typeof file !== "string" || !file) invalid();
  let source;
  try { source = fs.readFileSync(file, "utf8"); }
  catch { throw new TypeError("launch environment file unavailable"); }
  for (const rawLine of source.replace(/^\uFEFF/, "").split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (/^\s*(?:#|$)/.test(line)) continue;
    let body = line.trimStart();
    if (/^export\s+/.test(body)) body = body.replace(/^export\s+/, "");
    const field = /^([A-Za-z_][A-Za-z0-9_]*)([\s\S]*)$/.exec(body);
    if (!field || !ALLOWED.has(field[1])) continue;
    if (LINE_BREAK.test(line)) invalid();
    const assignment = /^\s*=([\s\S]*)$/.exec(field[2]);
    if (!assignment) invalid();
    const value = valueOf(assignment[1]);
    if (value !== null && (typeof env[field[1]] !== "string" || !env[field[1]].trim())) env[field[1]] = value;
  }
  return env;
}

/** Pass only ordinary runtime settings and credentials required by explicitly selected adapters. */
export function childLaunchEnv(baseEnv, { judge = "none", sideJudge = "none" } = {}) {
  if (!baseEnv || typeof baseEnv !== "object" || Array.isArray(baseEnv) ||
      !["none", "jev"].includes(judge) || !["none", "gemini-flash"].includes(sideJudge)) {
    throw new TypeError("invalid child launch environment");
  }
  const keys = [...PORTABLE_CHILD_KEYS];
  if (judge === "jev") keys.push(...JEV_KEYS);
  if (sideJudge === "gemini-flash") keys.push(...GEMINI_KEYS);
  const child = {};
  for (const key of keys) if (Object.hasOwn(baseEnv, key) && typeof baseEnv[key] === "string") child[key] = baseEnv[key];
  return child;
}
