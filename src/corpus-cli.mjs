// Same runner, private corpus intake and explicitly authorized development trials.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { loadCorpus, planRepresentativeScope } from "./corpus-intake.mjs";
import { checkCorpusRows } from "./corpus-checks.mjs";
import { corpusHash, runCorpusDraw, summarizeCorpusDraws, blindState } from "./corpus-study.mjs";
import { runtimeSnapshot } from "./replay.mjs";
import { judgeFromEnv } from "./engine.mjs";
import { maatGeminiFromEnv } from "./maat-gemini.mjs";
import { loadLaunchEnv, childLaunchEnv } from "./launch-env.mjs";
import { KNOWLEDGE_BASELINE } from "./knowledge-baseline.mjs";

const arg = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index > 0 ? process.argv[index + 1] : fallback; };
const write = (directory, name, value) => fs.writeFileSync(path.join(directory, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
function privateOutput(root, value) {
  const target = path.resolve(root, value);
  if (target === root || (target.startsWith(root + path.sep) && !target.startsWith(path.join(root, ".local") + path.sep))) throw new Error("corpus outputs inside the checkout must be private");
  let cursor = path.parse(target).root;
  for (const part of target.slice(cursor.length).split(path.sep)) {
    cursor = path.join(cursor, part);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error("corpus output symlinks are unsupported");
  }
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.mkdirSync(target, { mode: 0o700 });
  return target;
}

const fieldSummary = rows => ({ rows: rows.length, source_occurrences: rows.reduce((n, row) => n + row.occurrences.length, 0),
  answer_contract_checked: rows.filter(row => row.coverage.answer_contract_checked).length,
  rows_with_field_failures: rows.filter(row => row.checks.some(check => check.status === "fail")).length,
  by_status: Object.fromEntries(["pass", "fail", "flag", "unknown", "not_applicable"].map(status => [status, rows.flatMap(row => row.checks).filter(check => check.status === status).length])),
  semantic_quality: "unmeasured", meaning: "Source field constraints and cues only; exports, item quality and learner delivery are separate claims." });

function safeSolver(candidate) {
  const { state } = blindState(candidate.solver_context);
  return { question: state.question, passages: state.passages, options: Object.values(state.options), ...(state.instruction ? { instruction: state.instruction } : {}) };
}

async function child(args, env) {
  return new Promise(resolve => {
    const process = spawn(globalThis.process.execPath, args, { env, stdio: ["ignore", "ignore", "ignore"] });
    process.once("error", () => resolve(false));
    process.once("close", code => resolve(code === 0));
  });
}

export async function runCorpusCli({ root, configFile, config }) {
  const protocolFile = path.join(root, "criteria/corpus-choice-probe.json");
  const protocolBytes = fs.readFileSync(protocolFile), protocol = JSON.parse(protocolBytes);
  if (protocol.version !== 1 || protocol.qualification !== false || protocol.id !== "blind-choice-development-v1") throw new Error("invalid corpus development protocol");
  const runtime = runtimeSnapshot(root, configFile);
  const judge = arg("judge", "none"), sideJudge = arg("side-judge", "none"), mode = arg("mode", "qualified");
  if (!["none", "jev"].includes(judge) || !["none", "gemini-flash"].includes(sideJudge)) throw new Error("unsupported corpus provider");
  if ((judge !== "none" || sideJudge !== "none") && mode !== "development") throw new Error("corpus model testing requires explicit development mode; no academic scope is qualified");
  const worker = arg("corpus-worker");
  if (worker) {
    const packetBytes = fs.readFileSync(arg("corpus-packet"));
    if (corpusHash(packetBytes) !== arg("expected-corpus-packet") || runtime.sha256 !== arg("expected-runtime") || corpusHash(protocolBytes) !== arg("expected-protocol")) throw new Error("corpus frozen runtime or packet changed");
    const packet = JSON.parse(packetBytes), draw = Number(worker), primary = judge === "jev" ? await judgeFromEnv(process.env) : null,
      side = sideJudge === "gemini-flash" ? await maatGeminiFromEnv(process.env) : null;
    const controls = packet.controls.map(control => ({ candidate: packet.cases.find(candidate => candidate.id === control.id), control: control.operation }));
    if (controls.some(control => !control.candidate)) throw new Error("invalid corpus control reference");
    const out = privateOutput(root, arg("out"));
    const journal = path.join(out, "journal.jsonl");
    fs.writeFileSync(journal, "", { flag: "wx", mode: 0o600 });
    const results = await runCorpusDraw(packet.cases, { primary, side, protocol, draw, samples: config.samples, controls,
      onResult: result => fs.appendFileSync(journal, JSON.stringify(result) + "\n") });
    if (runtimeSnapshot(root, configFile).sha256 !== runtime.sha256 || corpusHash(fs.readFileSync(arg("corpus-packet"))) !== corpusHash(packetBytes)) throw new Error("corpus runtime changed during draw");
    const report = { version: 1, draw, invocation_id: crypto.randomUUID(), pid: process.pid, at: new Date().toISOString(),
      packet_sha256: corpusHash(packetBytes), runtime_sha256: runtime.sha256, protocol_sha256: corpusHash(protocolBytes),
      results, qualification: false, academic_accuracy: "unmeasured" };
    write(out, "report.json", report);
    return { draw, cases: packet.cases.length, logical_sample_calls: results.reduce((sum, row) => sum + (row.primary?.logical_sample_calls ?? 0) + (row.side?.logical_sample_calls ?? 0), 0), qualification: false };
  }
  const intake = await loadCorpus(arg("corpus"), { expectedCatalogSha256: arg("catalog-sha256") });
  const mechanical = checkCorpusRows(intake.raw_rows, { getContext: intake.getContext });
  const plan = planRepresentativeScope(intake, { perStratum: protocol.per_stratum });
  const out = privateOutput(root, arg("out", path.join(config.output_root, `corpus-${new Date().toISOString().replace(/[^0-9TZ]/g, "")}-${crypto.randomUUID().slice(0, 8)}`)));
  const fields = fieldSummary(mechanical);
  write(out, "field-checks.json", { version: 1, input: intake.hashes, summary: fields, rows: mechanical, qualification: false });
  const cases = plan.selected.map((candidate, index) => ({ id: `case-${String(index + 1).padStart(3, "0")}`, solver_context: safeSolver(candidate) }));
  const expectations = plan.selected.map((candidate, index) => ({ id: cases[index].id, corpus_id: candidate.id, authored_key: candidate.authored_key.indices,
    provenance: candidate.provenance, independence_group: candidate.independence_group, context_group: candidate.context_group,
    source_identity: candidate.source_identity, source_key_status: "unvalidated author intent; not academic gold" }));
  // Controls are separate probes. They never enlarge the number of source cases.
  const selectedForControls = cases.filter(candidate => /according to (?:the )?(?:passage|text|story)|based on (?:the )?(?:passage|text)|in (?:the )?(?:passage|text|story)/i.test(candidate.solver_context.question)).slice(0, protocol.controls.count);
  const controls = selectedForControls.flatMap(candidate => [{ id: candidate.id, operation: "duplicate_options" }, { id: candidate.id, operation: "missing_passages" }]);
  const packet = { version: 1, cases, controls }, packetBytes = JSON.stringify(packet, null, 2) + "\n";
  write(out, "solver-packet.json", packet);
  write(out, "source-keys.json", { expectations, meaning: "Compared only after model draws. No source keys enter the solver file or model request." });
  write(out, "plan.json", { version: 1, corpus_input: intake.hashes, counts: intake.counts, strata: plan.strata,
    selected_rows: plan.selected_rows, selected_clusters: plan.selected_clusters, selected_context_clusters: plan.selected_context_clusters,
    independence_status: plan.independence_status, coverage_exclusions: intake.excluded,
    selection_exclusions: plan.filtered, source_versions: intake.sources, protocol_sha256: corpusHash(protocolBytes),
    controls: controls.length, field_summary: fields, qualification: false });
  const manifest = { version: 1, corpus_catalog_sha256: intake.hashes.catalog_sha256, runtime, protocol_sha256: corpusHash(protocolBytes),
    packet_sha256: corpusHash(packetBytes), source_keys_sha256: corpusHash(fs.readFileSync(path.join(out, "source-keys.json"))),
    config: { samples: config.samples, repeats: config.repeats }, knowledge_baseline: KNOWLEDGE_BASELINE,
    mode: judge === "none" && sideJudge === "none" ? "offline" : "development", judge, side_judge: sideJudge,
    learner_exposure: "unverified; derived passage solving only", qualification: false, independent_gold_labels: 0 };
  write(out, "manifest.json", manifest);
  if (judge === "none" && sideJudge === "none") {
    write(out, "report.json", { ...manifest, field_summary: fields, selected_cases: cases.length, model_calls: 0, academic_accuracy: "unmeasured" });
    return { out: path.relative(root, out), field_summary: fields, selected_cases: cases.length, model_calls: 0, qualification: false };
  }
  const launch = loadLaunchEnv(arg("env-file")), env = childLaunchEnv(launch, { judge, sideJudge }), draws = [];
  for (let draw = 1; draw <= config.repeats; draw++) {
    const workerOut = path.join(out, `draw-${draw}`);
    const ok = await child([path.join(root, "bin/evaluate.mjs"), "--config", configFile, "--corpus-worker", String(draw),
      "--corpus-packet", path.join(out, "solver-packet.json"), "--expected-corpus-packet", manifest.packet_sha256,
      "--expected-runtime", runtime.sha256, "--expected-protocol", manifest.protocol_sha256, "--mode", "development",
      "--judge", judge, "--side-judge", sideJudge, "--out", workerOut], env);
    if (!ok) { write(out, "failure.json", { draw, reason: "development child failed; diagnostics suppressed", qualification: false }); throw new Error("corpus development child failed; inspect private failure receipt"); }
    const report = JSON.parse(fs.readFileSync(path.join(workerOut, "report.json")));
    if (report.packet_sha256 !== manifest.packet_sha256 || report.runtime_sha256 !== runtime.sha256 || report.protocol_sha256 !== manifest.protocol_sha256) throw new Error("corpus draw hashes differ");
    draws.push(report);
    console.log(JSON.stringify({ progress: "corpus_draw_complete", draw, selected_cases: cases.length, control_probes: controls.length }));
  }
  if (new Set(draws.map(draw => draw.pid)).size !== config.repeats || new Set(draws.map(draw => draw.invocation_id)).size !== config.repeats) throw new Error("corpus repeated draw process records differ");
  if (runtimeSnapshot(root, configFile).sha256 !== runtime.sha256 || corpusHash(fs.readFileSync(path.join(out, "source-keys.json"))) !== manifest.source_keys_sha256) throw new Error("corpus frozen inputs changed");
  const summary = summarizeCorpusDraws(draws, expectations);
  const logicalCalls = draws.reduce((sum, draw) => sum + draw.results.reduce((n, row) => n + (row.primary?.logical_sample_calls ?? 0) + (row.side?.logical_sample_calls ?? 0), 0), 0);
  write(out, "report.json", { ...manifest, field_summary: fields, selected_cases: cases.length, logical_sample_calls: logicalCalls,
    actual_http_or_billed_requests: "not established by logical counts", fresh_process_draws: draws.length, summary });
  return { out: path.relative(root, out), field_summary: fields, selected_cases: cases.length, draws: draws.length, logical_sample_calls: logicalCalls,
    qualification: false, academic_accuracy: "unmeasured" };
}
