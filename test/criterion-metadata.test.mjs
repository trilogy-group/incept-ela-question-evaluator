import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluate } from "../src/evaluate.mjs";
import { prepareTextLesson } from "../src/text-lesson.mjs";
import { nativeFieldChecks } from "../src/native-intake.mjs";
import { loadCriterionMetadata, validateCriterionMetadata, verifySourceRecordBytes,
  validateEmittedChecks, metadataForCheck, sourceRecordMetadata } from "../src/criterion-metadata.mjs";

const json = name => JSON.parse(fs.readFileSync(new URL(name, import.meta.url)));
const clone = value => structuredClone(value);

test("actual offline native report checks all resolve without changing verdicts or academic status", async () => {
  const context = json("../fixtures/reference/lesson-context.json"), set = json("../fixtures/reference/question-set.json");
  const report = await evaluate(context, set), before = JSON.stringify(report);
  const rows = report.items.flatMap(item => item.checks.map(check => ({ check, kind: item.kind,
    stage: check.method === "judge" ? "semantic" : check.method === "context" ? "context" : "field" })));
  rows.push(...report.set.map(check => ({ check, stage: "set" })));
  const checked = validateEmittedChecks("native", rows);
  assert.ok(checked.checked > 500);
  assert.ok(checked.annotations.some(row => row.criterion_family === "word_[1-9][0-9]*_.+_(?:is|seems|wanted)_also_fits"));
  assert.equal(JSON.stringify(report), before);
  assert.equal(checked.academic_qualification, false);
  assert.equal(report.evaluator.independent_gold_labels, 0);
  assert.equal(report.status, "unverified");
});

test("actual unsupported native exposure emits source-free set scope bookkeeping and keeps it unavailable", async () => {
  const context = json("../fixtures/reference/lesson-context.json"), set = json("../fixtures/reference/question-set.json");
  set.items = [set.items.find(item => item.kind === "reading_mcq")];
  // Transport remains accepted, but the legacy interpreter cannot reconstruct this earlier page shape.
  context.native.pages[0].nodes = {};
  const report = await evaluate(context, set);
  assert.equal(report.transport.status, "accepted");
  assert.equal(report.items[0].checks[0].id, "format_coverage");
  assert.equal(report.items[0].checks[0].verdict, "unavailable");
  assert.equal(report.set.length, 1); assert.equal(report.set[0].id, "set_scope_coverage");
  const result = validateEmittedChecks("native", report.set.map(check => ({ check, stage: "set" })));
  const metadata = result.annotations[0];
  assert.equal(metadata.classification, "transport_integrity");
  assert.equal(metadata.question_quality_claim, false); assert.deepEqual(metadata.source_records, []);
  assert.equal(report.set[0].required, false); assert.equal(report.set[0].method, "context");
  assert.equal(report.set[0].verdict, "unavailable"); assert.equal(report.status, "unverified");
  assert.equal(report.evaluator.judge, null); assert.equal(report.judge_coverage.requested_criteria, 0);
  assert.equal(result.academic_qualification, false);
});

function textFixture() {
  // Arbitrary transport fields exercise executable operations; they are not academic labels.
  const text = "Rhea arrived. Sol waited.";
  const views = [
    { kind: "reading_mcq", view: { stem: "Who arrived?", options: ["Rhea", "Sol"], key: [0], option_feedback: ["Read again.", "Read again."] } },
    { kind: "evidence_select", view: { prompt: "Select one line about arriving.", candidates: ["Rhea arrived.", "Sol waited."], key: [0], selection_rule: "Choose one.", option_feedback: ["Read again.", "Read again."] } },
    { kind: "classify", view: { prompt: "Classify the named event.", entries: [{ id: "E", text: "Rhea" }], categories: [{ id: "C", label: "Arrival", description: "An arrival reported by the text." }], mapping: { E: "C" }, entry_feedback: { E: "Read again." } } },
    ...["open_check", "open_prompt"].map(kind => ({ kind, view: { prompt: "Explain one source-supported event.", sample_answer: "A proposed response.", rubric: { criteria: [{ requirement: "Explain the named event." }] } } }))
  ];
  const context = { contract: "lesson-context 0.1", source: {}, lesson: { id: "transport", keywords: [] },
    native: { pages: [{ id: "P", nodes: [{ type: "reading", blocks: [{ lines: [text] }] }], question_slots: [] }] } };
  const items = views.map(({ kind, view }, index) => {
    const native = { id: `S${index}`, type: kind, ...clone(view) }; context.native.pages[0].question_slots.push(native);
    return { id: `I${index}`, kind, page: "P", order: index + 1, pointer: `/pages/0/question_slots/${index}`, native, view,
      alignment: { target_refs: ["T"] }, source_anchors: [{ source_ref: "A", quote: "Rhea arrived.", field_ref: kind === "reading_mcq" ? "/view/stem" : "/view/prompt", relation: "limits" }] };
  });
  return { context, set: { contract: "question-set 0.1", source: {}, lesson: "transport", items },
    request: { course_context: { core_knowledge: [{ id: "T", claim: "Source-supported events.", performance: "Explain a declared event." }] },
      sequence_blueprint: items.map(() => ({ role: "practice", support: "Visible source." })) } };
}

test("actual text preparations distinguish blind, editorial and field checks across supported operations", () => {
  const plan = prepareTextLesson(textFixture()), rows = [];
  for (const item of plan.cases) {
    rows.push(...item.blind_questions.map(check => ({ check, stage: "blind", kind: item.kind })));
    rows.push(...item.editorial_questions.map(check => ({ check, stage: "editorial", kind: item.kind })));
    rows.push(...plan.fields.find(field => field.id === item.id).checks.map(check => ({ check, stage: "field", kind: item.kind })));
  }
  const result = validateEmittedChecks("text", rows);
  assert.ok(result.checked > 50);
  assert.ok(result.annotations.some(row => row.criterion_id === "rubric_covers_required_response"));
  assert.ok(result.annotations.some(row => row.criterion_id === "binding_1_faithful"));
  assert.ok(result.annotations.filter(row => row.classification === "source_bounded").every(row => row.applicability.state === "undetermined"));
  assert.ok(result.annotations.filter(row => row.classification !== "source_bounded").every(row => row.applicability.reason === "emitted_operation_integrity_only"));
  assert.equal(plan.qualification, false);
});

test("native0.2 actual field interpreters remain transport claims across response and nonresponse families", () => {
  const option = { prompt: "Choose.", options: ["A", "B"], key: [0] },
    writing = { prompt: "Respond.", sample_answer: "A proposal.", rubric: { criteria: [{ requirement: "A declared feature." }] } };
  const activities = [
    ...["single_choice", "multiple_select", "evidence_selection", "word_selection"].map(family => ({ family, view: option })),
    { family: "classification", view: { prompt: "Classify.", entries: [{ id: "E", text: "A" }], categories: [{ id: "C", label: "C", description: "A named class." }], mapping: { E: "C" } } },
    ...["written_response", "oral_response", "word_web"].map(family => ({ family, view: writing })),
    { family: "inline_choice", view: { prompt: "Complete.", blanks: [{ id: "B", options: ["A", "B"], key: 0 }] } },
    { family: "shared_cloze", view: { prompt: "Complete.", bank: [{ id: "A", text: "A" }], blanks: [{ id: "B", key: "A" }], reuse_policy: "single-use" } },
    { family: "matching", view: { prompt: "Match.", entries: [{ id: "E", text: "A" }], options: [{ id: "O", text: "B" }], mapping: { E: "O" } } },
    { family: "sequence", view: { prompt: "Order.", entries: [{ id: "E", text: "A" }], key: ["E"], ordering_rule: "Earlier first.", tie_policy: "No ties declared." } },
    { family: "say_back", view: { prompt: "Repeat.", statement: "A taught statement.", scoring: "unscored-recall" } },
    { family: "self_report", view: { prompt: "How confident?", scale: ["Low", "High"], scoring: "none" } },
    { family: "nonresponse", view: { instruction: "Read the next source." } },
    { family: "unknown-operation", view: { prompt: "A new task." } }
  ];
  const rows = activities.flatMap(item => nativeFieldChecks(item).map(check => ({ check, family: item.family, stage: "field" })));
  const result = validateEmittedChecks("native0.2", rows);
  assert.ok(result.annotations.every(row => row.classification === "transport_integrity" && !row.question_quality_claim));
  assert.ok(result.annotations.some(row => row.criterion_id === "instruction_has_no_response_key"));
  assert.ok(result.annotations.some(row => row.criterion_id === "shared_bank_reuse_obeys_rule"));
  assert.equal(result.academic_qualification, false);
});

test("changed required flags, operation scope, unknown IDs and native registry applicability fail closed", () => {
  assert.throws(() => validateEmittedChecks("native", [{ check: { id: "key_correct", method: "judge", required: false }, stage: "semantic", kind: "reading_mcq" }]), /required contract drift/);
  assert.throws(() => validateEmittedChecks("native", [{ check: { id: "one_key", method: "code", required: true }, stage: "field", kind: "open_prompt" }]), /operation scope drift/);
  assert.throws(() => validateEmittedChecks("text", [{ check: { id: "new_approval", verdict: "pass" }, stage: "blind", kind: "reading_mcq" }]), /unregistered check/);
  assert.throws(() => validateEmittedChecks("native0.2", [{ check: { id: "key_valid", required: true }, stage: "field", family: "single_choice" }]), /required field drift/);
  const registry = json("../criteria/criteria.json");
  assert.equal(validateCriterionMetadata({ nativeRegistry: registry }).academic_qualification, false);
  registry.checks.find(check => check.id === "serves_the_lesson").required = true;
  assert.throws(() => validateCriterionMetadata({ nativeRegistry: registry }), /required\/applicability\/source contract drift/);
  const changedScope = json("../criteria/criteria.json"); changedScope.checks[0].applies_to = "all";
  assert.throws(() => validateCriterionMetadata({ nativeRegistry: changedScope }), /contract drift/);
});

test("missing or altered source records and changed counterevidence cannot retain trusted provenance", () => {
  const { sourceSnapshot, catalog } = loadCriterionMetadata();
  const missing = clone(sourceSnapshot); missing.records.splice(0, 1);
  assert.throws(() => validateCriterionMetadata({ sourceSnapshot: missing }), /source record absent/);
  const altered = clone(sourceSnapshot); altered.records[0].against = "none found";
  assert.throws(() => validateCriterionMetadata({ sourceSnapshot: altered }), /differs from frozen fields/);
  assert.throws(() => verifySourceRecordBytes(new Map()), /source record absent/);
  const bytes = new Map(sourceSnapshot.records.map(record => [record.id, Buffer.from(JSON.stringify(record))]));
  assert.throws(() => verifySourceRecordBytes(bytes), /source record hash differs/);
  const overstated = clone(catalog), measurement = overstated.entries.find(entry => entry.id === "keywords_used_by_questions");
  measurement.question_quality_claim = true;
  assert.throws(() => validateCriterionMetadata({ catalog: overstated }), /quality claim exceeds/);
});

test("held or measured records do not infer purpose, resolve counterevidence or qualify a check", () => {
  const noPurpose = metadataForCheck("native", "key_correct", { stage: "semantic", kind: "reading_mcq",
    applicabilityDecision: { state: "applies", reason: "A declaration without purpose." } });
  assert.equal(noPurpose.applicability.state, "undetermined");
  const unresolved = metadataForCheck("text", "fits_declared_performance", { stage: "editorial", kind: "open_check", purpose: "practice" });
  assert.equal(unresolved.applicability.state, "undetermined");
  const declared = metadataForCheck("text", "fits_declared_performance", { stage: "editorial", kind: "open_check", purpose: "practice",
    applicabilityDecision: { state: "applies", reason: "Course owner explicitly declared this target and support." } });
  assert.equal(declared.applicability.state, "applies"); assert.equal(declared.academic_qualification, false);
  const missingOperation = metadataForCheck("native", "key_correct", { stage: "semantic", purpose: "practice",
    applicabilityDecision: { state: "applies", reason: "An assertion without an operation." } });
  assert.equal(missingOperation.applicability.state, "undetermined");
  const conflicted = metadataForCheck("text", "fits_declared_performance", { stage: "editorial", kind: "open_check", purpose: "practice",
    applicabilityDecision: { state: "applies", reason: "A premature assertion.", unresolvedConditions: ["Permitted support is unknown."] } });
  assert.equal(conflicted.applicability.state, "undetermined");
  const reveal = metadataForCheck("native", "reveal_present", { stage: "field", kind: "open_check" });
  assert.equal(reveal.source_records[0].status, "contested"); assert.equal(reveal.question_quality_claim, false);
  assert.equal(sourceRecordMetadata(reveal.source_records[0].id).conditions.binding_rule_inferred, false);
  assert.match(sourceRecordMetadata(reveal.source_records[0].id).against, /never reveals/);
  const mention = metadataForCheck("native", "keywords_used_by_questions", { stage: "set", purpose: "mastery" });
  assert.equal(mention.classification, "instrumentation"); assert.equal(mention.question_quality_claim, false);
  assert.equal(mention.applicability.state, "applies");
  assert.equal(mention.applicability.reason, "emitted_operation_integrity_only");
});

test("portable metadata loading rejects altered files and performs no implicit source refresh", () => {
  const local = loadCriterionMetadata(); assert.equal(validateCriterionMetadata().external_source_records_verified, false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "criterion-metadata-"));
  try {
    const file = path.join(dir, "source.json"); fs.writeFileSync(file, JSON.stringify({ ...local.sourceSnapshot, source_commit: "changed" }));
    assert.throws(() => loadCriterionMetadata({ sourceSnapshotFile: file }), /source snapshot file hash differs/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
