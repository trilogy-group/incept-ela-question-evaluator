#!/usr/bin/env node
// One standalone runner. Full repeats use fresh child processes and the same frozen, identity-stripped packet.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { evaluateProjection, markdown } from "../src/evaluate.mjs";
import { packetProjection, inputIssues } from "../src/packet.mjs";
import { judgeFromEnv } from "../src/engine.mjs";
import { runtimeSnapshot, compareDraws, sha } from "../src/replay.mjs";
import { getJudgeProfile } from "../src/judge-profile.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configFile = path.resolve(root, arg("config", "config.json"));
const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
if (config.version !== 1 || config.execution !== "offline-only") throw new Error("unsupported config");
for (const k of ["samples", "repeats"]) if (!Number.isInteger(config[k]) || config[k] < 1 || config[k] > 16) throw new Error(`invalid ${k} setting`);
if (config.repeats < 2) throw new Error("at least two full repeats are required");
const judge = arg("judge", "none");
if (!["none", "jev"].includes(judge)) throw new Error("unsupported judge adapter");
const profile = getJudgeProfile(arg("profile", "jev-partial-v1"));
const runtime = runtimeSnapshot(root, configFile);
const write = (dir, name, value) => fs.writeFileSync(path.join(dir, name), typeof value === "string" ? value : JSON.stringify(value, null, 1) + "\n", { mode: 0o600, flag: "wx" });
const makeDir = (out) => { fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 }); fs.mkdirSync(out, { mode: 0o700 }); };

if (arg("worker-draw")) {
  const packetFile = path.resolve(arg("frozen-packet"));
  const packetBytes = fs.readFileSync(packetFile), packetHash = sha(packetBytes);
  if (packetHash !== arg("expected-packet") || runtime.sha256 !== arg("expected-runtime") || profile.sha256 !== arg("expected-profile")) throw new Error("frozen packet, runtime or judge profile changed before draw");
  const packet = JSON.parse(packetBytes);
  const provider = judge === "jev" ? await judgeFromEnv() : null;
  const log = [];
  const rep = await evaluateProjection(packet.context, packet.set, { provider, samples: config.samples, log, profile: profile.id });
  if (runtimeSnapshot(root, configFile).sha256 !== runtime.sha256) throw new Error("runtime changed during draw");
  rep.execution = { invocation_id: crypto.randomUUID(), pid: process.pid, full_draw: Number(arg("worker-draw")), at: new Date().toISOString(), packet_sha256: packetHash, runtime_sha256: runtime.sha256, profile_sha256: profile.sha256, logical_sample_calls: log.reduce((n, row) => n + (row.logical_sample_calls || 0), 0) };
  const out = path.resolve(arg("out")); makeDir(out);
  write(out, "report.json", rep); write(out, "report.md", markdown(rep));
  write(out, "journal.jsonl", log.map((r) => JSON.stringify(r)).join("\n") + (log.length ? "\n" : ""));
} else {
  const context = JSON.parse(fs.readFileSync(path.resolve(root, arg("context", config.context)), "utf8"));
  const set = JSON.parse(fs.readFileSync(path.resolve(root, arg("set", config.question_set)), "utf8"));
  const issues = inputIssues(context, set);
  if (issues.length) throw new Error(`invalid public packet: ${issues.join("; ")}`);
  const packet = packetProjection(context, set);
  const runId = `review-${new Date().toISOString().replace(/[^0-9TZ]/g, "")}-${crypto.randomUUID().slice(0, 8)}`;
  const out = path.resolve(root, arg("out", path.join(config.output_root, runId))); makeDir(out);
  const packetBytes = JSON.stringify({ context: packet.context, set: packet.set }, null, 1) + "\n";
  const packetHash = sha(packetBytes); write(out, "packet.json", packetBytes);
  const manifest = { version: 1, execution: judge === "none" ? "offline-only" : "explicit-jev", qualification: "unqualified", packet_sha256: packetHash, runtime, judge_profile: profile, config: { samples: config.samples, repeats: config.repeats }, model_revision: { verified: false, reason: "an alias or unverified service observation is not a pinned immutable revision" } };
  write(out, "manifest.json", manifest);
  const draws = [];
  const childEnv = judge === "none" ? Object.fromEntries(Object.entries(process.env).filter(([k]) => !/(KEY|TOKEN|SECRET|PASSWORD)/i.test(k))) : process.env;
  for (let i = 1; i <= config.repeats; i++) {
    const dir = path.join(out, `draw-${i}`);
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--config", configFile, "--worker-draw", String(i), "--frozen-packet", path.join(out, "packet.json"), "--expected-packet", packetHash, "--expected-runtime", runtime.sha256, "--expected-profile", profile.sha256, "--profile", profile.id, "--judge", judge, "--out", dir], { env: childEnv, encoding: "utf8" });
    if (child.status !== 0) { write(out, "failure.json", { draw: i, status: child.status, reason: "child execution failed; no trust verdict produced" }); throw new Error(`draw ${i} failed: ${child.stderr || child.error?.message || "no diagnostic"}`); }
    draws.push(JSON.parse(fs.readFileSync(path.join(dir, "report.json"))));
  }
  if (runtimeSnapshot(root, configFile).sha256 !== runtime.sha256 || sha(fs.readFileSync(path.join(out, "packet.json"))) !== packetHash) throw new Error("frozen inputs changed during replay");
  const repeat = compareDraws(draws, packetHash, runtime.sha256, manifest.execution);
  write(out, "repeat.json", repeat);
  write(out, "report.json", { ...draws[0], repeat });
  write(out, "report.md", markdown(draws[0]) + `\nFull-run repeats: ${repeat.draws}; identical checks: ${repeat.identical_checks}. ${repeat.meaning}.\n`);
  console.log(JSON.stringify({ items: draws[0].items.length, counts: draws[0].counts, status: "unverified", profile: profile.id, judge_coverage: draws[0].judge_coverage, repeats: repeat.draws, identical_checks: repeat.identical_checks, model_calls: repeat.model_calls, logical_sample_calls: repeat.logical_sample_calls, qualified: false, out: path.relative(root, out) }));
}
