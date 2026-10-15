import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { prepareTextLesson, summarizeTextLesson, textLessonReviewPacket } from "../src/text-lesson.mjs";
import { nativeFieldChecks, prepareNativeIntake } from "../src/native-intake.mjs";
import { inspectSequenceReturn } from "../src/sequence-return.mjs";

// Fictional task mechanics, not academic labels or model-accuracy evidence.
function fixture(kind = "reading_mcq") {
  const view = { [kind === "reading_mcq" ? "stem" : "prompt"]: "Choose the two actions stated in the passage.",
    [kind === "reading_mcq" ? "options" : "candidates"]: ["The fox crossed.", "The hare waited.", "The owl flew."],
    response_rule: "select-n", selection_count: 2, key: [1, 0], option_feedback: ["Read the passage.", "Read the passage.", "Read the passage."] };
  const item = { id: "Q1", kind, page: "READ", order: 1, pointer: "/pages/0/question_slots/0", view,
    native: { id: "Q1", type: kind, ...structuredClone(view) }, alignment: { target_refs: ["K1"], role: "practice", support: "source-visible" }, source_anchors: [] };
  return { request: { course_context: { core_knowledge: [{ id: "K1", claim: "Identify stated actions." }] }, sequence_blueprint: [{ role: "practice", support: "source-visible" }] },
    context: { contract: "lesson-context 0.1", source: {}, lesson: { id: "TOY", keywords: [] }, native: { pages: [{ id: "READ",
      nodes: [{ type: "reading", blocks: [{ lines: ["The fox crossed. The hare waited."] }] }], question_slots: [item.native] }] } },
    set: { contract: "question-set 0.1", source: {}, made_by: { kind: "authored" }, lesson: "TOY", items: [item] } };
}
function outcome(plan, verdicts) {
  const row = plan.cases[0], draw = { sequence_review: { providers: { side: { checks: plan.sequence_review.questions.map(q => ({ id: q.id, verdict: "yes" })) } } },
    results: [{ id: row.id, providers: { side: { blind: { checks: row.blind_questions.map(q => ({ id: q.id, verdict: verdicts[q.id] ?? "yes" })) },
      editorial: { checks: row.editorial_questions.map(q => ({ id: q.id, verdict: "yes" })) } } } }] };
  return summarizeTextLesson([draw], plan).items[0].models.side.outcomes[0];
}

test("select-n keeps the explicit response count in blind choice and evidence packets without author keys", () => {
  for (const kind of ["reading_mcq", "evidence_select"]) {
    const plan = prepareTextLesson(fixture(kind)), blind = textLessonReviewPacket(plan).items[0].learner_view;
    assert.equal(blind.response_rule, "select-n"); assert.equal(blind.selection_count, 2);
    assert.equal(Object.hasOwn(blind, "key"), false);
    assert.equal(plan.cases[0].blind_questions.filter(q => q.id.startsWith("option_")).length, 3);
    assert.match(plan.cases[0].blind_questions.find(q => q.id === "answerable").instructions, /exactly 2/);
    assert.equal(plan.fields[0].checks.find(q => q.id === "key_valid").verdict, "pass");
    assert.equal(plan.qualification, false);
  }
});
test("select-n requires an explicit valid count and does not reinterpret unsupported selection rules", () => {
  for (const count of [undefined, null, "2", 0, -1, 1.5, 4, Infinity, NaN]) {
    const pkg = fixture(); pkg.set.items[0].view.selection_count = count;
    assert.throws(() => prepareTextLesson(pkg), /unsupported text selection count/);
  }
  const other = fixture(); other.set.items[0].view.response_rule = "choose-all";
  assert.throws(() => prepareTextLesson(other), /unsupported text response rule/);
  const single = fixture(); Object.assign(single.set.items[0].view, { response_rule: "single-best", key: [0], selection_count: 2 });
  assert.throws(() => prepareTextLesson(single), /unsupported text selection count/);
});
test("select-n key checks reject wrong cardinality, duplicates and out-of-range author positions", () => {
  for (const key of [[0], [0, 0], [0, 3], [0, 1, 2]]) {
    const pkg = fixture(); pkg.set.items[0].view.key = key;
    const plan = prepareTextLesson(pkg);
    assert.equal(plan.fields[0].checks.find(q => q.id === "key_valid").verdict, "fail");
    assert.equal(outcome(plan, { option_A: "yes", option_B: "yes", option_C: "no" }).author_key_agreement, null);
  }
});
test("select-n prediction compares unordered answer sets and abstains on insufficient, extra or uncertain option observations", () => {
  const plan = prepareTextLesson(fixture());
  const correct = outcome(plan, { option_A: "yes", option_B: "yes", option_C: "no" });
  assert.equal(correct.prediction_available, true); assert.equal(correct.selection_count_satisfied, true); assert.equal(correct.author_key_agreement, true);
  for (const verdicts of [
    { option_A: "yes", option_B: "no", option_C: "no" },
    { option_A: "yes", option_B: "yes", option_C: "yes" },
    { option_A: "yes", option_B: "unsure", option_C: "no" },
    { option_A: "yes", option_B: "yes", option_C: "unavailable" }
  ]) {
    const result = outcome(plan, verdicts);
    assert.equal(result.prediction_available, false); assert.equal(result.author_key_agreement, null);
  }
  const wrong = outcome(plan, { option_A: "yes", option_B: "no", option_C: "yes" });
  assert.equal(wrong.prediction_available, true); assert.equal(wrong.author_key_agreement, false);
});
test("single-best retains one-choice semantics", () => {
  const pkg = fixture(); Object.assign(pkg.set.items[0].view, { key: [0], response_rule: "single-best" }); delete pkg.set.items[0].view.selection_count;
  const plan = prepareTextLesson(pkg);
  assert.equal(plan.cases[0].blind.selection_count, 1);
  assert.equal(outcome(plan, { option_A: "yes", option_B: "no", option_C: "no" }).author_key_agreement, true);
  assert.equal(outcome(plan, { option_A: "yes", option_B: "yes", option_C: "no" }).prediction_available, false);
});

function returned(pkg, refs) {
  const plan = { version: "instructional-plan/0.1", id: "P1", lesson: { purpose: "practice", scope: "static-design", objective: "Identify actions.", goal_refs: ["K1"] },
    goal_authority: [], events: [], items: [{ item_id: "Q1", purpose: "practice", scope: "static-design", support: { mode: "none", event_refs: [], source_refs: [], answer_exposure: "withheld" },
      prior_event_refs: [], expected_evidence: [{ id: "EV1", claim: "Identify two actions." }] }], sequence: { goal_coverage: [], support_transitions: [] } };
  pkg.request.course_context.instructional_plan = plan;
  const payload = { course_context: pkg.request.course_context, student_context: null, sequence_blueprint: pkg.request.sequence_blueprint, source_provenance: null };
  const sorted = v => Array.isArray(v) ? v.map(sorted) : v !== null && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sorted(v[k])])) : v;
  const source = plan.items[0], result = { plan_id: plan.id, context_sha256: crypto.createHash("sha256").update(JSON.stringify(sorted(payload))).digest("hex"),
    lesson: plan.lesson, goal_authority: [], items: [{ item_id: "Q1", purpose: source.purpose, scope: source.scope, support: source.support, context_event_refs: [],
      expected_evidence: [{ expectation_id: "EV1", claim: source.expected_evidence[0].claim, field_refs: refs }] }], goal_coverage: [], support_transitions: [] };
  Object.assign(pkg.context.native, structuredClone(payload), { sequence_plan: structuredClone(result) }); pkg.set.sequence_plan = result;
  return pkg;
}
test("returned sequence references recognize explicit select-n count but never an answer key", () => {
  const valid = returned(fixture(), ["/view/stem", "/view/response_rule", "/view/selection_count"]);
  assert.equal(inspectSequenceReturn(valid).checks.find(q => q.id === "sequence_return_evidence_fields_resolve").verdict, "pass");
  const key = returned(fixture(), ["/view/key/0"]);
  assert.equal(inspectSequenceReturn(key).checks.find(q => q.id === "sequence_return_evidence_fields_resolve").verdict, "fail");
  const missing = fixture(); delete missing.set.items[0].view.selection_count; returned(missing, ["/view/stem"]);
  const result = inspectSequenceReturn(missing).checks.find(q => q.id === "sequence_return_evidence_fields_resolve");
  assert.equal(result.verdict, "fail"); assert(result.evidence.issues.some(q => q.code === "unsupported_response_profile"));
});
test("native explicit selection counts bind key cardinality without coercion", () => {
  const view = { prompt: "Choose two.", options: ["A", "B", "C"], key: [0, 1], selection_count: 2 };
  const check = v => nativeFieldChecks({ family: "multiple_select", view: v }).find(q => q.id === "key_valid").verdict;
  assert.equal(check(view), "pass"); assert.equal(check({ ...view, key: [0, 1, 2] }), "fail");
  for (const count of [null, "2", 0, -1, 1.5, 4]) assert.equal(check({ ...view, selection_count: count }), "fail");
});
test("native preparation retains selection count in the key-blind learner packet", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-select-count-"));
  try {
    const input = path.join(root, "input"); fs.mkdirSync(input);
    const view = { prompt: "Choose two.", options: ["Fox", "Hare", "Owl"], key: [0, 1], selection_rule: "Select exactly two.", selection_count: 2 };
    const alignment = { phase_ref: "F1", role: "question", support: "source-visible", target_refs: ["K1"], content_key_refs: [], pair_refs: [], depends_on: [] };
    const native = { id: "Q1", kind: "select_actions", family: "multiple_select", view, source_bindings: [], source_context: { id: "Q1", native_kind: "select_actions", family: "multiple_select", page_ref: "READ", ...alignment } };
    const item = { ...native, order: 1, page: "READ", pointer: "/pages/0/question_slots/0", native, alignment };
    const source = { sha256: "a".repeat(64) }, context = { contract: "lesson-context 0.1", adapter_extension: "native-activity-transport/0.2", source: { lesson_source: source }, lesson: { id: "TOY" },
      native: { course_context: { source_assets: [{ id: "S1", text: "Fox and Hare waited." }], core_knowledge: [{ id: "K1" }], lesson_plan: { phases: [{ id: "F1", role: "question", support: "source-visible", target_refs: ["K1"], source_refs: ["S1"] }] } }, pages: [{ id: "READ", nodes: [], question_slots: [native] }] } };
    const set = { contract: "question-set native 0.2", adapter_extension: context.adapter_extension, source: { lesson_source: source }, lesson: "TOY", items: [item] };
    for (const [name, value] of [["lesson-context.json", context], ["question-set.json", set]]) fs.writeFileSync(path.join(input, name), JSON.stringify(value));
    const output = path.join(root, "review"), receipt = prepareNativeIntake(input, output);
    const blind = JSON.parse(fs.readFileSync(path.join(output, "review-packet.json"))).items[0].learner_view;
    assert.equal(blind.selection_count, 2); assert.equal(Object.hasOwn(blind, "key"), false);
    assert.equal(receipt.code_failures, 0); assert.equal(receipt.model_calls, 0); assert.equal(receipt.qualified, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
