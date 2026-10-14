import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareNativeIntake, nativeFieldChecks, runNativeIntakeCli } from "../src/native-intake.mjs";

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
    assert.throws(() => runNativeIntakeCli({ root: f.root, argv: ["--native-package", f.input, "--judge", "jev"] }), /unsupported/);
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
