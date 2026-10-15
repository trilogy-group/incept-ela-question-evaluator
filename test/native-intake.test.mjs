import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { prepareNativeIntake, nativeFieldChecks, runNativeIntakeCli, verifyNativePreparation } from "../src/native-intake.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-intake-")), input = path.join(root, "finished"); fs.mkdirSync(input);
  const pin = "a".repeat(64), source = { sha256: pin, commit: "b".repeat(40) };
  const views = [
    { kind: "reading_mcq", family: "single_choice", view: { prompt: "Who crossed the river?", options: ["Fox", "Hare"], key: [0], correct_feedback: "Fox crossed.", hidden_new_solution: "Fox" } },
    { kind: "rebuild_choice", family: "inline_choice", view: { prompt: "Complete the taught sentence.", surrounding_text: "The [blank] crossed.", blanks: [{ id: "B1", options: ["Fox", "Hare"], key: 0, option_feedback: ["Yes", "No"], hidden_new_solution: "Fox" }] } },
    { kind: "quote_word_selection", family: "word_selection", view: { prompt: "Choose an action word.", options: ["Fox", "crossed"], key: [1], word_classes: { 1: "verb" } } }
  ];
  const items = views.map((row, index) => {
    const native = { ...row, id: `N${index + 1}` };
    native.source_context = { id: native.id, native_kind: native.kind, family: native.family, page_ref: "READ", phase_ref: `F${index + 1}`,
      role: index === 1 ? "recall_task" : "question", target_refs: ["K1"], content_key_refs: [], pair_refs: [], depends_on: [], support: "Visible passage." };
    native.source_bindings = [{ source_ref: "S1", field_ref: "/view/prompt", quote: "Fox crossed", relation: "Authored assertion; review needed." }];
    return { ...native, order: index + 1, page: "READ", pointer: `/pages/0/question_slots/${index}`, native,
      alignment: { phase_ref: `F${index + 1}`, role: native.source_context.role, target_refs: ["K1"], content_key_refs: [], pair_refs: [], depends_on: [], support: "Visible passage." },
      source_bindings: native.source_bindings };
  });
  const context = { contract: "lesson-context 0.1", adapter_extension: "native-activity-transport/0.2", lesson: { id: "L1" },
    source: { lesson_source: source, producer: "Never include this producer in review." }, native: { course_context: { source_assets: [{ id: "S1", kind: "passage", text: "Fox crossed the river." }, { id: "FUTURE", kind: "passage", text: "A future-only answer must stay absent." }],
      core_knowledge: [{ id: "K1", claim: "Identify the action in the passage." }], lesson_plan: { phases: items.map(item => ({ id: item.alignment.phase_ref, exposure_order: item.order, source_refs: ["S1"], target_refs: ["K1"], role: item.alignment.role, support: "Visible passage." })) } },
      pages: [{ id: "READ", nodes: [], question_slots: items.map(item => item.native) }] } };
  const set = { contract: "question-set native 0.2", adapter_extension: context.adapter_extension, lesson: "L1", source: { lesson_source: source }, items };
  const save = () => { fs.writeFileSync(path.join(input, "lesson-context.json"), JSON.stringify(context)); fs.writeFileSync(path.join(input, "question-set.json"), JSON.stringify(set)); };
  save(); return { root, input, context, set, pin, save, dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
}
test("native intake keeps exact finished files and withholds keys, feedback, word classes and unknown teacher fields", () => {
  const f = fixture(); try {
    const out = path.join(f.root, "review"), before = fs.readFileSync(path.join(f.input, "question-set.json"));
    const receipt = prepareNativeIntake(f.input, out, { sourcePin: f.pin });
    assert.equal(receipt.activities, 3); assert.equal(receipt.code_failures, 0); assert.equal(receipt.model_calls, 0); assert.equal(receipt.qualified, false);
    assert.deepEqual(fs.readFileSync(path.join(out, "question-set.json")), before);
    const review = JSON.parse(fs.readFileSync(path.join(out, "review-packet.json"))), serialized = JSON.stringify(review);
    for (const forbidden of ["hidden_new_solution", "option_feedback", "correct_feedback", "word_classes", '"key"', "Never include this producer", "future-only answer"]) assert.ok(!serialized.includes(forbidden));
    assert.equal(review.items[1].learner_view.blanks[0].options.length, 2);
    assert.equal(review.items[2].learner_view.options[1], "crossed");
    assert.deepEqual(review.items[2].earlier_activity_ids, review.items.slice(0, 2).map(row => row.id));
    assert.equal(review.items[0].review.independently_expected_response, null);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, "author-fields.json"))).items[0].view.key, [0]);
  } finally { f.dispose(); }
});
test("native intake rejects mismatched pins, copied native fields and absent phase context before writing a review", () => {
  const f = fixture(); try {
    const out = path.join(f.root, "review");
    assert.throws(() => prepareNativeIntake(f.input, out, { sourcePin: "c".repeat(64) }), /external source pin/);
    f.set.items[0].view = { ...f.set.items[0].view, options: ["Different", "Choices"] }; f.save();
    assert.throws(() => prepareNativeIntake(f.input, out), /native pointer/);
    f.set.items[0].view = f.context.native.pages[0].question_slots[0].view;
    f.context.native.course_context.lesson_plan.phases[0].source_refs = ["absent"]; f.save();
    assert.throws(() => prepareNativeIntake(f.input, out), /absent source/);
    assert.equal(fs.existsSync(out), false);
  } finally { f.dispose(); }
});
test("classification emptiness, invalid inline keys and correctness-graded confidence reports remain faults", () => {
  const failures = item => nativeFieldChecks(item).filter(row => row.verdict === "fail").map(row => row.id);
  assert.ok(failures({ family: "classification", view: { prompt: "Classify.", entries: [], categories: [], mapping: {} } }).includes("entries_present"));
  assert.ok(failures({ family: "inline_choice", view: { prompt: "Choose.", blanks: [{ id: "B1", options: ["A", "B"], key: 2 }] } }).includes("blank_keys_valid"));
  assert.ok(failures({ family: "self_report", view: { prompt: "How confident?", scale: ["No", "Yes"], scoring: "correctness" } }).includes("report_is_not_correctness_grade"));
  assert.ok(failures({ family: "uninterpreted", view: { prompt: "New task." } }).includes("family_field_interpreter_available"));
  assert.ok(failures({ family: "shared_cloze", view: { prompt: "Fill the blanks.", bank: [{ id: "B1", text: "Fox" }], blanks: [{ id: "A1", key: "B1" }, { id: "A2", key: "B1" }], reuse_policy: "single-use" } }).includes("shared_bank_reuse_obeys_rule"));
  assert.ok(failures({ family: "matching", view: { prompt: "Match.", entries: [{ id: "E1", text: "Fox" }], options: [{ id: "O1", text: "Crossed" }], mapping: { E1: "ABSENT" } } }).includes("matching_mapping_valid"));
  assert.ok(failures({ family: "sequence", view: { prompt: "Order.", entries: [{ id: "E1", text: "First" }, { id: "E2", text: "Second" }], key: ["E1", "E1"], ordering_rule: "Event order", tie_policy: "No ties" } }).includes("sequence_key_is_permutation"));
  assert.ok(failures({ family: "nonresponse", view: { instruction: "Worked teaching.", key: [0] } }).includes("instruction_has_no_response_key"));
});
test("native identity, declared alignment and source bindings cannot be detached from their native task", () => {
  for (const [mutate, message] of [
    [f => { f.set.items[0].id = "DETACHED"; }, /native pointer/],
    [f => { f.set.items[0].alignment.role = "self_report"; }, /role or support/],
    [f => { f.set.items[0].alignment.target_refs = ["ABSENT"]; }, /target_refs/],
    [f => { f.set.items[0].alignment.depends_on = ["N3"]; }, /dependency/],
    [f => { f.set.items[0].source_bindings = []; }, /source bindings/],
    [f => { f.context.native.course_context.lesson_plan.phases[0].support = { teacher_key: [0] }; }, /role or support/]
  ]) {
    const f = fixture(); try {
      mutate(f); f.save(); const out = path.join(f.root, "review");
      assert.throws(() => prepareNativeIntake(f.input, out), message); assert.equal(fs.existsSync(out), false);
    } finally { f.dispose(); }
  }
});
test("native intake uses private outputs and cannot silently launch a judge", () => {
  const f = fixture(); try {
    assert.throws(() => runNativeIntakeCli({ root: f.root, argv: ["--native-package", f.input, "--out", "public"] }), /private/);
    assert.throws(() => runNativeIntakeCli({ root: f.root, argv: ["--native-package", f.input, "--judge", "jev"] }), /development mode/);
    assert.equal(runNativeIntakeCli({ root: f.root, argv: ["--native-package", f.input, "--native-source-pin", f.pin, "--out", ".local/review"] }).model_calls, 0);
  } finally { f.dispose(); }
});
test("source and media metadata cannot inject teacher-key objects into a blind review packet", () => {
  for (const field of ["kind", "text", "media_ref", "time_range", "source_status"]) {
    const f = fixture(); try {
      f.context.native.course_context.source_assets[0][field] = { teacher_key: [0], teacher_feedback: "The author answer." }; f.save();
      const out = path.join(f.root, "review"); assert.throws(() => prepareNativeIntake(f.input, out), /invalid/); assert.equal(fs.existsSync(out), false);
    } finally { f.dispose(); }
  }
});
test("a selected task sequence retains source phase order without confusing it with local item order", () => {
  const f = fixture(); try {
    for (const phase of f.context.native.course_context.lesson_plan.phases) { phase.exposure_order += 10; phase.role = "broader instruction phase"; delete phase.support; }
    delete f.context.native.course_context.source_assets[0].kind; f.save();
    const out = path.join(f.root, "review"), receipt = prepareNativeIntake(f.input, out);
    assert.equal(receipt.code_failures, 0);
    const cases = JSON.parse(fs.readFileSync(path.join(out, "review-packet.json"))).items;
    assert.equal(cases[0].declared_phase_role, "broader instruction phase"); assert.equal(cases[0].declared_role, "question");
    f.context.native.course_context.lesson_plan.phases.reverse(); f.save();
    assert.throws(() => prepareNativeIntake(f.input, path.join(f.root, "bad-order")), /exposure order/);
  } finally { f.dispose(); }
});

function instructionalPlan(f) {
  return { version: "instructional-plan/0.1", id: "NATIVE-PLAN", lesson: { purpose: "practice", scope: "static-design", objective: "Explain the passage action.", goal_refs: ["K1"] },
    goal_authority: [{ goal_ref: "K1", kind: "packet-proposed", source_refs: ["S1"], note: "Toy author proposal, not course approval." }],
    events: [{ id: "TEACH", order: 1, before_item_id: "N1", kind: "teaching", status: "declared", content: "Read the source and find the action.", source_refs: ["S1"], target_refs: ["K1"], revealed_target_refs: ["K1"], provenance: "toy public instruction" },
      { id: "LATER", order: 2, before_item_id: "END", kind: "teaching", status: "declared", content: "FUTURE_ONLY_TEACHING", source_refs: ["FUTURE"], target_refs: ["K1"], revealed_target_refs: [], provenance: "toy future instruction" }],
    items: f.set.items.map(item => ({ item_id: item.id, purpose: "practice", scope: "static-design", measurement_intent: "DESIGN_ONLY_MEASUREMENT_INTENT", goal_refs: ["K1"], prior_event_refs: ["TEACH"], prepares_for_item_ids: [],
      expected_evidence: [{ id: `EXPECTED-${item.order}`, goal_refs: ["K1"], claim: "DESIGN_ONLY_EVIDENCE_CLAIM", source_refs: ["S1"] }],
      support: { mode: "source-visible", event_refs: ["TEACH"], source_refs: ["S1"], answer_exposure: "allowed" } })),
    sequence: { goal_coverage: [{ goal_ref: "K1", item_ids: f.set.items.map(item => item.id) }], support_transitions: [] } };
}
test("native preparation hashes full instructional design separately from a context-aware key-blind packet", () => {
  const f = fixture(); try {
    f.context.native.course_context.instructional_plan = instructionalPlan(f); f.save();
    const out = path.join(f.root, "review"), receipt = prepareNativeIntake(f.input, out);
    const review = JSON.parse(fs.readFileSync(path.join(out, "review-packet.json"))), serialized = JSON.stringify(review);
    assert.equal(review.items[0].assessment_purpose.purpose, "practice");
    assert.equal(review.items[0].learner_context.ordered_teaching[0].content, "Read the source and find the action.");
    assert.equal(review.items[2].learner_context.prior_tasks[0].order, 1);
    assert.equal(Object.hasOwn(review.items[2].learner_context.prior_tasks[0], "item_id"), false);
    assert.equal(review.items[0].visible_sources.length, 0);
    for (const hidden of ["FUTURE_ONLY_TEACHING", "DESIGN_ONLY_MEASUREMENT_INTENT", "DESIGN_ONLY_EVIDENCE_CLAIM", "hidden_new_solution", '"key"']) assert.equal(serialized.includes(hidden), false);
    const resolved = JSON.parse(fs.readFileSync(path.join(out, "instructional-context.json")));
    assert.equal(resolved.items[0].design_context.expected_evidence[0].claim, "DESIGN_ONLY_EVIDENCE_CLAIM");
    assert.equal(resolved.whole_lesson.instructional_plan.events[1].content, "FUTURE_ONLY_TEACHING");
    assert.equal(typeof receipt.files["instructional-context.json"], "string"); assert.equal(typeof receipt.files["sequence-review-packet.json"], "string");
    assert.equal(receipt.sequence_review.status, "prepared; no semantic judgment run"); assert.equal(receipt.qualified, false); assert.equal(receipt.model_calls, 0);
    const metadata = JSON.parse(fs.readFileSync(path.join(out, "criterion-sources.json")));
    assert(metadata.annotations.every(row => row.applicability.reason !== "assessment_purpose_missing"));
  } finally { f.dispose(); }
});
test("native returned conditional context stays held and author-key evidence is rejected in the saved receipt", () => {
  const f = fixture(); try {
    const native = f.context.native, plan = instructionalPlan(f);
    Object.assign(plan.events[1], { before_item_id: "N2", kind: "feedback", status: "conditional", content: "CONDITIONAL_NATIVE_CORRECTION", source_refs: ["S1"] });
    native.course_context.instructional_plan = plan;
    native.sequence_blueprint = f.set.items.map(item => ({ id: item.id }));
    const payload = { course_context: native.course_context, student_context: null, sequence_blueprint: native.sequence_blueprint, source_provenance: null };
    const sorted = value => Array.isArray(value) ? value.map(sorted) : value !== null && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
    f.set.sequence_plan = { plan_id: plan.id, context_sha256: crypto.createHash("sha256").update(JSON.stringify(sorted(payload))).digest("hex"),
      lesson: structuredClone(plan.lesson), goal_authority: structuredClone(plan.goal_authority),
      items: plan.items.map(item => ({ item_id: item.item_id, purpose: item.purpose, scope: item.scope, measurement_intent: item.measurement_intent,
        support: structuredClone(item.support), context_event_refs: item.item_id === "N2" ? ["TEACH", "LATER"] : ["TEACH"],
        expected_evidence: item.expected_evidence.map(row => ({ expectation_id: row.id, claim: row.claim, field_refs: ["/view/prompt"] })) })),
      goal_coverage: structuredClone(plan.sequence.goal_coverage), support_transitions: [] };
    native.sequence_plan = structuredClone(f.set.sequence_plan); f.save();
    const out = path.join(f.root, "conditional"), receipt = prepareNativeIntake(f.input, out);
    assert.equal(receipt.returned_sequence.status, "checked_fields_only"); assert.equal(receipt.code_failures, 0);
    assert(receipt.context_holds.find(row => row.item_id === "N2").reasons.includes("conditional_exposure_unresolved"));
    assert(receipt.sequence_review.holds.some(row => row.item_id === "N2" && row.reason === "conditional_exposure_unresolved"));
    const review = JSON.parse(fs.readFileSync(path.join(out, "review-packet.json")));
    assert.equal(JSON.stringify(review).includes("CONDITIONAL_NATIVE_CORRECTION"), false);
    f.set.sequence_plan.items[0].expected_evidence[0].field_refs = ["/view/key/0"];
    native.sequence_plan = structuredClone(f.set.sequence_plan); f.save();
    const bad = prepareNativeIntake(f.input, path.join(f.root, "key-evidence"));
    assert.equal(bad.returned_sequence.status, "needs_revision"); assert.equal(bad.code_failures, 1);
    assert(bad.context_holds.every(row => row.reasons.includes("returned_sequence_contract_fault")));
    assert.equal(bad.qualified, false); assert.equal(bad.model_calls, 0);
  } finally { f.dispose(); }
});
test("legacy native preparations retain unknown purposes and invalid supplied plans never create output", () => {
  const f = fixture(); try {
    const out = path.join(f.root, "legacy"), receipt = prepareNativeIntake(f.input, out);
    assert.equal(receipt.context_holds.length, 3);
    const review = JSON.parse(fs.readFileSync(path.join(out, "review-packet.json")));
    assert.equal(review.items[0].assessment_purpose.state, "undetermined");
    f.context.native.course_context.instructional_plan = instructionalPlan(f);
    f.context.native.course_context.instructional_plan.items[0].prior_event_refs = ["LATER"]; f.save();
    const bad = path.join(f.root, "invalid"); assert.throws(() => prepareNativeIntake(f.input, bad), error => error.code === "future_event_as_prior"); assert.equal(fs.existsSync(bad), false);
  } finally { f.dispose(); }
});

test("native replay cannot detach its sequence packet or receipt from prepared evidence", () => {
  const f = fixture(); try {
    const out = path.join(f.root, "pinned"), receipt = prepareNativeIntake(f.input, out);
    assert.equal(verifyNativePreparation(out, receipt).files_verified, Object.keys(receipt.files).length);
    const assessmentFile = path.join(out, "assessment-review.json"), assessmentOriginal = fs.readFileSync(assessmentFile);
    fs.writeFileSync(assessmentFile, JSON.stringify({ qualified: true }));
    assert.throws(() => verifyNativePreparation(out, receipt), /prepared artifact hash differs/);
    fs.writeFileSync(assessmentFile, assessmentOriginal);
    const sequenceFile = path.join(out, "sequence-review-packet.json"), original = fs.readFileSync(sequenceFile);
    const altered = JSON.parse(original); altered.state.author_status = "Altered after preparation.";
    fs.writeFileSync(sequenceFile, JSON.stringify(altered));
    assert.throws(() => verifyNativePreparation(out, receipt), /prepared artifact hash differs/);
    fs.writeFileSync(sequenceFile, original);
    const receiptFile = path.join(out, "receipt.json"), changed = JSON.parse(fs.readFileSync(receiptFile));
    changed.model_calls = 1; fs.writeFileSync(receiptFile, JSON.stringify(changed));
    assert.throws(() => verifyNativePreparation(out, receipt), /prepared receipt hash differs/);
  } finally { f.dispose(); }
});
