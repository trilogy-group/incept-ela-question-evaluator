#!/usr/bin/env node
// Bounded privacy checks using Node only. An optional explicit name list is read but never persisted.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = process.argv.indexOf('--name-list');
let names = [];
try {
  if (arg !== -1) names = JSON.parse(fs.readFileSync(process.argv[arg + 1], 'utf8'));
  if (!Array.isArray(names) || !names.every((n) => typeof n === 'string' && n.trim())) throw new Error();
} catch { console.error('error: configured name list cannot be read or validated'); process.exit(1); }
const skip = new Set(['.git', '.local', 'node_modules', '__pycache__']);
const extensions = new Set(['.md', '.json', '.jsonl', '.mjs', '.js', '.py', '.sh']);
const patterns = [
  ['literal home path', /\/(?:Users|home)\/[^/\s"']+\//],
  ['credential-shaped value', /(?<![A-Za-z0-9_])(?:apk_[A-Za-z0-9]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{30,})/],
];
const errors = []; let scanned = 0;
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const visit = (dir) => {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(ent.name)) continue;
    const file = path.join(dir, ent.name), rel = path.relative(root, file);
    if (ent.isSymbolicLink()) { errors.push(`${rel}: unscanned symbolic link`); continue; }
    if (ent.isDirectory()) { visit(file); continue; }
    if (!ent.isFile() || !extensions.has(path.extname(file))) continue;
    scanned++;
    const text = fs.readFileSync(file, 'utf8');
    for (const [label, re] of patterns) if (re.test(text)) errors.push(`${rel}: ${label}`);
    if (names.some((n) => new RegExp(`(?<![A-Za-z])${escape(n)}(?![A-Za-z])`, 'i').test(text))) errors.push(`${rel}: configured listed name`);
  }
};
try { visit(root); } catch { console.error('error: repository enumeration or text read failed'); process.exit(1); }
if (!scanned) { console.error('error: no source files were scanned'); process.exit(1); }
for (const e of errors) console.error(`error: ${e}`);
console.log(JSON.stringify({ errors: errors.length, files_scanned: scanned, checks: ['literal_home_paths', 'credential_shaped_values'], listed_name_coverage: arg === -1 ? 'unavailable; no explicit name list supplied' : 'configured' }));
process.exit(errors.length ? 1 : 0);
