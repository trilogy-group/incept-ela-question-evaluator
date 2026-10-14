import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import { preparePilot, reconcileReviews, scorePilot, pilotHash } from "../src/review-pilot.mjs";
import { collectCriterionPackets, evaluate } from "../src/evaluate.mjs";
import { createFakeProvider } from "../src/engine.mjs";
import { KNOWLEDGE_BASELINE } from "../src/knowledge-baseline.mjs";

const read = (name) => JSON.parse(fs.readFileSync(new URL(`../fixtures/reference/${name}`, import.meta.url)));
const context = read("lesson-context.json"), set = read("question-set.json");
const baseline = { id: KNOWLEDGE_BASELINE.release, sha256: KNOWLEDGE_BASELINE.sha256 };
const source = { id: "authored-reference-3ed708e", sha256: crypto.createHash("sha256").update(fs.readFileSync(new URL("../fixtures/reference/manifest.json", import.meta.url))).digest("hex") };
const model = { provider: "pilot-mock", requested: "synthetic-pilot-model", reported: "synthetic-pilot-model" };
const prepare = (options = {}) => preparePilot(context, set, { baseline, source, ...options });
const complete = (sheets, answer = () => "yes") => structuredClone(sheets).map((sheet, i) => ({ ...sheet,
  reviewer_alias: `reviewer-${i + 1}`, independent_review_declared: true,
  rows: sheet.rows.map((row, j) => ({ ...row, verdict: answer(row, j, i), rationale: "Synthetic human response for plumbing tests only." })) }));
let serial = 0;
// Reports come from the real evaluator with a fake provider; worker identities below are test fixtures.
const draw = async (bundle, labels, rule = () => ({ noul: 1 })) => {
  const provider = bundle.model === null ? null : createFakeProvider(rule, { name: model.provider, model: model.requested });
  const report = await evaluate(context, set, { mode: "development", profile: "jev-partial-v1", provider, samples: bundle.samples });
  report.execution = { invocation_id: `synthetic-draw-${++serial}`, pid: serial, packet_sha256: bundle.bindings.packet_sha256,
    runtime_sha256: bundle.bindings.runtime_sha256, profile_sha256: bundle.bindings.profile_sha256 };
  return { report, report_sha256: pilotHash(report), labels_sha256: labels.labels_sha256 };
};
const rehash = (frozen) => { frozen.report_sha256 = pilotHash(frozen.report); return frozen; };

test("pilot uses exactly the 125 existing criterion snapshots across 13 units and creates two blank blind sheets", () => {
  const sentinel = "PRIVATE_SOURCE_OBSERVATION_SENTINEL";
  const { bundle, sheets, provenance } = prepare({ observations: [{ source_verdict: "fail", note: sentinel }] });
  const collected = collectCriterionPackets(context, set);
  assert.throws(() => collectCriterionPackets(context, set, { profile: "jev-full-experimental" }), /partial|profile|scope/);
  assert.equal(bundle.counts.criteria, 125); assert.equal(bundle.counts.units, 13);
  assert.equal(bundle.entries.filter((row) => row.kind === "classify").length, 55);
  assert.equal(bundle.entries.filter((row) => row.kind === "open_check").length, 70);
  assert.notEqual(sheets[0].sheet_id, sheets[1].sheet_id); assert.equal(sheets.length, 2);
  for (const sheet of sheets) {
    assert.equal(sheet.rows.length, 125); assert.equal(sheet.reviewer_alias, null);
    assert.equal(sheet.independent_review_declared, false);
    assert.equal(JSON.stringify(sheet).includes(sentinel), false);
    assert.equal(JSON.stringify(sheet).includes('"expect"'), false);
    assert.equal(JSON.stringify(sheet).includes('"source_verdict"'), false);
    for (const [i, row] of sheet.rows.entries()) {
      assert.equal(row.verdict, null); assert.equal(row.rationale, null);
      assert.deepEqual(row.packet, collected.entries[i].packet);
      assert.equal(row.criterion_packet_sha256, collected.entries[i].judge_packet_sha256);
      assert.match(row.learner_exposure, /unverified/);
    }
    assert.equal(sheet.bindings.baseline_sha256, baseline.sha256); assert.equal(sheet.bindings.source_sha256, source.sha256);
  }
  assert.ok(JSON.stringify(provenance).includes(sentinel)); assert.equal(bundle.qualification, "unqualified");
  assert.ok(Object.isFrozen(bundle.entries[0].packet));
  const empty = reconcileReviews(bundle, sheets);
  assert.deepEqual(empty.counts, { resolved: 0, pending: 125 });
  assert.ok(empty.labels.every((row) => row.verdict === null));
  assert.equal(empty.independent_gold, false); assert.equal(empty.held_out, false);
});

test("pilot rejects forged knowledge/source pins and changed reference packets", () => {
  assert.throws(() => prepare({ baseline: { ...baseline, sha256: "0".repeat(64) } }), /source pin mismatch/);
  assert.throws(() => prepare({ source: { ...source, sha256: "0".repeat(64) } }), /source pin mismatch/);
  const changed = structuredClone(context); changed.lesson.learning_question += " altered";
  assert.throws(() => preparePilot(changed, set, { baseline, source }), /reference packet mismatch/);
  const manifest = read("manifest.json"), changedBytes = Buffer.from(JSON.stringify(changed));
  manifest.files.find((row) => row.path.endsWith("lesson-context.json")).sha256 = crypto.createHash("sha256").update(changedBytes).digest("hex");
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const forgedSource = { ...source, sha256: crypto.createHash("sha256").update(manifestBytes).digest("hex") };
  const originalRead = fs.readFileSync;
  // Simulate coordinated local fixture/manifest corruption without writing any source file.
  fs.readFileSync = (file, ...args) => String(file).endsWith("fixtures/reference/manifest.json") ? manifestBytes
    : String(file).endsWith("fixtures/reference/lesson-context.json") ? changedBytes : originalRead(file, ...args);
  try { assert.throws(() => preparePilot(changed, set, { baseline, source: forgedSource }), /reference source hash/); }
  finally { fs.readFileSync = originalRead; }
});

test("review reconciliation keeps disagreement and unsure pending and respects negative criterion orientation", () => {
  const { bundle, sheets } = prepare();
  const reviews = complete(sheets, (_row, i, reviewer) => i === 0 ? reviewer ? "no" : "yes" : i === 1 ? "unsure" : "yes");
  const merged = reconcileReviews(bundle, reviews);
  assert.equal(merged.counts.pending, 2); assert.equal(merged.counts.resolved, 123);
  assert.equal(merged.labels[0].reason, "reviewer_disagreement"); assert.equal(merged.labels[1].reason, "reviewer_unsure");
  const negative = bundle.entries.findIndex((row) => !row.expect && row.criterion_id.endsWith("_also_fits"));
  assert.equal(merged.labels[negative].human_answer, "yes"); assert.equal(merged.labels[negative].verdict, "fail");
  const positive = bundle.entries.findIndex((row, i) => i > 1 && row.expect);
  assert.equal(merged.labels[positive].verdict, "pass");
  const adjudication = { bundle_sha256: bundle.sha256, reviews_sha256: merged.reviews_sha256,
    adjudicator_alias: "adjudicator-3", independent_review_declared: true,
    rows: [{ case_id: bundle.entries[0].case_id, verdict: "no", rationale: "Explicit synthetic adjudication." }] };
  const settled = reconcileReviews(bundle, reviews, adjudication);
  assert.equal(settled.labels[0].status, "adjudicated"); assert.equal(settled.counts.pending, 1);
  assert.equal(settled.labels[1].verdict, null);
  assert.throws(() => reconcileReviews(bundle, reviews, { ...adjudication, adjudicator_alias: "Reviewer-1" }), /adjudication scope or identity/);
  assert.throws(() => reconcileReviews(bundle, reviews, { ...adjudication, reviews_sha256: "0".repeat(64) }), /adjudication scope or identity/);
});

test("copied reviewers, altered packets and duplicated, missing or extra review rows fail closed", () => {
  const { bundle, sheets } = prepare();
  const reviews = complete(sheets);
  assert.throws(() => reconcileReviews(bundle, [reviews[0], reviews[0]]), /review sheet template/);
  const sameAlias = structuredClone(reviews); sameAlias[1].reviewer_alias = "Reviewer-1";
  assert.throws(() => reconcileReviews(bundle, sameAlias), /reviewer identity or duplicate/);
  for (const mutate of [
    (sheet) => { sheet.rows[0].packet.state.seen_before += " changed"; },
    (sheet) => { sheet.rows[0].criterion_packet_sha256 = "0".repeat(64); },
    (sheet) => { sheet.rows[1] = structuredClone(sheet.rows[0]); },
    (sheet) => { sheet.rows.pop(); },
    (sheet) => { sheet.rows.push(structuredClone(sheet.rows[0])); },
    (sheet) => { sheet.bindings.runtime_sha256 = "0".repeat(64); },
    (sheet) => { sheet.rows[0].verdict = "pass"; },
    (sheet) => { sheet.independent_review_declared = false; }
  ]) { const changed = structuredClone(reviews); mutate(changed[0]); assert.throws(() => reconcileReviews(bundle, changed), /invalid pilot/); }
});

test("actual offline evaluator reports create abstentions without fabricating labels or model accuracy", async () => {
  const { bundle, sheets } = prepare();
  const blank = reconcileReviews(bundle, sheets), frozen = await draw(bundle, blank);
  const result = scorePilot(bundle, blank, [frozen]);
  assert.deepEqual(result.counts, { distinct_criteria: 125, distinct_units: 13, resolved_labels: 0, pending_labels: 125, draws: 1, varied_criteria: 0 });
  assert.equal(result.draws[0].counts.labelled_criteria, 0); assert.equal(result.draws[0].counts.false_approvals, 0);
  assert.ok(result.repeat_variation.every((row) => row.verdicts[0] === "abstain"));
  const labelled = reconcileReviews(bundle, complete(sheets));
  const scored = scorePilot(bundle, labelled, [{ ...frozen, labels_sha256: labelled.labels_sha256 }]);
  assert.equal(scored.draws[0].counts.abstentions, 125);
  assert.equal(scored.qualification, "unqualified"); assert.equal(scored.independent_gold, false); assert.equal(scored.held_out, false);
});

test("pilot scoring counts false approvals, false rejections and repeat variation without inflating distinct cases", async () => {
  const { bundle, sheets } = prepare({ model });
  const labels = reconcileReviews(bundle, complete(sheets));
  const yes = await draw(bundle, labels, () => ({ noul: 1 }));
  const no = await draw(bundle, labels, () => ({ noul: 0 }));
  const scored = scorePilot(bundle, labels, [yes, no]);
  const positive = bundle.entries.filter((row) => row.expect).length, negative = bundle.entries.length - positive;
  assert.equal(scored.draws[0].counts.correct_approvals, positive); assert.equal(scored.draws[0].counts.correct_rejections, negative);
  assert.equal(scored.draws[1].counts.false_rejections, positive); assert.equal(scored.draws[1].counts.false_approvals, negative);
  assert.equal(scored.counts.distinct_criteria, 125); assert.equal(scored.counts.varied_criteria, 125);
  assert.ok(scored.draws.every((row) => row.snapshot_differs_from_actual_request > 0));
});

test("scoring rejects changed labels, snapshots, input, build, model and copied report identities", async () => {
  const { bundle, sheets } = prepare({ model }), labels = reconcileReviews(bundle, complete(sheets));
  const original = await draw(bundle, labels);
  const changedLabels = structuredClone(labels); changedLabels.labels[0].verdict = "fail";
  assert.throws(() => scorePilot(bundle, changedLabels, [original]), /reconciliation hash/);
  assert.throws(() => scorePilot(bundle, labels, [{ ...original, labels_sha256: "0".repeat(64) }]), /changed labels/);
  assert.throws(() => scorePilot(bundle, labels, [original, original]), /duplicate or incomplete draw identity/);
  for (const mutate of [
    (r) => { r.execution.runtime_sha256 = "0".repeat(64); },
    (r) => { r.execution.packet_sha256 = "0".repeat(64); },
    (r) => { r.execution.profile_sha256 = "0".repeat(64); },
    (r) => { r.evaluator.knowledge_baseline.sha256 = "0".repeat(64); },
    (r) => { r.input.context_projection_sha256 = "0".repeat(64); },
    (r) => { r.evaluator.judge.model = "changed-model"; },
    (r) => { r.items.find((item) => item.judge)?.judge.serving_observations.forEach((o) => { o.model = "changed-model"; }); },
    (r) => { const item = r.items.find((it) => it.kind === "classify"); item.checks.find((c) => c.method === "judge").criterion_packet_sha256 = "0".repeat(64); },
    (r) => { const item = r.items.find((it) => it.kind === "classify"); item.checks.push(structuredClone(item.checks.find((c) => c.method === "judge"))); }
  ]) {
    const changed = structuredClone(original); mutate(changed.report);
    assert.throws(() => scorePilot(bundle, labels, [rehash(changed)]), /invalid pilot/);
  }
  const corrupted = structuredClone(original); corrupted.report.items[0].status = "corrupted";
  assert.throws(() => scorePilot(bundle, labels, [corrupted]), /frozen report/);
  const copiedIdentity = structuredClone(original); copiedIdentity.report.execution.invocation_id = "new-file-same-process";
  assert.throws(() => scorePilot(bundle, labels, [original, rehash(copiedIdentity)]), /duplicate or incomplete draw identity/);
});

test("incomplete or uncertain evaluator outcomes stay abstentions even when surviving samples agree", async () => {
  const { bundle, sheets } = prepare({ model }), labels = reconcileReviews(bundle, complete(sheets));
  const unsure = await draw(bundle, labels, () => ({ noul: 0.5 }));
  const incomplete = await draw(bundle, labels, (_q, _s, { sample }) => {
    if (sample === 2) throw new Error("synthetic missing sample"); return { noul: 1 };
  });
  const scored = scorePilot(bundle, labels, [unsure, incomplete]);
  assert.ok(scored.draws.every((row) => row.counts.abstentions === 125));
  assert.equal(scored.counts.varied_criteria, 0);
});

test("persisted label consistency and successful serving evidence are required even with matching envelope hashes", async () => {
  const { bundle, sheets } = prepare({ model }), labels = reconcileReviews(bundle, complete(sheets));
  const original = await draw(bundle, labels);
  const unavailable = structuredClone(original);
  unavailable.report.items.filter((item) => item.judge).forEach((item) => { item.judge.serving_observations = [{ unavailable: true }]; });
  const scored = scorePilot(bundle, labels, [rehash(unavailable)]);
  assert.equal(scored.draws[0].counts.abstentions, 125);
  const negative = labels.labels.findIndex((row, i) => !bundle.entries[i].expect);
  const changed = structuredClone(labels);
  Object.assign(changed.labels[negative], { human_answer: "unsure", verdict: "pass", status: "pending" });
  changed.labels_sha256 = pilotHash(changed.labels);
  const { sha256: unused, ...body } = changed; changed.sha256 = pilotHash(body);
  assert.throws(() => scorePilot(bundle, changed, [{ ...original, labels_sha256: changed.labels_sha256 }]), /label orientation/);
  const wrongCounts = structuredClone(labels); wrongCounts.counts.resolved = 0;
  const { sha256: unusedCount, ...countBody } = wrongCounts; wrongCounts.sha256 = pilotHash(countBody);
  assert.throws(() => scorePilot(bundle, wrongCounts, [original]), /label counts/);
});
