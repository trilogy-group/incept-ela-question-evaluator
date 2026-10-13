import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { repeatStatistics } from "./repeat-stats.mjs";
export const sha = (x) => crypto.createHash("sha256").update(x).digest("hex");
export function runtimeSnapshot(root, configFile) {
  const files = [];
  const visit = (dir) => { for (const ent of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, ent.name);
    if (ent.isDirectory()) visit(rel); else if (/\.(mjs|json)$/.test(ent.name)) files.push(rel);
  } };
  for (const dir of ["src", "criteria", "contracts"]) visit(dir);
  files.push("bin/evaluate.mjs");
  const records = [...new Set(files)].sort().map((rel) => ({ path: rel, sha256: sha(fs.readFileSync(path.join(root, rel))) }));
  const config = { sha256: sha(fs.readFileSync(configFile)) };
  const node_runtime = { version: process.version, versions: process.versions, platform: process.platform, arch: process.arch, executable_sha256: sha(fs.readFileSync(process.execPath)) };
  return { files: records, config, node_runtime, sha256: sha(JSON.stringify({ files: records, config, node_runtime })) };
}
const signature = (rep) => JSON.stringify({ input: rep.input, items: rep.items.map((i) => ({ id: i.id, status: i.status, checks: i.checks.map((c) => ({ id: c.id, required: c.required, verdict: c.verdict, evidence: c.evidence, p_yes: c.p_yes })) })), set: rep.set });
export function compareDraws(draws, packetHash, runtimeHash, execution) {
  if (draws.length < 2) throw new Error("full-run repeat study needs at least two draws");
  const ids = new Set(), pids = new Set();
  for (const draw of draws) {
    const e = draw.execution;
    if (!e || e.packet_sha256 !== packetHash || e.runtime_sha256 !== runtimeHash) throw new Error("draw packet or runtime mismatch");
    if (!e.invocation_id || ids.has(e.invocation_id) || !e.pid || pids.has(e.pid)) throw new Error("copied draw or reused local process record");
    ids.add(e.invocation_id); pids.add(e.pid);
  }
  const sigs = draws.map(signature);
  return { execution, draws: draws.length, completed: draws.length, frozen_packet_sha256: packetHash, runtime_sha256: runtimeHash,
    separate_local_process_records: true, identical_checks: sigs.every((x) => x === sigs[0]), check_variation: repeatStatistics(draws),
    model_calls: execution === "offline-only" ? 0 : null,
    logical_sample_calls: draws.reduce((n, d) => n + d.execution.logical_sample_calls, 0),
    precision_recall: "unmeasured; independent academic gold labels absent", pinned_served_revision_verified: false,
    meaning: execution === "offline-only" ? "deterministic offline replay consistency; no model judgment measured" : "local repeated execution observations; model serving revision unverified; no correctness qualification",
    qualified: false };
}
