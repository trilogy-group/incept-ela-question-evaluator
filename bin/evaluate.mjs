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
import { loadQualification, loadTrustedReviewers } from "../src/qualification.mjs";
import { loadLaunchEnv, childLaunchEnv } from "../src/launch-env.mjs";
import { maatGeminiFromEnv } from "../src/maat-gemini.mjs";
import { reviewSideProjection, compareSide } from "../src/side-review.mjs";
import { reviewStrictProjection } from "../src/strict-review.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (arg("native-package")) {
  const { runNativeIntakeCli } = await import("../src/native-intake.mjs");
  console.log(JSON.stringify(runNativeIntakeCli({ root })));
  process.exit(0);
}
if (arg("golden-reference") || arg("golden-check")) {
  const { runGoldenCli } = await import("../src/golden-cli.mjs");
  console.log(JSON.stringify(runGoldenCli({ root })));
  process.exit(0);
}
const configFile = path.resolve(root, arg("config", "config.json"));
const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
if (config.version !== 1 || config.execution !== "offline-only") throw new Error("unsupported config");
for (const k of ["samples", "repeats"]) if (!Number.isInteger(config[k]) || config[k] < 1 || config[k] > 16) throw new Error(`invalid ${k} setting`);
if (config.repeats < 2) throw new Error("at least two full repeats are required");
if (arg("lesson-package") || arg("lesson-worker")) {
  const { runTextLessonCli } = await import("../src/text-lesson-cli.mjs");
  console.log(JSON.stringify(await runTextLessonCli({ root, configFile, config })));
  process.exit(0);
}
if (arg("corpus") || arg("corpus-worker")) {
  const { runCorpusCli } = await import("../src/corpus-cli.mjs");
  console.log(JSON.stringify(await runCorpusCli({ root, configFile, config })));
  process.exit(0);
}
if (arg("review")) {
  const { runReviewCli } = await import("../src/review-cli.mjs");
  const result = await runReviewCli({ root, configFile, config });
  console.log(JSON.stringify(result));
  process.exit(0);
}
const judge = arg("judge", "none");
if (!["none", "jev"].includes(judge)) throw new Error("unsupported judge adapter");
const sideJudge = arg("side-judge", "none");
if (!["none", "gemini-flash"].includes(sideJudge)) throw new Error("unsupported side judge adapter");
const launchEnv = arg("worker-draw") ? process.env : loadLaunchEnv(arg("env-file"));
const mode = arg("mode", "qualified");
if (!["qualified", "development"].includes(mode)) throw new Error("unsupported evaluation mode");
const profile = getJudgeProfile(arg("profile", mode === "qualified" ? "jev-qualified-v1" : "jev-partial-v1"));
if ((mode === "qualified") !== (profile.id === "jev-qualified-v1")) throw new Error("judge profile does not match evaluation mode");
const runtime = runtimeSnapshot(root, configFile);
const strictSamples = arg("strict-samples") === "true";
const write = (dir, name, value) => fs.writeFileSync(path.join(dir, name), typeof value === "string" ? value : JSON.stringify(value, null, 1) + "\n", { mode: 0o600, flag: "wx" });
const makeDir = (out) => { fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 }); fs.mkdirSync(out, { mode: 0o700 }); };

if (arg("worker-draw")) {
  const packetFile = path.resolve(arg("frozen-packet"));
  const packetBytes = fs.readFileSync(packetFile), packetHash = sha(packetBytes);
  if (packetHash !== arg("expected-packet") || runtime.sha256 !== arg("expected-runtime") || profile.sha256 !== arg("expected-profile")) throw new Error("frozen packet, runtime or judge profile changed before draw");
  const packet = JSON.parse(packetBytes);
  const evidenceFile = path.resolve(arg("frozen-qualification"));
  if (sha(fs.readFileSync(evidenceFile)) !== arg("expected-qualification")) throw new Error("frozen qualification evidence changed before draw");
  const qualification = loadQualification(evidenceFile);
  const trustFile = path.resolve(arg("frozen-trust"));
  if (sha(fs.readFileSync(trustFile)) !== arg("expected-trust")) throw new Error("frozen reviewer trust changed before draw");
  const trustedReviewers = loadTrustedReviewers(trustFile);
  const log = [];
  const review = strictSamples ? reviewStrictProjection : evaluateProjection;
  const rep = await review(packet.context, packet.set, { providerFactory: judge === "jev" ? () => judgeFromEnv(launchEnv) : null, model: launchEnv.TYPESAFE_MODEL || "jev-latest", samples: config.samples, log, profile: profile.id, mode, qualification, trustedReviewers, configFile });
  const sideLog = [];
  if (sideJudge === "gemini-flash") {
    rep.side = strictSamples ? await reviewStrictProjection(packet.context, packet.set, { providerFactory: () => maatGeminiFromEnv(launchEnv), model: launchEnv.GEMINI_FLASH_MODEL || "gemini-group/gemini-3.8-flash", samples: config.samples, log: sideLog, configFile, mode: "development", profile: "jev-full-experimental", role: "side" })
      : await reviewSideProjection(packet.context, packet.set, { providerFactory: () => maatGeminiFromEnv(launchEnv), model: launchEnv.GEMINI_FLASH_MODEL || "gemini-group/gemini-3.8-flash", samples: config.samples, log: sideLog, configFile });
    rep.side_comparison = compareSide(rep, rep.side);
  }
  if (runtimeSnapshot(root, configFile).sha256 !== runtime.sha256) throw new Error("runtime changed during draw");
  const primaryCalls = log.reduce((n, row) => n + (row.logical_sample_calls || 0), 0), sideCalls = sideLog.reduce((n, row) => n + (row.logical_sample_calls || 0), 0);
  rep.execution = { invocation_id: crypto.randomUUID(), pid: process.pid, full_draw: Number(arg("worker-draw")), at: new Date().toISOString(), packet_sha256: packetHash, runtime_sha256: runtime.sha256, profile_sha256: profile.sha256, qualification_sha256: qualification.sha256, trusted_reviewers_sha256: trustedReviewers.sha256, mode, logical_sample_calls: primaryCalls, side_logical_sample_calls: sideCalls };
  if (rep.side) rep.side.execution = { ...rep.execution, invocation_id: crypto.randomUUID(), profile_sha256: rep.side.evaluator.judge_profile.sha256, qualification_sha256: rep.side.evaluator.qualification_registry_sha256, trusted_reviewers_sha256: rep.side.evaluator.trusted_reviewers_sha256, mode: rep.side.evaluator.mode, logical_sample_calls: sideCalls };
  const out = path.resolve(arg("out")); makeDir(out);
  write(out, "report.json", rep); write(out, "report.md", markdown(rep));
  write(out, "journal.jsonl", log.map((r) => JSON.stringify(r)).join("\n") + (log.length ? "\n" : ""));
  if (rep.side) {
    write(out, "side-report.json", rep.side);
    write(out, "side-journal.jsonl", sideLog.map((r) => JSON.stringify(r)).join("\n") + (sideLog.length ? "\n" : ""));
  }
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
  const qualification = loadQualification(path.resolve(root, arg("qualification", config.qualification_file || ".local/qualification/jev.json")));
  const evidenceBytes = JSON.stringify(qualification, null, 1) + "\n", evidenceHash = sha(evidenceBytes);
  write(out, "qualification.json", evidenceBytes);
  const trustedReviewers = loadTrustedReviewers(path.resolve(root, arg("trusted-reviewers", config.trusted_reviewers_file || ".local/qualification/trusted-reviewers.json")));
  const trustBytes = JSON.stringify(trustedReviewers, null, 1) + "\n", trustHash = sha(trustBytes);
  write(out, "trusted-reviewers.json", trustBytes);
  const execution = sideJudge === "none" ? judge === "none" ? "offline-only" : "explicit-jev" : judge === "none" ? "explicit-side-evaluation" : "explicit-jev-and-side";
  const manifest = { version: 1, execution, mode, strict_sample_veto: strictSamples, side_judge: sideJudge, side_accuracy: sideJudge === "none" ? null : "unmeasured; development signal only", credential_source: arg("env-file") ? "explicit env file; contents excluded from artifacts" : "launch environment", qualification: "unqualified", qualification_registry_sha256: qualification.sha256, frozen_qualification_sha256: evidenceHash, trusted_reviewers_sha256: trustedReviewers.sha256, frozen_trust_sha256: trustHash, packet_sha256: packetHash, runtime, judge_profile: profile, config: { samples: config.samples, repeats: config.repeats }, model_revision: { verified: false, reason: "an alias or unverified service observation is not a pinned immutable revision" } };
  write(out, "manifest.json", manifest);
  const draws = [];
  const childEnv = childLaunchEnv(launchEnv, { judge, sideJudge });
  for (let i = 1; i <= config.repeats; i++) {
    const dir = path.join(out, `draw-${i}`);
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--config", configFile, "--strict-samples", String(strictSamples), "--worker-draw", String(i), "--frozen-packet", path.join(out, "packet.json"), "--expected-packet", packetHash, "--expected-runtime", runtime.sha256, "--frozen-qualification", path.join(out, "qualification.json"), "--expected-qualification", evidenceHash, "--frozen-trust", path.join(out, "trusted-reviewers.json"), "--expected-trust", trustHash, "--expected-profile", profile.sha256, "--profile", profile.id, "--mode", mode, "--judge", judge, "--side-judge", sideJudge, "--out", dir], { env: childEnv, encoding: "utf8" });
    if (child.status !== 0) { write(out, "failure.json", { draw: i, status: child.status, reason: "child execution failed; no trust verdict produced" }); throw new Error(`draw ${i} failed; child diagnostics suppressed`); }
    draws.push(JSON.parse(fs.readFileSync(path.join(dir, "report.json"))));
  }
  if (runtimeSnapshot(root, configFile).sha256 !== runtime.sha256 || sha(fs.readFileSync(path.join(out, "packet.json"))) !== packetHash || sha(fs.readFileSync(path.join(out, "qualification.json"))) !== evidenceHash || sha(fs.readFileSync(path.join(out, "trusted-reviewers.json"))) !== trustHash) throw new Error("frozen inputs changed during replay");
  const repeat = compareDraws(draws, packetHash, runtime.sha256, manifest.execution);
  const sideRepeat = sideJudge === "none" ? null : compareDraws(draws.map((r) => r.side), packetHash, runtime.sha256, "explicit-maat-gemini-flash");
  write(out, "repeat.json", repeat);
  if (sideRepeat) write(out, "side-repeat.json", sideRepeat);
  write(out, "report.json", { ...draws[0], repeat, ...(sideRepeat ? { side_repeat: sideRepeat } : {}) });
  write(out, "report.md", markdown(draws[0]) + `\nFull-run repeats: ${repeat.draws}; identical checks: ${repeat.identical_checks}. ${repeat.meaning}.\n` + (sideRepeat ? `\nGemini Flash side signal: ${draws[0].side_comparison.counts.comparable_pairs} comparable criteria, ${draws[0].side_comparison.counts.disagreements} disagreements. Accuracy is unmeasured; primary verdicts remain unchanged. Side repeats: ${sideRepeat.draws}.\n` : ""));
  console.log(JSON.stringify({ items: draws[0].items.length, counts: draws[0].counts, status: "unverified", mode, profile: profile.id, judge_coverage: draws[0].judge_coverage, repeats: repeat.draws, identical_checks: repeat.identical_checks, model_calls: sideRepeat?.logical_sample_calls ? null : repeat.model_calls, logical_sample_calls: repeat.logical_sample_calls + (sideRepeat?.logical_sample_calls || 0), primary_logical_sample_calls: repeat.logical_sample_calls, side_logical_sample_calls: sideRepeat?.logical_sample_calls || 0, side: draws[0].side_comparison?.counts || null, qualified: false, out: path.relative(root, out) }));
}
