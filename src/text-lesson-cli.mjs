// Finished text lesson packages; author fields join only after frozen blind model draws.
import fs from "node:fs";
import { validateEmittedChecks } from "./criterion-metadata.mjs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { loadLessonPackage, auditLessonAlignment, digest } from "./lesson-package.mjs";
import { prepareTextLesson, runLessonDraw, summarizeTextLesson, textLessonReader, textLessonReviewPacket } from "./text-lesson.mjs";
import { runtimeSnapshot } from "./replay.mjs";
import { judgeFromEnv } from "./engine.mjs";
import { maatGeminiFromEnv } from "./maat-gemini.mjs";
import { loadLaunchEnv, childLaunchEnv } from "./launch-env.mjs";
import { prepareQuoteDiagnostics } from "./quote-diagnostics.mjs";
import { inspectSourceAssets } from "./source-assets.mjs";

const arg = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index > 0 ? process.argv[index + 1] : fallback; };
const write = (directory, name, value) => fs.writeFileSync(path.join(directory, name), typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
function privateOutput(root, value) {
  const target = path.resolve(root, value);
  if (target === root || (target.startsWith(root + path.sep) && !target.startsWith(path.join(root, ".local") + path.sep))) throw new Error("lesson output must be private");
  let cursor = path.parse(target).root;
  for (const part of target.slice(cursor.length).split(path.sep)) {
    cursor = path.join(cursor, part);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error("lesson output symlinks are unsupported");
  }
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.mkdirSync(target, { mode: 0o700 });
  return target;
}
function child(args, env) {
  return new Promise(resolve => {
    const worker = spawn(process.execPath, args, { env, stdio: ["ignore", "ignore", "ignore"] });
    worker.once("error", () => resolve(false));
    worker.once("close", code => resolve(code === 0));
  });
}
export function lessonAccounting(draws) {
  const totals = {};
  for (const draw of draws) for (const item of [...draw.results, ...(draw.sequence_review ? [{ providers: Object.fromEntries(Object.entries(draw.sequence_review.providers).map(([name, result]) => [name, { sequence: result }])) }] : [])]) for (const [name, provider] of Object.entries(item.providers)) {
    totals[name] ??= { logical_sample_calls: 0, reported_cost_samples: 0, gateway_reported_usd: 0, reported_models: [] };
    for (const phase of [provider.blind, provider.editorial, provider.sequence].filter(Boolean)) {
      totals[name].logical_sample_calls += phase.logical_sample_calls;
      for (const sample of phase.observations) {
        if (typeof sample.usage?.costInUSD === "number") {
          totals[name].reported_cost_samples++; totals[name].gateway_reported_usd += sample.usage.costInUSD;
        }
        if (sample.reported_model && !totals[name].reported_models.includes(sample.reported_model)) totals[name].reported_models.push(sample.reported_model);
      }
    }
  }
  return { providers: totals, meaning: "USD sums are gateway usage.costInUSD observations, not invoices; missing costs and adapter retries are not inferred." };
}

// Shared by text and native packages: same frozen worker, protocol, replay and cost accounting.
export async function runFrozenLessonDraws({ root, out, configFile, config, manifest, judge, sideJudge, envFile }) {
  const launch = loadLaunchEnv(envFile), env = childLaunchEnv(launch, { judge, sideJudge }), draws = [];
  for (let draw = 1; draw <= config.repeats; draw++) {
    const workerOut = path.join(out, `draw-${draw}`);
    const ok = await child([path.join(root, "bin/evaluate.mjs"), "--config", configFile, "--lesson-worker", String(draw), "--lesson-packet", path.join(out, "solver-packet.json"),
      "--expected-packet", manifest.packet_sha256, "--expected-runtime", manifest.runtime.sha256, "--expected-protocol", manifest.protocol_sha256,
      "--mode", "development", "--judge", judge, "--side-judge", sideJudge, "--out", workerOut], env);
    if (!ok) { write(out, "failure.json", { draw, reason: "lesson worker failed; private diagnostics suppressed", qualified: false }); throw new Error("lesson worker failed; inspect private receipt"); }
    const report = JSON.parse(fs.readFileSync(path.join(workerOut, "report.json")));
    if (report.packet_sha256 !== manifest.packet_sha256 || report.runtime_sha256 !== manifest.runtime.sha256 || report.protocol_sha256 !== manifest.protocol_sha256) throw new Error("lesson draw hashes differ");
    draws.push(report); console.log(JSON.stringify({ progress: "lesson_draw_complete", draw, items: report.results.length }));
  }
  if (new Set(draws.map(draw => draw.invocation_id)).size !== config.repeats || new Set(draws.map(draw => draw.pid)).size !== config.repeats) throw new Error("lesson draws reused a process record");
  if (runtimeSnapshot(root, configFile).sha256 !== manifest.runtime.sha256
    || digest(fs.readFileSync(path.join(out, "solver-packet.json"))) !== manifest.packet_sha256) throw new Error("lesson frozen runtime or packet changed");
  return draws;
}
export async function runTextLessonCli({ root, configFile, config }) {
  const protocolFile = path.join(root, "criteria/text-lesson-probe.json"), protocolBytes = fs.readFileSync(protocolFile), protocol = JSON.parse(protocolBytes);
  if (protocol.version !== 1 || protocol.qualification !== false || protocol.id !== "text-lesson-development-v1") throw new Error("unsupported lesson protocol");
  const runtime = runtimeSnapshot(root, configFile), judge = arg("judge", "none"), sideJudge = arg("side-judge", "none");
  if (!["none", "jev"].includes(judge) || !["none", "gemini-flash"].includes(sideJudge)) throw new Error("unsupported lesson provider");
  const active = judge !== "none" || sideJudge !== "none";
  if (active && arg("mode", "qualified") !== "development") throw new Error("lesson model review requires explicit development mode; no scope is qualified");
  const worker = arg("lesson-worker");
  if (worker) {
    const packetBytes = fs.readFileSync(arg("lesson-packet")), draw = Number(worker);
    if (!Number.isInteger(draw) || draw < 1 || digest(packetBytes) !== arg("expected-packet") || runtime.sha256 !== arg("expected-runtime") || digest(protocolBytes) !== arg("expected-protocol")) throw new Error("frozen lesson packet or runtime changed");
    const packet = JSON.parse(packetBytes), out = privateOutput(root, arg("out"));
    const journal = path.join(out, "journal.jsonl"); fs.writeFileSync(journal, "", { flag: "wx", mode: 0o600 });
    const primary = judge === "jev" ? await judgeFromEnv(process.env) : null, side = sideJudge === "gemini-flash" ? await maatGeminiFromEnv(process.env) : null;
    const { results, sequence_review } = await runLessonDraw(packet, { primary, side, protocol, samples: config.samples, draw,
      onResult: result => fs.appendFileSync(journal, JSON.stringify(result) + "\n") });
    if (runtimeSnapshot(root, configFile).sha256 !== runtime.sha256 || digest(fs.readFileSync(arg("lesson-packet"))) !== digest(packetBytes)) throw new Error("lesson inputs changed during draw");
    const report = { version: 1, draw, invocation_id: crypto.randomUUID(), pid: process.pid, at: new Date().toISOString(),
      packet_sha256: digest(packetBytes), runtime_sha256: runtime.sha256, protocol_sha256: digest(protocolBytes), results, sequence_review, qualified: false };
    write(out, "report.json", report);
    return { draw, items: results.length, qualified: false };
  }
  const pkg = loadLessonPackage(path.resolve(arg("lesson-package")), { coursePin: arg("course-pin") });
  const audit = auditLessonAlignment(pkg.request, pkg.set, pkg.context), plan = prepareTextLesson(pkg);
  const out = privateOutput(root, arg("out", path.join(config.output_root, `lesson-${new Date().toISOString().replace(/[^0-9TZ]/g, "")}-${crypto.randomUUID().slice(0, 8)}`)));
  const alignmentSources = validateEmittedChecks("text", audit.checks.map(check => ({ check, stage: "alignment" })));
  write(out, "criterion-sources.json", { ...plan.criterion_sources, checked: plan.criterion_sources.checked + alignmentSources.checked,
    annotations: [...plan.criterion_sources.annotations, ...alignmentSources.annotations] });
  write(out, "lesson-audit.json", { ...audit, input_hashes: pkg.hashes, external_course_pin_verified: pkg.external_course_pin_verified,
    fields: plan.fields, returned_sequence: plan.returned_sequence, sequence_flags: plan.sequence_flags });
  write(out, "quote-diagnostics.json", prepareQuoteDiagnostics(pkg, plan));
  const sourceAssets = { ...inspectSourceAssets(pkg.request, pkg.source), input_package_sha256: pkg.hashes };
  write(out, "source-assets.json", sourceAssets);
  write(out, "instructional-context.json", plan.instructional_context);
  write(out, "sequence-review-packet.json", plan.sequence_review);
  write(out, "lesson.txt", textLessonReader(pkg, plan, audit));
  const review = textLessonReviewPacket(plan);
  write(out, "review-packet.json", review);
  for (const role of ["a", "b"]) write(out, `review-${role}.json`, { packet_sha256: digest(review), reviewer: { alias: null, independent: null, prior_access: null }, ...review });
  write(out, "author-fields.json", plan.expectations);
  // No source key or producer identity enters blind calls. Candidate rubric/feedback enters ONLY separate editorial calls.
  const packet = { version: 1, cases: plan.cases, sequence_review: plan.sequence_review };
  write(out, "solver-packet.json", packet);
  const manifest = { version: 1, lesson_input_hashes: pkg.hashes, projected_hashes: plan.input,
    external_course_pin_verified: pkg.external_course_pin_verified, runtime, protocol_sha256: digest(protocolBytes),
    packet_sha256: digest(fs.readFileSync(path.join(out, "solver-packet.json"))), author_fields_sha256: digest(fs.readFileSync(path.join(out, "author-fields.json"))),
    criterion_sources_sha256: digest(fs.readFileSync(path.join(out, "criterion-sources.json"))), criterion_metadata: plan.criterion_sources.pins,
    quote_diagnostics_sha256: digest(fs.readFileSync(path.join(out, "quote-diagnostics.json"))),
    source_assets_sha256: digest(fs.readFileSync(path.join(out, "source-assets.json"))),
    instructional_context_sha256: digest(fs.readFileSync(path.join(out, "instructional-context.json"))),
    sequence_review_packet_sha256: digest(fs.readFileSync(path.join(out, "sequence-review-packet.json"))),
    source_asset_observations: sourceAssets.observation_counts,
    config: { samples: config.samples, repeats: config.repeats }, judge, side_judge: sideJudge,
    scope: plan.scope, mode: active ? "development" : "offline", qualified: false, independent_gold_labels: 0,
    response_profile: plan.response_profile,
    source_key_status: "unvalidated author intent; not academic gold", pinned_served_revision_verified: false,
    side_independence: "Flash is a separate stateless review; a Google writer and Google reviewer share a model family.",
    privacy: "Finished source/task transport only; no writer code, prompts, draft logs or selection internals read." };
  write(out, "manifest.json", manifest);
  if (!active) {
    const summary = summarizeTextLesson([], plan);
    if (audit.status === "needs_revision") summary.status = "needs_revision";
    write(out, "report.json", { ...manifest, items: plan.cases.length, model_calls: 0, alignment_status: audit.status, sequence_flags: plan.sequence_flags,
      status: summary.status, sequence_review: summary.sequence_review });
    return { out: path.relative(root, out), items: plan.cases.length, model_calls: 0, alignment_status: audit.status,
      status: summary.status, source_asset_observations: sourceAssets.observation_counts, sequence_flags: plan.sequence_flags, qualified: false };
  }
  const draws = await runFrozenLessonDraws({ root, out, configFile, config, manifest, judge, sideJudge, envFile: arg("env-file") });
  if (runtimeSnapshot(root, configFile).sha256 !== runtime.sha256 || digest(fs.readFileSync(path.join(out, "author-fields.json"))) !== manifest.author_fields_sha256) throw new Error("lesson frozen runtime or author fields changed");
  const summary = summarizeTextLesson(draws, plan), costs = lessonAccounting(draws);
  if (audit.status === "needs_revision") summary.status = "needs_revision";
  write(out, "report.json", { ...manifest, status: summary.status, alignment_status: audit.status, items: plan.cases.length, fresh_process_draws: draws.length, summary, accounting: costs });
  return { out: path.relative(root, out), items: plan.cases.length, draws: draws.length, accounting: costs, qualified: false, academic_accuracy: "unmeasured" };
}
